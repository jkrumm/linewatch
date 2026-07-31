.PHONY: help env up down rebuild logs collector-setup collector-teardown collector-logs check \
	marker db-counts db-shell db-backup db-restore db-import
.DEFAULT_GOAL := help

REPO_DIR      := $(shell pwd)
LAUNCHAGENTS  := $(HOME)/Library/LaunchAgents
TOKEN_DIR     := $(HOME)/.config/linewatch
TOKEN_FILE    := $(TOKEN_DIR)/token
# The router UI password, for the read-only 5-minute poller. Same location and
# same reasoning as the bearer token: a plain host file, deliberately NOT the
# machine's secrets cache, because monitoring must keep working with an unseeded
# cache. Unlike the token it cannot be generated — absent is a normal state.
ROUTER_PW_FILE := $(TOKEN_DIR)/router-password
LOG_DIR       := $(HOME)/Library/Logs
COLLECTOR_LOG := $(LOG_DIR)/linewatch-collector.log
PLIST_LABEL   := com.jkrumm.linewatch-collector

# Storage: the database lives in a named Docker volume that the host cannot open
# (docs/storage.md). Every db-* target below therefore works through a container.
LIVE_VOLUME   := linewatch-data
# Overridable on the command line so the destructive targets can be *rehearsed*
# against a scratch copy instead of the record:
#
#   make db-backup  VOLUME=linewatch-drill                  # copy of the drill volume
#   make db-restore VOLUME=linewatch-drill FROM=<snap>.db
#
# A non-live VOLUME never stops or starts the service, and mounts itself over
# /app/data in the throwaway container. "Rehearsed once by hand" is how a restore
# path rots; this makes the drill repeatable and harmless.
VOLUME        := $(LIVE_VOLUME)
IS_LIVE       := $(if $(filter $(VOLUME),$(LIVE_VOLUME)),1,)
DB            := /app/data/linewatch.db
# Compose derives its project name from the directory. `up` asserts that the
# fixed `container_name: linewatch` belongs to *this* project before starting.
COMPOSE_PROJECT := $(notdir $(REPO_DIR))
BACKUP_DIR    := $(REPO_DIR)/backups
HOST_DATA_DIR := $(REPO_DIR)/data
MARKER        := $(HOST_DATA_DIR)/MOVED-TO-DOCKER-VOLUME
HOST_OWNER    := $(shell id -u):$(shell id -g)

REQUIRE_VOLUME = @docker volume inspect $(VOLUME) >/dev/null 2>&1 || { echo "  ✗ Docker volume '$(VOLUME)' does not exist — run 'make up' first."; exit 1; }

# Stopping and starting the service is only correct for the live volume. A drill
# against a scratch volume must leave the running service alone.
SERVICE_STOP  = $(if $(IS_LIVE),docker compose down,echo "  · drill on volume $(VOLUME) — leaving the running service alone")
# Deliberately `$(SUBMAKE)`, not the literal `$(MAKE)`: GNU make runs any recipe
# line containing that string even under `-n`, and here it shares a line with the
# restore itself. `make -n db-restore` has to stay a dry run.
SUBMAKE       := $(MAKE)
SERVICE_START = $(if $(IS_LIVE),$(SUBMAKE) up,echo "  · drill on volume $(VOLUME) — service untouched")

# A throwaway container from this project's own image, with the volume and
# ./backups mounted. Safe to run while `linewatch` is up: both sit inside the
# same Docker VM kernel, where SQLite's fcntl locks genuinely work —
# host-vs-container was the broken pairing, container-vs-container never was.
# Also works while the service is down, which is what `db-restore` needs.
# Runs as root because it has to write both the app-owned volume and the
# host-owned ./backups bind mount; it publishes no ports and mounts nothing else.
# The explicit -v overrides the service's own /app/data mount, which is what
# makes VOLUME=<scratch> a real drill rather than a differently-labelled way to
# hit the record.
DB_TOOL = docker compose run --rm --no-deps -T --user 0:0 -v "$(VOLUME):/app/data" -v "$(BACKUP_DIR):/backups" --entrypoint sh linewatch -c

# Read-only sibling of DB_TOOL: no ./backups mount, and deliberately *not* root,
# because a root-owned `-shm` left behind by a read would lock the app (uid 999)
# out of its own database.
DB_READ = docker compose run --rm --no-deps -T -v "$(VOLUME):/app/data" --entrypoint sh linewatch -c

REQUIRE_UP = @docker ps --format '{{.Names}}' | grep -qx linewatch || { echo "  ✗ linewatch is down — the database lives in the $(VOLUME) Docker volume and only a container can open it. Run 'make up' first."; exit 1; }

help: ## Show targets
	@awk 'BEGIN{FS=":.*##"; printf "Targets:\n"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

env: ## Ensure the bearer token, the router password (if any) and .env exist (idempotent; `up` and `db-import` do this for you)
	@mkdir -p "$(TOKEN_DIR)"
	@if [ ! -f "$(TOKEN_FILE)" ]; then \
		openssl rand -hex 32 > "$(TOKEN_FILE)"; \
		chmod 600 "$(TOKEN_FILE)"; \
		echo "  ✓ generated bearer token at $(TOKEN_FILE)"; \
	fi
	@# Both credentials travel the same way: host file -> .env -> compose
	@# `env_file`. Nothing is bind-mounted into the image, because the container's
	@# `app` user has --home-dir /app, so the poller's own
	@# ~/.config/linewatch/router-password fallback resolves to /app/.config there
	@# and can never be the deployment path. The router password is optional: with
	@# no file the poller stays disabled and the API serves exactly as before.
	@#
	@# LINEWATCH_UID/GID are stripped and not re-added: they existed for the old
	@# ./data bind mount's ownership, which the named volume replaced.
	@TOKEN=$$(cat "$(TOKEN_FILE)"); \
	if [ -f .env ]; then grep -vE '^LINEWATCH_(TOKEN|ROUTER_PASSWORD|UID|GID)=' .env > .env.tmp || true; else : > .env.tmp; fi; \
	chmod 600 .env.tmp; \
	printf 'LINEWATCH_TOKEN=%s\n' "$$TOKEN" >> .env.tmp; \
	if [ -f "$(ROUTER_PW_FILE)" ]; then \
		: "first line only, CR stripped: compose reads .env line-by-line, so a"; \
		: "trailing newline or a CRLF file would otherwise corrupt the value"; \
		ROUTER_PW=$$(head -n 1 "$(ROUTER_PW_FILE)" | tr -d '\r'); \
		if [ -z "$$ROUTER_PW" ]; then \
			echo "  ! $(ROUTER_PW_FILE) is empty — router poller stays disabled"; \
		else \
			printf 'LINEWATCH_ROUTER_PASSWORD=%s\n' "$$ROUTER_PW" >> .env.tmp; \
			echo "  ✓ router password read from $(ROUTER_PW_FILE) — poller enabled"; \
		fi; \
	else \
		echo "  · no $(ROUTER_PW_FILE) — router poller stays disabled (GET /api/router says so). To enable: write the router UI password there, chmod 600, re-run 'make up'."; \
	fi; \
	mv .env.tmp .env; \
	chmod 600 .env

up: env marker ## Ensure the token, .env and data volume exist, build, and (re)start the stack. Safe to re-run any time.
	@# `container_name: linewatch` is a fixed name, so a container started by a
	@# *different* compose project — a sibling worktree, a renamed directory, an
	@# interrupted run — holds that name without being tracked here. Compose then
	@# fails with "container name is already in use" and the orphan keeps serving
	@# whatever image it was built from, which is how a rebuilt bearer-auth fix went
	@# undeployed for half an hour. Assert the name is ours; do not ship a separate
	@# "more thorough" target, which would only offer a way to distrust `up`.
	@if docker inspect linewatch >/dev/null 2>&1; then \
		OWNER=$$(docker inspect linewatch --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null); \
		if [ "$$OWNER" != "$(COMPOSE_PROJECT)" ]; then \
			echo "  ! container 'linewatch' belongs to compose project '$${OWNER:-<none>}', not '$(COMPOSE_PROJECT)' — removing it"; \
			docker rm -f linewatch >/dev/null; \
		fi; \
	fi
	@# The volume is declared `external:` so `docker compose down -v` can never
	@# delete the uptime history. That means Compose will not create it either —
	@# so ensure it here rather than failing a fresh clone with a bare
	@# "external volume not found".
	@docker volume inspect $(VOLUME) >/dev/null 2>&1 || { \
		docker volume create $(VOLUME) >/dev/null && \
		echo "  ✓ created empty volume $(VOLUME) (run 'make db-import' if you have a pre-volume ./data/linewatch.db)"; }
	docker compose build
	@# Docker creates a fresh named volume root:root 0755 (measured), and the
	@# image runs as the non-root `app` user, so without this the very first boot
	@# fails with EACCES on the database. Asserted on every `up` rather than only
	@# at creation: the volume can also be recreated by hand.
	@docker compose run --rm --no-deps --user 0:0 --entrypoint sh linewatch -c 'chown -R app:app /app/data' >/dev/null
	docker compose up -d --force-recreate --remove-orphans
	@printf "  waiting for /health… "
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if curl -fsS http://127.0.0.1:7731/health >/dev/null 2>&1; then echo "ok"; exit 0; fi; \
		sleep 2; \
	done; \
	echo "TIMED OUT — check: make logs"; exit 1
	@echo "✓ linewatch up — http://127.0.0.1:7731"

down: ## Stop the stack
	docker compose down

logs: ## Tail container logs
	docker compose logs -f

rebuild: ## Refresh pinned base images (docker compose build --pull), then same as `up`
	docker compose build --pull
	$(MAKE) up

# ── Database (container-owned — see docs/storage.md) ─────────────────────────

# A note for whoever finds the vestigial host ./data directory. It is no longer
# what *arms* src/db/client.ts — that guard triggers on the path itself, because
# ./data is where docker-compose.yml mounts the volume, so it survives a fresh
# clone. This file used to be the only trigger, was gitignored, and was written
# by `db-import` alone — which refuses to run once the volume holds rows. A
# re-clone therefore disarmed the guard with no supported way to re-arm it.
marker:
	@mkdir -p "$(HOST_DATA_DIR)"
	@{ \
		echo "linewatch's database lives in the '$(VOLUME)' Docker volume, mounted over this"; \
		echo "directory inside the container. Nothing here is the record."; \
		echo "The host must never open it: SQLite's fcntl locks do not cross the"; \
		echo "macOS-host / Docker-VM boundary, and that corrupted this database on"; \
		echo "2026-07-30. src/db/client.ts refuses a host-side open of this directory."; \
		echo "Use: make db-counts | make db-shell | make db-backup — or read the API."; \
		echo "See docs/storage.md."; \
	} > "$(MARKER)"

# The scriptable sibling of db-shell. db-shell execs an interactive prompt, so it
# cannot answer "how many rows are in there" from a script or an agent — and the
# host may not open the file itself.
db-counts: ## Row counts per table in the container-owned database (read-only, scriptable)
	$(REQUIRE_VOLUME)
	@# A throwaway container rather than `exec`, so this also answers while the
	@# service is stopped — which is exactly when a restore wants to be checked.
	@$(DB_READ) 'if [ ! -f $(DB) ]; then echo "  · no database in volume $(VOLUME) yet"; exit 0; fi; \
		for t in $$(sqlite3 -readonly $(DB) ".tables"); do printf "  %-24s %s\n" "$$t" "$$(sqlite3 -readonly $(DB) "select count(*) from \"$$t\"")"; done; \
		printf "  %-24s %s\n" "probe_sample max ts" "$$(sqlite3 -readonly $(DB) "select coalesce(max(ts),0) from probe_sample")"'

db-shell: ## Interactive sqlite3 prompt on the container-owned database
	$(REQUIRE_UP)
	@echo "  · $(DB) inside the linewatch container — .quit to leave"
	@docker compose exec linewatch sqlite3 $(DB)

# Integrity-gated on both sides: a snapshot of a corrupt database is worse than
# no snapshot, and a snapshot that arrives corrupt is a backup you only discover
# is useless during a restore. `.backup` is SQLite's online backup API, so it
# captures the WAL too — a plain `cp` of the main file silently omits everything
# written since the last checkpoint.
db-backup: ## Verified snapshot of the database into ./backups (gitignored)
	$(REQUIRE_VOLUME)
	@mkdir -p "$(BACKUP_DIR)"
	@$(DB_TOOL) 'set -e; \
		[ "$$(sqlite3 -readonly $(DB) "pragma integrity_check")" = ok ] || { echo "  ✗ source fails integrity_check — refusing to snapshot a corrupt database"; exit 1; }; \
		OUT="/backups/linewatch-$$(date -u +%Y%m%dT%H%M%SZ).db"; \
		sqlite3 $(DB) ".backup $$OUT"; \
		[ "$$(sqlite3 -readonly "$$OUT" "pragma integrity_check")" = ok ] || { echo "  ✗ snapshot fails integrity_check"; rm -f "$$OUT"; exit 1; }; \
		ROWS=$$(sqlite3 -readonly "$$OUT" "select count(*) from probe_sample"); \
		SIZE=$$(du -h "$$OUT" | cut -f1); \
		chown $(shell id -u):$(shell id -g) "$$OUT"; \
		: "the snapshot inherits WAL mode, and a -readonly open cannot delete its"; \
		: "own sidecars on close — drop them so the snapshot is a single file"; \
		rm -f "$$OUT"-wal "$$OUT"-shm; \
		echo "  ✓ backups/$$(basename $$OUT) — $$ROWS probe_sample rows, $$SIZE"'

intervention: ## Record a manual action on the line: make intervention ACTION="swapped the LAN cable" [NOTE="..."]
	@# Attribution is the whole point: without a recorded action, a recovery two
	@# minutes after a cable swap is indistinguishable from one that would have
	@# happened anyway, and the record silently credits the ISP for a fix that was
	@# a human with a plug. Wrapped in a target because the route is bearer-gated
	@# and nobody should be pasting the token into a shell to answer that.
	@if [ -z "$(ACTION)" ]; then \
		echo 'Usage: make intervention ACTION="what you did" [NOTE="why, or what you expect of it"]'; \
		exit 1; \
	fi
	@test -f "$(TOKEN_FILE)" || { echo "  ✗ no bearer token at $(TOKEN_FILE) — run: make collector-setup"; exit 1; }
	@# Body built by python's json module, not by string-concatenating into a
	@# template: an apostrophe in the description is entirely likely ("swapped the
	@# router's cable") and hand-quoted JSON breaks on it.
	@#
	@# Known limit, measured: an embedded DOUBLE quote is swallowed by the
	@# make-then-shell expansion before python ever sees it, so ACTION="say \"hi\""
	@# records `say hi`. Apostrophes survive. Not worth a third quoting layer to
	@# fix — POST /api/interventions directly if a description really needs one.
	@BODY=$$(ACTION="$(ACTION)" NOTE="$(NOTE)" python3 -c 'import json,os; a=os.environ["ACTION"]; n=os.environ.get("NOTE",""); print(json.dumps({"action": a, **({"note": n} if n else {})}))'); \
	curl -fsS -X POST http://127.0.0.1:7731/api/interventions \
		-H "Authorization: Bearer $$(cat $(TOKEN_FILE))" \
		-H 'content-type: application/json' \
		-d "$$BODY" \
		&& echo "  ✓ recorded — it will appear on the timeline and in GET /api/events"

db-vacuum: ## Rebuild the database, reclaiming freed pages (run after a migration that DROPs a column)
	$(REQUIRE_VOLUME)
	@# Why this exists rather than trusting the migration: SQLite's ALTER TABLE
	@# DROP COLUMN rewrites the live rows but returns the old pages to the
	@# freelist WITHOUT zeroing them, so a dropped column's contents stay
	@# recoverable from the file — and from the WAL — until the database is
	@# rebuilt. Migration 0005 drops router_host.host_name precisely because it
	@# held MAC-derived vendor hostnames, and "the column and its contents are
	@# gone" is not true of the storage until this has run.
	@#
	@# Integrity-gated on both sides for the same reason db-backup is: VACUUM
	@# rewrites the whole file, and doing that to an already-corrupt database
	@# turns a recoverable problem into an unrecoverable one.
	$(SERVICE_STOP)
	@STATUS=0; \
	$(DB_TOOL) 'set -e; \
		[ "$$(sqlite3 -readonly $(DB) "pragma integrity_check")" = ok ] || { echo "  ✗ fails integrity_check — refusing to vacuum a corrupt database"; exit 1; }; \
		BEFORE=$$(du -k $(DB) | cut -f1); \
		: "checkpoint first: VACUUM does not rewrite pages still sitting in the"; \
		: "WAL, and the dropped values can be in there too"; \
		sqlite3 $(DB) "pragma wal_checkpoint(TRUNCATE)" >/dev/null; \
		sqlite3 $(DB) "vacuum"; \
		[ "$$(sqlite3 -readonly $(DB) "pragma integrity_check")" = ok ] || { echo "  ✗ fails integrity_check AFTER vacuum — restore from ./backups"; exit 1; }; \
		AFTER=$$(du -k $(DB) | cut -f1); \
		echo "  ✓ vacuumed — $${BEFORE}K → $${AFTER}K"' || STATUS=$$?; \
	$(SERVICE_START); \
	exit $$STATUS

db-restore: ## Restore the database from a snapshot in ./backups: make db-restore FROM=<file>.db [FORCE=1]
	@if [ -z "$(FROM)" ]; then \
		echo 'Usage: make db-restore FROM=<file>.db   (a filename inside ./backups)'; \
		ls -1t "$(BACKUP_DIR)"/*.db 2>/dev/null | head -5 | sed 's|.*/|  candidate: |'; \
		exit 1; \
	fi
	@test -f "$(BACKUP_DIR)/$(FROM)" || { echo "  ✗ no such snapshot: backups/$(FROM)"; exit 1; }
	$(REQUIRE_VOLUME)
	@# Stop the API first. Restoring under a live writer would either lose every
	@# write made after the copy or interleave them with it.
	$(SERVICE_STOP)
	@# Whatever the restore decides, the service has to come back: a refusal or a
	@# failed assert that leaves linewatch stopped turns a safety check into an
	@# outage, and the collector's spool only covers a window that ends. So the
	@# exit status is carried past the restart rather than aborting the recipe.
	@STATUS=0; \
	$(DB_TOOL) 'set -e; \
		SRC="/backups/$(FROM)"; \
		: "a -readonly open of a WAL database recreates its sidecars; leaving them"; \
		: "next to the snapshot makes the *next* restore count main+WAL and copy"; \
		: "main only. Clean them on every exit, refusals included."; \
		trap "rm -f $${SRC}-wal $${SRC}-shm" EXIT; \
		STAMP=$$(date -u +%Y%m%dT%H%M%SZ); \
		ARCHIVE="/backups/linewatch-pre-restore-$$STAMP.db"; \
		[ "$$(sqlite3 -readonly "$$SRC" "pragma integrity_check")" = ok ] || { echo "  ✗ snapshot fails integrity_check — refusing to restore"; exit 1; }; \
		WANT=$$(sqlite3 -readonly "$$SRC" "select count(*) from probe_sample"); \
		SNAP_MAX=$$(sqlite3 -readonly "$$SRC" "select coalesce(max(ts),0) from probe_sample"); \
		if [ -f $(DB) ]; then \
			if LIVE_MAX=$$(sqlite3 -readonly $(DB) "select coalesce(max(ts),0) from probe_sample" 2>/dev/null); then \
				NEWER=$$(sqlite3 -readonly $(DB) "select count(*) from probe_sample where ts > $$SNAP_MAX"); \
				NEWER_ST=$$(sqlite3 -readonly $(DB) "select count(*) from speed_test where ts > $$SNAP_MAX"); \
				if [ "$$NEWER" -gt 0 ] || [ "$$NEWER_ST" -gt 0 ]; then \
					FIRST=$$(sqlite3 -readonly $(DB) "select min(datetime(ts/1000,'\''unixepoch'\'')) from probe_sample where ts > $$SNAP_MAX"); \
					LAST=$$(sqlite3 -readonly $(DB) "select max(datetime(ts/1000,'\''unixepoch'\'')) from probe_sample where ts > $$SNAP_MAX"); \
					echo "  ! the live database holds measurements this snapshot does not:"; \
					echo "      probe_sample rows newer than the snapshot: $$NEWER"; \
					echo "      speed_test  rows newer than the snapshot: $$NEWER_ST"; \
					echo "      window: $${FIRST:-n/a} .. $${LAST:-n/a} UTC"; \
					echo "      snapshot max ts $$SNAP_MAX  <  live max ts $$LIVE_MAX"; \
					echo "    Those cycles were accepted with a 2xx, so the collector already dropped"; \
					echo "    them from its spool: a restore discards them for good, it does not"; \
					echo "    replay them. That is how 2026-07-30 13:18:47Z was lost."; \
					[ -n "$(FORCE)" ] || { echo "  ✗ refusing. Snapshot the current state first (make db-backup), or re-run with FORCE=1 to accept the loss."; exit 1; }; \
					echo "  ! FORCE=1 — discarding them deliberately"; \
				fi; \
				: "archive with the online backup API, not mv: mv takes the main file"; \
				: "and leaves the WAL behind, which is the thing docs/storage.md says"; \
				: "is not a backup."; \
				sqlite3 $(DB) ".backup $$ARCHIVE"; \
				[ "$$(sqlite3 -readonly "$$ARCHIVE" "pragma integrity_check")" = ok ] || { echo "  ✗ pre-restore archive fails integrity_check — refusing to overwrite the live database"; rm -f "$$ARCHIVE"-wal "$$ARCHIVE"-shm; exit 1; }; \
				ARCH_ROWS=$$(sqlite3 -readonly "$$ARCHIVE" "select count(*) from probe_sample"); \
				ARCH_MAX=$$(sqlite3 -readonly "$$ARCHIVE" "select coalesce(max(ts),0) from probe_sample"); \
				rm -f "$$ARCHIVE"-wal "$$ARCHIVE"-shm; \
				chown $(HOST_OWNER) "$$ARCHIVE"; \
				KEPT="backups/$$(basename $$ARCHIVE)"; \
				echo "  ✓ archived the live database first: $$KEPT — $$ARCH_ROWS probe_sample rows, max ts $$ARCH_MAX (WAL included; restorable with FROM=)"; \
			else \
				UNREAD="/backups/linewatch-unreadable-$$STAMP"; \
				mkdir -p "$$UNREAD"; \
				cp $(DB) "$$UNREAD"/; \
				for s in -wal -shm; do if [ -f $(DB)$$s ]; then cp $(DB)$$s "$$UNREAD"/; fi; done; \
				chown -R $(HOST_OWNER) "$$UNREAD"; \
				KEPT="backups/$$(basename $$UNREAD)/"; \
				echo "  ! the live database cannot be read (probe_sample query failed) — that is"; \
				echo "    corruption, not an empty database. Copied it, WAL and all, to"; \
				echo "    backups/$$(basename $$UNREAD)."; \
				echo "    Salvage before accepting the loss:  sqlite3 <copy> .recover"; \
				echo "    (that is what recovered 945 of 1408 rows on 2026-07-30)"; \
				[ -n "$(FORCE)" ] || { echo "  ✗ refusing to replace an unreadable database — re-run with FORCE=1 once you have recovered what you can."; exit 1; }; \
			fi; \
			rm -f $(DB) $(DB)-wal $(DB)-shm; \
		fi; \
		: "restore with .backup for the same reason db-import does: the snapshot"; \
		: "may carry a WAL, and cp would copy the main file without it."; \
		sqlite3 "$$SRC" ".backup $(DB)"; \
		chown -R app:app /app/data; \
		[ "$$(sqlite3 -readonly $(DB) "pragma integrity_check")" = ok ] || { echo "  ✗ restored database fails integrity_check"; exit 1; }; \
		GOT=$$(sqlite3 -readonly $(DB) "select count(*) from probe_sample"); \
		[ "$$GOT" = "$$WANT" ] || { echo "  ✗ row count mismatch after restore: $$WANT -> $$GOT"; exit 1; }; \
		chown -R app:app /app/data; \
		echo "  ✓ the database is now exactly backups/$(FROM): $$GOT probe_sample rows, max ts $$SNAP_MAX."; \
		: "deliberately not claiming more than that. The old message — restored N"; \
		: "rows, previous copy kept — read as if nothing was lost, on a target that"; \
		: "had just dropped an accepted measurement."; \
		if [ -n "$$KEPT" ]; then \
			echo "    Whatever the database held after that snapshot is no longer live. It"; \
			echo "    survives only in $$KEPT."; \
		else \
			echo "    The volume held no database before this, so nothing was replaced."; \
		fi' || STATUS=$$?; \
	$(SERVICE_START); \
	exit $$STATUS

# One-time, and idempotent enough to re-run: it refuses once the volume holds
# real rows. Imports with `.backup` rather than `cp` because the source still has
# a live WAL — the whole reason the old bind mount was unsafe.
db-import: env ## ONE-TIME: move a pre-volume ./data/linewatch.db (or FROM=<file>.db in ./backups) into the linewatch-data volume
	@SRC="$(if $(FROM),$(BACKUP_DIR)/$(FROM),$(HOST_DATA_DIR)/linewatch.db)"; \
	test -f "$$SRC" || { echo "  ✗ nothing to import at $$SRC"; exit 1; }
	@mkdir -p "$(BACKUP_DIR)"
	@docker volume inspect $(VOLUME) >/dev/null 2>&1 || docker volume create $(VOLUME) >/dev/null
	@# The running container holds ./data open through the bind mount this change
	@# removes. Two processes on one WAL database is the bug — stop it first.
	$(SERVICE_STOP)
	@# The import runs sqlite3 from the image, so the image has to be current —
	@# `docker compose run` never builds on its own.
	docker compose build
	@STATUS=0; \
	docker compose run --rm --no-deps -T --user 0:0 \
		-v "$(VOLUME):/app/data" -v "$(BACKUP_DIR):/backups" -v "$(HOST_DATA_DIR):/olddata" \
		--entrypoint sh linewatch -c 'set -e; \
		SRC="$(if $(FROM),/backups/$(FROM),/olddata/linewatch.db)"; \
		trap "rm -f $${SRC}-wal $${SRC}-shm" EXIT; \
		[ "$$(sqlite3 -readonly "$$SRC" "pragma integrity_check")" = ok ] || { echo "  ✗ source fails integrity_check — refusing to import a corrupt database"; exit 1; }; \
		WANT=$$(sqlite3 -readonly "$$SRC" "select count(*) from probe_sample"); \
		if [ -f $(DB) ]; then \
			: "an unreadable table is corruption, not an empty database. Coalescing"; \
			: "the failure to 0 (the old ...-or-echo-0 fallback) put a corrupt file on the"; \
			: "safe-to-delete branch — and .recover on exactly such a file is what"; \
			: "salvaged 945 rows on 2026-07-30. Separate query-failed from returned-0."; \
			if HAVE=$$(sqlite3 -readonly $(DB) "select count(*) from probe_sample" 2>/dev/null); then \
				[ "$$HAVE" = 0 ] || { echo "  ✗ the volume already holds $$HAVE probe_sample rows — refusing to overwrite. Use make db-restore."; exit 1; }; \
			else \
				UNREAD="/backups/linewatch-unreadable-$$(date -u +%Y%m%dT%H%M%SZ)"; \
				mkdir -p "$$UNREAD"; \
				cp $(DB) "$$UNREAD"/; \
				for s in -wal -shm; do if [ -f $(DB)$$s ]; then cp $(DB)$$s "$$UNREAD"/; fi; done; \
				chown -R $(HOST_OWNER) "$$UNREAD"; \
				[ -s "$$UNREAD/$$(basename $(DB))" ] || { echo "  ✗ could not copy the unreadable database aside — refusing to touch it"; exit 1; }; \
				echo "  ! the volume holds a database whose probe_sample table cannot be read."; \
				echo "    That is corruption, not an empty volume. Copied it, WAL and all, to"; \
				echo "    backups/$$(basename $$UNREAD)."; \
				echo "    Salvage before overwriting:  sqlite3 <copy> .recover"; \
				echo "    (that is what recovered 945 of 1408 rows on 2026-07-30)"; \
				[ -n "$(FORCE)" ] || { echo "  ✗ refusing to delete an unreadable database — re-run with FORCE=1 once you have recovered what you can."; exit 1; }; \
				echo "  ! FORCE=1 — importing over it; the copy above is now the only source"; \
			fi; \
			rm -f $(DB) $(DB)-wal $(DB)-shm; \
		fi; \
		sqlite3 "$$SRC" ".backup $(DB)"; \
		chown -R app:app /app/data; \
		[ "$$(sqlite3 -readonly $(DB) "pragma integrity_check")" = ok ] || { echo "  ✗ imported copy fails integrity_check"; exit 1; }; \
		GOT=$$(sqlite3 -readonly $(DB) "select count(*) from probe_sample"); \
		[ "$$GOT" = "$$WANT" ] || { echo "  ✗ row count mismatch: $$WANT -> $$GOT"; exit 1; }; \
		chown -R app:app /app/data; \
		echo "  ✓ imported $$GOT probe_sample rows into the $(VOLUME) volume"' || STATUS=$$?; \
	if [ $$STATUS -ne 0 ]; then $(SERVICE_START); exit $$STATUS; fi
	@$(MAKE) --no-print-directory marker
	@# Move the pre-volume files out of ./data so nothing can mistake them for
	@# live data, and so a stray host-side tool has nothing to find.
	@ARCHIVE="$(BACKUP_DIR)/data.pre-volume-$$(date -u +%Y%m%dT%H%M%SZ)"; \
	if ls "$(HOST_DATA_DIR)"/linewatch.db* >/dev/null 2>&1; then \
		mkdir -p "$$ARCHIVE"; \
		mv "$(HOST_DATA_DIR)"/linewatch.db* "$$ARCHIVE"/; \
		echo "  ✓ pre-volume files archived to $${ARCHIVE#$(REPO_DIR)/}"; \
	fi
	$(SERVICE_START)

collector-setup: ## Generate the bearer token (if absent), render + load the native ping collector's LaunchAgent
	@mkdir -p "$(TOKEN_DIR)"
	@if [ ! -f "$(TOKEN_FILE)" ]; then \
		openssl rand -hex 32 > "$(TOKEN_FILE)"; \
		chmod 600 "$(TOKEN_FILE)"; \
		echo "  ✓ generated bearer token at $(TOKEN_FILE)"; \
	else \
		echo "  · token already exists at $(TOKEN_FILE)"; \
	fi
	@command -v bun >/dev/null 2>&1 || { echo "  ✗ bun not installed — run: brew bundle install"; exit 1; }
	@mkdir -p "$(LAUNCHAGENTS)" "$(LOG_DIR)"
	@BUN_BIN=$$(command -v bun); \
	TMP=$$(mktemp); \
	sed -e "s|__BUN__|$$BUN_BIN|g" \
		-e "s|__REPO_DIR__|$(REPO_DIR)|g" \
		-e "s|__HOME__|$(HOME)|g" \
		"collector/$(PLIST_LABEL).plist.template" > "$$TMP"; \
	DST="$(LAUNCHAGENTS)/$(PLIST_LABEL).plist"; \
	if [ -f "$$DST" ] && diff -q "$$TMP" "$$DST" >/dev/null 2>&1; then \
		rm "$$TMP"; \
		echo "  · LaunchAgent up to date"; \
	else \
		mv "$$TMP" "$$DST"; \
		echo "  ✓ LaunchAgent rendered ($$DST)"; \
	fi; \
	launchctl unload "$$DST" 2>/dev/null || true; \
	launchctl load "$$DST" || { echo "  ✗ launchctl load failed"; exit 1; }; \
	sleep 2; \
	if launchctl list | grep -q "$(PLIST_LABEL)"; then \
		echo "  ✓ collector loaded (RunAtLoad + KeepAlive — survives reboot)"; \
	else \
		echo "  ✗ LaunchAgent failed to load — check $(COLLECTOR_LOG)"; \
		exit 1; \
	fi

collector-teardown: ## Unload and remove the collector's LaunchAgent (does not delete the token or spool)
	@DST="$(LAUNCHAGENTS)/$(PLIST_LABEL).plist"; \
	if [ -f "$$DST" ]; then \
		launchctl unload "$$DST" 2>/dev/null || true; \
		rm "$$DST"; \
		echo "  ✓ collector LaunchAgent removed"; \
	else \
		echo "  · nothing to remove"; \
	fi

collector-logs: ## Tail the native collector's log (the previous generation is the same path + .1)
	@touch "$(COLLECTOR_LOG)"
	@# The collector rotates this file in place, so `tail -f` survives a rotation
	@# (it reports "file truncated" and reads on) instead of silently following a
	@# renamed inode. Anything older than the truncation is in the .1 generation.
	@if [ -f "$(COLLECTOR_LOG).1" ]; then \
		echo "  · older window kept at $(COLLECTOR_LOG).1"; \
	fi
	tail -f "$(COLLECTOR_LOG)"

check: ## Typecheck (API + collector, then the dashboard) + run the test suite
	bun run typecheck
	@# The root tsconfig's `include` is src/collector only, so the dashboard needs
	@# its own pass — it has different lib/jsx settings and a generated route tree.
	@# Without this, a broken web/ typechecks clean and only fails at image build.
	cd web && bun run typecheck
	bun test

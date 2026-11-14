.PHONY: help env up deploy down guard-deploy logs logs-follow verify collector-setup collector-teardown collector-logs check \
	app-stop app-start speedtest-install \
	heartbeat-setup heartbeat-teardown heartbeat-status heartbeat-logs router-reconnect router-reboot \
	watchdog-setup watchdog-teardown watchdog-status watchdog-logs watchdog-arm watchdog-disarm \
	watchdog-readiness watchdog-state \
	db-counts db-shell db-backup db-vacuum db-restore db-move \
	volume-counts volume-backup container-env rollback-to-container
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
# Renamed from com.jkrumm.linewatch-collector on 2026-08-06. The old identifier
# is PERMANENTLY BURNED in macOS Background Task Management: once BTM holds an
# entry as disallowed, nothing clears it but a NEW Label. Never "tidy" this name
# back — see collector/run-agent.sh for the full mechanism.
PLIST_LABEL   := com.jkrumm.linewatch-collector-agent
# Retired label, booted out + removed by `install-collector` so the burned
# entry cannot keep a second copy of the probe alive alongside the new one.
OLD_PLIST_LABEL := com.jkrumm.linewatch-collector

# The app: one native launchd job on 127.0.0.1:7731 (collector/app.ts). Rendered by
# `make up` from collector/com.jkrumm.linewatch-app.plist.template. It ran in a
# Colima container until 2026-11-14; docs/storage.md has the move and the rollback.
APP_LABEL     := com.jkrumm.linewatch-app
APP_LOG       := $(LOG_DIR)/linewatch-app.log
APP_PLIST     := $(LAUNCHAGENTS)/$(APP_LABEL).plist

# The record. A plain file on the host, outside the checkout so a `git clean`
# cannot reach it. Overridable so the destructive db-* targets can be *rehearsed*
# against a scratch copy instead of the record:
#
#   make db-backup  DB_FILE=/tmp/drill.db
#   make db-restore DB_FILE=/tmp/drill.db FROM=<snap>.db
#
# A non-live DB_FILE never stops or starts the service. "Rehearsed once by hand"
# is how a restore path rots; this makes the drill repeatable and harmless.
DB_DIR        := $(HOME)/.local/share/linewatch
LIVE_DB       := $(DB_DIR)/linewatch.db
DB_FILE       := $(LIVE_DB)
IS_LIVE       := $(if $(filter $(DB_FILE),$(LIVE_DB)),1,)
BACKUP_DIR    := $(REPO_DIR)/backups

# Stopping and starting the service is only correct for the live database.
# Deliberately `$(SUBMAKE)`, not the literal `$(MAKE)`: GNU make runs any recipe
# line containing that string even under `-n`, and here it shares a line with the
# restore itself. `make -n db-restore` has to stay a dry run.
SUBMAKE       := $(MAKE)
SERVICE_STOP  = $(if $(IS_LIVE),$(SUBMAKE) --no-print-directory app-stop,echo "  · drill on $(DB_FILE) — leaving the running service alone")
SERVICE_START = $(if $(IS_LIVE),$(SUBMAKE) --no-print-directory app-start,echo "  · drill on $(DB_FILE) — service untouched")

# The pre-2026-11-14 home of the record, kept untouched for the rollback window:
# the named Docker volume the host cannot open. Only the one-time `db-move` and
# `rollback-to-container` reach it, through a throwaway container (docs/storage.md).
LIVE_VOLUME   := linewatch-data
VOLUME        := $(LIVE_VOLUME)
VOLUME_DB     := /app/data/linewatch.db
# Compose derives its project name from the directory; the container-side targets
# assert that the fixed `container_name: linewatch` belongs to *this* project.
COMPOSE_PROJECT := $(notdir $(REPO_DIR))
HOST_OWNER    := $(shell id -u):$(shell id -g)

# A throwaway container from this project's own image, with the volume and
# ./backups mounted. Runs as root because it has to write both the app-owned
# volume and the host-owned ./backups bind mount; it publishes no ports.
VOLUME_TOOL = docker compose run --rm --no-deps -T --user 0:0 -v "$(VOLUME):/app/data" -v "$(BACKUP_DIR):/backups" --entrypoint sh linewatch -c
# compose refuses to parse docker-compose.yml without ./.env (it is the container's
# env_file); the volume-side targets carry no secret, so an empty one is enough.
REQUIRE_VOLUME = @[ -f .env ] || { : > .env; chmod 600 .env; }; docker volume inspect $(VOLUME) >/dev/null 2>&1 || { echo "  ✗ Docker volume '$(VOLUME)' does not exist — nothing to move."; exit 1; }
REQUIRE_DB = @test -f "$(DB_FILE)" || { echo "  ✗ no database at $(DB_FILE) — the app has not run here yet (make up, or make db-move for the pre-2026-11-14 record)."; exit 1; }

# The Ookla CLI, pinned in the URL like the Dockerfile's linux build was. The
# macOS build is one universal binary.
SPEEDTEST_BIN := $(HOME)/.local/bin/speedtest
SPEEDTEST_URL := https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-macosx-universal.tgz

HEARTBEAT_LABEL := com.jkrumm.linewatch-heartbeat
HEARTBEAT_LOG   := $(LOG_DIR)/linewatch-heartbeat.log
# The Uptime Kuma push URL, resolved by collector/heartbeat.ts. A plain
# chmod-600 host file for the same reason as the bearer token and the router
# password, and one this repo shares with every other heartbeat on this machine
# (dotfiles/scripts/lib/kuma-push.sh): a monitor must not depend on the thing it
# monitors, so resolving it through the secrets cache would let a stale cache —
# itself an alert condition — take the monitor down with it.
KUMA_URL_DIR    := $(HOME)/.config/uptime-kuma
KUMA_URL_FILE   := $(KUMA_URL_DIR)/linewatch-push-url

WATCHDOG_LABEL    := com.jkrumm.linewatch-watchdog
WATCHDOG_LOG      := $(LOG_DIR)/linewatch-watchdog.log
WATCHDOG_STATE    := $(HOME)/.local/state/linewatch/watchdog-state.json
WATCHDOG_DISARM   := $(TOKEN_DIR)/watchdog-disarmed
# A SECOND push monitor, not a message on the first. The line monitor is
# silence-means-down, so it cannot also carry "the watchdog latched itself" -
# that happens on a healthy line, where the line monitor is green and staying
# green. This one's silence means the watchdog is gone.
WATCHDOG_URL_FILE := $(KUMA_URL_DIR)/linewatch-watchdog-push-url

# Renders collector/$(1).plist.template into ~/Library/LaunchAgents and
# (re)bootstraps it. $(1) = plist label, $(2) = log file to point at on failure.
# Shared by both agents so the launchd handling below cannot drift between them —
# it is subtle enough that one copy is the only maintainable number.
define install_agent
	@command -v bun >/dev/null 2>&1 || { echo "  ✗ bun not installed — run: brew bundle install"; exit 1; }
	@mkdir -p "$(LAUNCHAGENTS)" "$(LOG_DIR)"
	@BUN_BIN=$$(command -v bun); \
	TMP=$$(mktemp); \
	sed -e "s|__BUN__|$$BUN_BIN|g" \
		-e "s|__BUN_DIR__|$$(dirname "$$BUN_BIN")|g" \
		-e "s|__REPO_DIR__|$(REPO_DIR)|g" \
		-e "s|__HOME__|$(HOME)|g" \
		"collector/$(1).plist.template" > "$$TMP"; \
	DST="$(LAUNCHAGENTS)/$(1).plist"; \
	if [ -f "$$DST" ] && diff -q "$$TMP" "$$DST" >/dev/null 2>&1; then \
		rm "$$TMP"; \
		echo "  · $(1) up to date"; \
	else \
		mv "$$TMP" "$$DST"; \
		echo "  ✓ $(1) rendered ($$DST)"; \
	fi; \
	: "Modern domain-target form, not the legacy load/unload pair it replaced."; \
	: "The legacy launchctl load cannot clear a DISABLED OVERRIDE: launchd keeps"; \
	: "a per-user enabled/disabled database separate from the plist, and a job"; \
	: "disabled there is skipped SILENTLY at every login - no error, no log line,"; \
	: "nothing in the job own StandardErrorPath, because the job is never even"; \
	: "considered. Measured, not theoretical: after the 2026-08-01 reboot the"; \
	: "collector was the only one of 22 in ~/Library/LaunchAgents that did not"; \
	: "come back, log show over the boot window had no launchd mention of it at"; \
	: "all, and its plist, permissions and xattrs were identical to agents that"; \
	: "did load. enable is idempotent, so it stays as cheap insurance - but it"; \
	: "was NOT the cause. Root-caused 2026-08-06: macOS Background Task"; \
	: "Management attributes an agent to the code-signing identity of"; \
	: "ProgramArguments[0]. These plists pointed straight at /opt/homebrew/bin/bun,"; \
	: "so BTM recorded Bun's signer and marked the collector [enabled, disallowed]."; \
	: "BTM is a DIFFERENT database from the launchd enable/disable one, so"; \
	: "launchctl enable could never clear it - which is why the agent kept"; \
	: "returning late via KeepAlive rescue (+2m48s) instead of at RunAtLoad."; \
	: "Fix: argv[0] is now collector/run-agent.sh, an unsigned script, which"; \
	: "attributes to Unknown Developer and is allowed. See that file."; \
	UID_N=$$(id -u); \
	launchctl bootout gui/$$UID_N/$(1) 2>/dev/null || true; \
	launchctl enable gui/$$UID_N/$(1) 2>/dev/null || true; \
	launchctl bootstrap gui/$$UID_N "$$DST" || { echo "  ✗ launchctl bootstrap failed"; exit 1; }; \
	sleep 2; \
	if launchctl print gui/$$UID_N/$(1) >/dev/null 2>&1; then \
		echo "  ✓ $(1) loaded and enabled"; \
	else \
		echo "  ✗ $(1) failed to load — check $(2)"; \
		exit 1; \
	fi
endef

# `bootout`, never the legacy `unload`, for the same reason install_agent uses
# `bootstrap`: they address the same domain. `unload` here left the job's
# disabled-override state untouched, which is the half of the trap above that
# does not announce itself.
define teardown_agent
	@DST="$(LAUNCHAGENTS)/$(1).plist"; \
	UID_N=$$(id -u); \
	launchctl bootout gui/$$UID_N/$(1) 2>/dev/null || true; \
	if [ -f "$$DST" ]; then \
		rm "$$DST"; \
		echo "  ✓ $(1) removed"; \
	else \
		echo "  · $(1) not installed"; \
	fi
endef

help: ## Show targets
	@awk 'BEGIN{FS=":.*##"; printf "Targets:\n"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

env: ## Ensure the bearer token exists (idempotent; `up` does this for you)
	@mkdir -p "$(TOKEN_DIR)"
	@if [ ! -f "$(TOKEN_FILE)" ]; then \
		openssl rand -hex 32 > "$(TOKEN_FILE)"; \
		chmod 600 "$(TOKEN_FILE)"; \
		echo "  ✓ generated bearer token at $(TOKEN_FILE)"; \
	fi
	@# The app reads the token, and the router password if one exists, straight
	@# from these two chmod-600 host files — the same two the collector uses. No
	@# .env, no secrets cache: monitoring must keep working with an unseeded cache.
	@# The router password is optional: with no file the poller stays disabled and
	@# GET /api/router says so.
	@if [ -s "$(ROUTER_PW_FILE)" ]; then \
		echo "  ✓ router password at $(ROUTER_PW_FILE) — poller enabled"; \
	else \
		echo "  · no $(ROUTER_PW_FILE) — router poller stays disabled (GET /api/router says so)"; \
	fi

speedtest-install: ## Install the Ookla CLI to ~/.local/bin (idempotent; `up` does this for you)
	@# The speed-test runner shells out to `speedtest`. In the container the
	@# Dockerfile put it there; natively it has to be on the PATH the plist sets.
	@# Fetched into a fresh directory, never into the checkout.
	@if [ -x "$(SPEEDTEST_BIN)" ] && "$(SPEEDTEST_BIN)" --version >/dev/null 2>&1; then \
		echo "  · speedtest already at $(SPEEDTEST_BIN)"; exit 0; \
	fi; \
	TMP=$$(mktemp -d); \
	curl -fsSL "$(SPEEDTEST_URL)" -o "$$TMP/speedtest.tgz" \
		&& tar -xzf "$$TMP/speedtest.tgz" -C "$$TMP" speedtest \
		&& mkdir -p "$(dir $(SPEEDTEST_BIN))" \
		&& install -m 755 "$$TMP/speedtest" "$(SPEEDTEST_BIN)" \
		|| { rm -rf "$$TMP"; echo "  ✗ could not install the Ookla CLI from $(SPEEDTEST_URL)"; exit 1; }; \
	rm -rf "$$TMP"; \
	"$(SPEEDTEST_BIN)" --version | head -n 1 \
		|| { echo "  ✗ $(SPEEDTEST_BIN) does not run"; exit 1; }; \
	echo "  ✓ speedtest installed at $(SPEEDTEST_BIN)"

up: guard-deploy env speedtest-install ## THE deploy: build the dashboard, render + (re)start the launchd job, wait for health, prove it runs this checkout. Safe to re-run any time.
	@# Refuse to start an EMPTY record while the old one is still in the Docker
	@# volume: the app would migrate a fresh database, the collector's spool would
	@# fill it, and the history would look lost. `db-move` is the one-time move.
	@# Fails open (no docker, no volume) so it can never block a healthy host;
	@# FRESH=1 is the policy override for a deliberately empty start.
	@if [ ! -f "$(LIVE_DB)" ] && [ -z "$(FRESH)" ] && docker volume inspect $(LIVE_VOLUME) >/dev/null 2>&1; then \
		echo "  ✗ no database at $(LIVE_DB), but the $(LIVE_VOLUME) volume still holds the record — run 'make db-move' once. (FRESH=1 starts empty on purpose.)"; exit 1; \
	fi
	bun install --frozen-lockfile
	cd web && bun install --frozen-lockfile && bun run build
	@mkdir -p "$(DB_DIR)"
	$(call install_agent,$(APP_LABEL),$(APP_LOG))
	@printf "  waiting for /health… "
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if curl -fsS http://127.0.0.1:7731/health >/dev/null 2>&1; then echo "ok"; exit 0; fi; \
		sleep 2; \
	done; \
	echo "TIMED OUT — check: make logs"; exit 1
	@# Assert, don't nuke. The container proved itself with a baked-in source
	@# fingerprint; a native job has no image to go stale, so the failure it can
	@# have is the other one — answering from the wrong tree (a sibling worktree, an
	@# orphan from an older checkout) or from the wrong database. Ask the kernel
	@# what the listening process is actually holding.
	@printf "  verifying the job runs this checkout and the record… "
	@PID=$$(lsof -nP -iTCP:7731 -sTCP:LISTEN -t 2>/dev/null | head -n 1); \
	if [ -z "$$PID" ]; then echo "FAILED"; echo "  ✗ nothing is listening on 127.0.0.1:7731"; exit 1; fi; \
	CWD=$$(lsof -a -p $$PID -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'); \
	WANT=$$(cd "$(REPO_DIR)" && pwd -P); \
	if [ "$$CWD" != "$$WANT" ]; then \
		echo "MISMATCH"; echo "  ✗ the process on :7731 (pid $$PID) runs from '$$CWD', not '$$WANT' — diagnose, do not redeploy past it."; exit 1; \
	fi; \
	if ! lsof -p $$PID -Fn 2>/dev/null | grep -qF "$(LIVE_DB)"; then \
		echo "MISMATCH"; echo "  ✗ pid $$PID does not hold $(LIVE_DB) open — it is serving a different record."; exit 1; \
	fi; \
	echo "ok (pid $$PID)"
	@echo "✓ linewatch up — http://127.0.0.1:7731"

app-stop: ## (internal) Unload the launchd job; the plist stays, so the next login or `app-start` brings it back
	@UID_N=$$(id -u); \
	if launchctl bootout gui/$$UID_N/$(APP_LABEL) 2>/dev/null; then echo "  ✓ $(APP_LABEL) stopped"; else echo "  · $(APP_LABEL) was not loaded"; fi; \
	for i in 1 2 3 4 5 6 7 8 9 10; do \
		lsof -nP -iTCP:7731 -sTCP:LISTEN -t >/dev/null 2>&1 || exit 0; \
		sleep 1; \
	done; \
	echo "  ✗ something still listens on :7731 after 10 s"; exit 1

app-start: ## (internal) Load the launchd job again after an app-stop and wait for /health
	@if [ ! -f "$(APP_PLIST)" ]; then echo "  · $(APP_LABEL) is not installed — nothing to start (make up)"; exit 0; fi; \
	launchctl bootstrap gui/$$(id -u) "$(APP_PLIST)" 2>/dev/null || true; \
	printf "  waiting for /health… "; \
	for i in 1 2 3 4 5 6 7 8 9 10; do \
		if curl -fsS http://127.0.0.1:7731/health >/dev/null 2>&1; then echo "ok"; exit 0; fi; \
		sleep 2; \
	done; \
	echo "TIMED OUT — check: make logs"; exit 1

down: ## Stop the app (the heartbeat will push `down` and Kuma alerts on a sustained stop; `make up` brings it back)
	@$(SUBMAKE) --no-print-directory app-stop

logs: ## Show the last 200 lines of the app log, then exit (bounded — no follow)
	@touch "$(APP_LOG)"
	@tail -n 200 "$(APP_LOG)"

logs-follow: ## Follow the app log until interrupted (blocking; truncation by the in-place rotation is survived)
	@touch "$(APP_LOG)"
	tail -f "$(APP_LOG)"

verify: ## Probe the running stack's health endpoint; exits non-zero if it is not live
	@# The production health URL. Loopback-only, so this is only meaningful on the
	@# mini itself.
	@curl -fsS http://127.0.0.1:7731/health \
		&& echo "  ✓ live and healthy — http://127.0.0.1:7731/health" \
		|| { echo "  ✗ no healthy answer from http://127.0.0.1:7731/health — is the job up? (make up)"; exit 1; }

deploy: ## Report how master ships: `make up` on the mini from an up-to-date master checkout (no CD)
	@# There is no CD for this repo (only check.yml). The app ships by `make up`
	@# from an up-to-date master checkout on the mini.
	@echo "  · no CD — ship with: git checkout master && git pull && make up (on the mini)"

guard-deploy: ## (internal) Refuse to deploy from a non-master checkout, a worktree or with tracked modifications; override with ALLOW_DIRTY_DEPLOY=1
	@if [ -n "$(ALLOW_DIRTY_DEPLOY)" ]; then \
		echo "  ! ALLOW_DIRTY_DEPLOY set — skipping the master/clean-tree guard"; exit 0; \
	fi; \
	BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$BRANCH" != "master" ]; then \
		echo "  ✗ refusing to deploy from '$$BRANCH' — deploys come from master. Emergency override: make up ALLOW_DIRTY_DEPLOY=1"; exit 1; \
	fi; \
	: "The plist points launchd at THIS directory. A linked worktree is deleted when"; \
	: "its branch lands, and the job would then be pointing at nothing."; \
	if [ "$$(git rev-parse --git-dir)" != "$$(git rev-parse --git-common-dir)" ]; then \
		echo "  ✗ refusing to deploy from a linked worktree — the launchd job would point into a directory that is deleted when the branch lands. Deploy from the main checkout."; exit 1; \
	fi; \
	if [ -n "$$(git status --porcelain --untracked-files=no)" ]; then \
		echo "  ✗ refusing to deploy with uncommitted changes to tracked files:"; \
		git status --porcelain --untracked-files=no | sed 's/^/      /'; \
		echo "    Commit them first. Emergency override: make up ALLOW_DIRTY_DEPLOY=1"; exit 1; \
	fi

# ── Database (a host file — see docs/storage.md) ─────────────────────────────

db-counts: ## Row counts per table in the database (read-only, scriptable)
	$(REQUIRE_DB)
	@for t in $$(sqlite3 -readonly "$(DB_FILE)" "select name from sqlite_master where type='table' order by name"); do printf "  %-24s %s\n" "$$t" "$$(sqlite3 -readonly "$(DB_FILE)" "select count(*) from \"$$t\"")"; done; \
	printf "  %-24s %s\n" "probe_sample max ts" "$$(sqlite3 -readonly "$(DB_FILE)" "select coalesce(max(ts),0) from probe_sample")"

db-shell: ## Interactive sqlite3 prompt on the database (the app may stay up: WAL, one host kernel)
	$(REQUIRE_DB)
	@echo "  · $(DB_FILE) — .quit to leave"
	@sqlite3 "$(DB_FILE)"

# Integrity-gated on both sides: a snapshot of a corrupt database is worse than
# no snapshot, and a snapshot that arrives corrupt is a backup you only discover
# is useless during a restore. `.backup` is SQLite's online backup API, so it
# captures the WAL too — a plain `cp` of the main file silently omits everything
# written since the last checkpoint.
db-backup: ## Verified snapshot of the database into ./backups (gitignored); SNAP=<name>.db names it
	$(REQUIRE_DB)
	@mkdir -p "$(BACKUP_DIR)"
	@set -e; \
	[ "$$(sqlite3 -readonly "$(DB_FILE)" "pragma integrity_check")" = ok ] || { echo "  ✗ source fails integrity_check — refusing to snapshot a corrupt database"; exit 1; }; \
	OUT="$(BACKUP_DIR)/$(if $(SNAP),$(SNAP),linewatch-$$(date -u +%Y%m%dT%H%M%SZ).db)"; \
	sqlite3 "$(DB_FILE)" ".backup $$OUT"; \
	: "Take the snapshot out of WAL mode before anything else touches it."; \
	: "A .backup inherits journal_mode from the source, and a WAL database"; \
	: "cannot be opened -readonly unless its -shm sidecar exists. A snapshot"; \
	: "whose only job is to be readable on the day something has gone wrong"; \
	: "must be a genuine single file, openable anywhere, read-only or not."; \
	sqlite3 "$$OUT" "pragma journal_mode=delete" >/dev/null; \
	[ "$$(sqlite3 -readonly "$$OUT" "pragma integrity_check")" = ok ] || { echo "  ✗ snapshot fails integrity_check"; rm -f "$$OUT"; exit 1; }; \
	ROWS=$$(sqlite3 -readonly "$$OUT" "select count(*) from probe_sample"); \
	SIZE=$$(du -h "$$OUT" | cut -f1); \
	rm -f "$$OUT"-wal "$$OUT"-shm; \
	echo "  ✓ backups/$$(basename $$OUT) — $$ROWS probe_sample rows, $$SIZE"

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

router-reconnect: ## Re-dial the WAN connection (needs LINEWATCH_ROUTER_WRITE=1 in the app plist; drops the line for ~15s)
	@# No OID parameter, and there never will be one: the router routes every
	@# verb through one URL with the verb inside an encrypted body, so a target
	@# that took an operation name would put a factory reset one typo away. The
	@# route exposes named actions only.
	@#
	@# Measured on this line 2026-08-01: 13s from command to a re-established
	@# session, zero packets lost across the 30s probe cycles either side, and a
	@# 3s en0 link flap the 1Hz sampler caught. It is cheap. It is also not a
	@# fix for anything on its own - see docs/watchdog-spec.md.
	@curl -fsS -X POST http://127.0.0.1:7731/api/router/actions/reconnect \
		-H "authorization: Bearer $$(cat $(TOKEN_FILE))" | python3 -m json.tool

router-reboot: ## Reboot the router (needs LINEWATCH_ROUTER_WRITE=1; takes the WHOLE LAN down ~2min)
	@# Typed confirmation, unlike every other target here, and it is not
	@# ceremony. This drops the LAN, which drops Tailscale, which is the only
	@# route to this machine from outside the house - so a stray invocation from
	@# a remote session ends that session and cannot be taken back. The firmware
	@# budgets 130s for the restart (INCLUDE_REBOOT_WAIT_TIME on the device).
	@#
	@# No OID parameter here either. The route exposes named actions only.
	@printf '  ! This reboots the router: the whole LAN, Tailscale included, goes down for ~2 minutes.\n'
	@printf '    Type REBOOT to continue: '
	@read -r CONFIRM; [ "$$CONFIRM" = "REBOOT" ] || { echo "  · aborted"; exit 1; }
	@# --max-time, and a curl failure is not an error: the device stops answering
	@# because it is rebooting, so a dead transport here is the expected shape of
	@# success. The route reports that as outcome `unknown` when it gets the
	@# chance; when it does not, this prints the reason and exits 0 anyway.
	@curl -sS --max-time 30 -X POST http://127.0.0.1:7731/api/router/actions/reboot \
		-H "authorization: Bearer $$(cat $(TOKEN_FILE))" | python3 -m json.tool \
		|| echo "  · no answer from the API - if the router went down mid-request that is the expected signature; check make logs and the probe record"

db-vacuum: ## Rebuild the database, reclaiming freed pages (run after a migration that DROPs a column)
	$(REQUIRE_DB)
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
	@$(SERVICE_STOP)
	@STATUS=0; \
	( set -e; \
		[ "$$(sqlite3 -readonly "$(DB_FILE)" "pragma integrity_check")" = ok ] || { echo "  ✗ fails integrity_check — refusing to vacuum a corrupt database"; exit 1; }; \
		BEFORE=$$(du -k "$(DB_FILE)" | cut -f1); \
		: "checkpoint first: VACUUM does not rewrite pages still sitting in the"; \
		: "WAL, and the dropped values can be in there too"; \
		sqlite3 "$(DB_FILE)" "pragma wal_checkpoint(TRUNCATE)" >/dev/null; \
		sqlite3 "$(DB_FILE)" "vacuum"; \
		[ "$$(sqlite3 -readonly "$(DB_FILE)" "pragma integrity_check")" = ok ] || { echo "  ✗ fails integrity_check AFTER vacuum — restore from ./backups"; exit 1; }; \
		AFTER=$$(du -k "$(DB_FILE)" | cut -f1); \
		echo "  ✓ vacuumed — $${BEFORE}K → $${AFTER}K" );   STATUS=$$?; \
	$(SERVICE_START); \
	exit $$STATUS

db-restore: ## Restore the database from a snapshot in ./backups: make db-restore FROM=<file>.db [FORCE=1]
	@if [ -z "$(FROM)" ]; then \
		echo 'Usage: make db-restore FROM=<file>.db   (a filename inside ./backups)'; \
		ls -1t "$(BACKUP_DIR)"/*.db 2>/dev/null | head -5 | sed 's|.*/|  candidate: |'; \
		exit 1; \
	fi
	@test -f "$(BACKUP_DIR)/$(FROM)" || { echo "  ✗ no such snapshot: backups/$(FROM)"; exit 1; }
	@# Stop the API first. Restoring under a live writer would either lose every
	@# write made after the copy or interleave them with it.
	@$(SERVICE_STOP)
	@# Whatever the restore decides, the service has to come back: a refusal or a
	@# failed assert that leaves linewatch stopped turns a safety check into an
	@# outage, and the collector's spool only covers a window that ends. So the
	@# exit status is carried past the restart rather than aborting the recipe.
	@mkdir -p "$(dir $(DB_FILE))"
	@STATUS=0; \
	( set -e; \
		SRC="$(BACKUP_DIR)/$(FROM)"; \
		DB="$(DB_FILE)"; \
		: "a -readonly open of a WAL database recreates its sidecars; leaving them"; \
		: "next to the snapshot makes the *next* restore count main+WAL and copy"; \
		: "main only. Clean them on every exit, refusals included."; \
		trap 'rm -f "$$SRC-wal" "$$SRC-shm"' EXIT; \
		STAMP=$$(date -u +%Y%m%dT%H%M%SZ); \
		ARCHIVE="$(BACKUP_DIR)/linewatch-pre-restore-$$STAMP.db"; \
		KEPT=""; \
		[ "$$(sqlite3 -readonly "$$SRC" "pragma integrity_check")" = ok ] || { echo "  ✗ snapshot fails integrity_check — refusing to restore"; exit 1; }; \
		WANT=$$(sqlite3 -readonly "$$SRC" "select count(*) from probe_sample"); \
		SNAP_MAX=$$(sqlite3 -readonly "$$SRC" "select coalesce(max(ts),0) from probe_sample"); \
		if [ -f "$$DB" ]; then \
			if LIVE_MAX=$$(sqlite3 -readonly "$$DB" "select coalesce(max(ts),0) from probe_sample" 2>/dev/null); then \
				NEWER=$$(sqlite3 -readonly "$$DB" "select count(*) from probe_sample where ts > $$SNAP_MAX"); \
				NEWER_ST=$$(sqlite3 -readonly "$$DB" "select count(*) from speed_test where ts > $$SNAP_MAX"); \
				if [ "$$NEWER" -gt 0 ] || [ "$$NEWER_ST" -gt 0 ]; then \
					FIRST=$$(sqlite3 -readonly "$$DB" "select min(datetime(ts/1000,'unixepoch')) from probe_sample where ts > $$SNAP_MAX"); \
					LAST=$$(sqlite3 -readonly "$$DB" "select max(datetime(ts/1000,'unixepoch')) from probe_sample where ts > $$SNAP_MAX"); \
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
				: "and leaves the WAL behind, which docs/storage.md says is not a backup."; \
				sqlite3 "$$DB" ".backup $$ARCHIVE"; \
				sqlite3 "$$ARCHIVE" "pragma journal_mode=delete" >/dev/null; \
				[ "$$(sqlite3 -readonly "$$ARCHIVE" "pragma integrity_check")" = ok ] || { echo "  ✗ pre-restore archive fails integrity_check — refusing to overwrite the live database"; rm -f "$$ARCHIVE" "$$ARCHIVE-wal" "$$ARCHIVE-shm"; exit 1; }; \
				ARCH_ROWS=$$(sqlite3 -readonly "$$ARCHIVE" "select count(*) from probe_sample"); \
				ARCH_MAX=$$(sqlite3 -readonly "$$ARCHIVE" "select coalesce(max(ts),0) from probe_sample"); \
				rm -f "$$ARCHIVE-wal" "$$ARCHIVE-shm"; \
				KEPT="backups/$$(basename $$ARCHIVE)"; \
				echo "  ✓ archived the live database first: $$KEPT — $$ARCH_ROWS probe_sample rows, max ts $$ARCH_MAX (WAL included; restorable with FROM=)"; \
			else \
				UNREAD="$(BACKUP_DIR)/linewatch-unreadable-$$STAMP"; \
				mkdir -p "$$UNREAD"; \
				cp "$$DB" "$$UNREAD"/; \
				for s in -wal -shm; do if [ -f "$$DB$$s" ]; then cp "$$DB$$s" "$$UNREAD"/; fi; done; \
				KEPT="backups/$$(basename $$UNREAD)/"; \
				echo "  ! the live database cannot be read (probe_sample query failed) — that is"; \
				echo "    corruption, not an empty database. Copied it, WAL and all, to"; \
				echo "    backups/$$(basename $$UNREAD)."; \
				echo "    Salvage before accepting the loss:  sqlite3 <copy> .recover"; \
				echo "    (that is what recovered 945 of 1408 rows on 2026-07-30)"; \
				[ -n "$(FORCE)" ] || { echo "  ✗ refusing to replace an unreadable database — re-run with FORCE=1 once you have recovered what you can."; exit 1; }; \
			fi; \
			rm -f "$$DB" "$$DB-wal" "$$DB-shm"; \
		fi; \
		: "restore with .backup: the snapshot may carry a WAL, and cp would copy"; \
		: "the main file without it."; \
		sqlite3 "$$SRC" ".backup $$DB"; \
		[ "$$(sqlite3 -readonly "$$DB" "pragma integrity_check")" = ok ] || { echo "  ✗ restored database fails integrity_check"; exit 1; }; \
		GOT=$$(sqlite3 -readonly "$$DB" "select count(*) from probe_sample"); \
		[ "$$GOT" = "$$WANT" ] || { echo "  ✗ row count mismatch after restore: $$WANT -> $$GOT"; exit 1; }; \
		echo "  ✓ the database is now exactly backups/$(FROM): $$GOT probe_sample rows, max ts $$SNAP_MAX."; \
		: "deliberately not claiming more than that. The old message — restored N"; \
		: "rows, previous copy kept — read as if nothing was lost, on a target that"; \
		: "had just dropped an accepted measurement."; \
		if [ -n "$$KEPT" ]; then \
			echo "    Whatever the database held after that snapshot is no longer live. It"; \
			echo "    survives only in $$KEPT."; \
		else \
			echo "    There was no database before this, so nothing was replaced."; \
		fi );   STATUS=$$?; \
	$(SERVICE_START); \
	exit $$STATUS

# ── The move out of the Docker volume, and the way back (docs/storage.md) ────

volume-counts: ## Row counts per table in the Docker volume's database (read-only; the pre-move record)
	$(REQUIRE_VOLUME)
	@# A throwaway container, so this answers while the container service is down
	@# — which is exactly when a move wants to be checked. Not root: a root-owned
	@# `-shm` left behind by a read would lock the app (uid 999) out of its own file.
	@docker compose run --rm --no-deps -T -v "$(VOLUME):/app/data" --entrypoint sh linewatch -c 'if [ ! -f $(VOLUME_DB) ]; then echo "  · no database in volume $(VOLUME)"; exit 0; fi; \
		for t in $$(sqlite3 -readonly $(VOLUME_DB) "select name from sqlite_master where type='\''table'\'' order by name"); do printf "  %-24s %s\n" "$$t" "$$(sqlite3 -readonly $(VOLUME_DB) "select count(*) from \"$$t\"")"; done; \
		printf "  %-24s %s\n" "probe_sample max ts" "$$(sqlite3 -readonly $(VOLUME_DB) "select coalesce(max(ts),0) from probe_sample")"'

volume-backup: ## Verified snapshot of the Docker volume's database into ./backups; SNAP=<name>.db names it
	$(REQUIRE_VOLUME)
	@mkdir -p "$(BACKUP_DIR)"
	@$(VOLUME_TOOL) 'set -e; \
		[ "$$(sqlite3 -readonly $(VOLUME_DB) "pragma integrity_check")" = ok ] || { echo "  ✗ source fails integrity_check — refusing to snapshot a corrupt database"; exit 1; }; \
		OUT="/backups/$(if $(SNAP),$(SNAP),linewatch-volume-$$(date -u +%Y%m%dT%H%M%SZ).db)"; \
		sqlite3 $(VOLUME_DB) ".backup $$OUT"; \
		sqlite3 "$$OUT" "pragma journal_mode=delete" >/dev/null; \
		[ "$$(sqlite3 -readonly "$$OUT" "pragma integrity_check")" = ok ] || { echo "  ✗ snapshot fails integrity_check"; rm -f "$$OUT"; exit 1; }; \
		ROWS=$$(sqlite3 -readonly "$$OUT" "select count(*) from probe_sample"); \
		chown $(HOST_OWNER) "$$OUT"; \
		rm -f "$$OUT"-wal "$$OUT"-shm; \
		echo "  ✓ backups/$$(basename $$OUT) — $$ROWS probe_sample rows"'

# One-time. The ordering is the safety argument: the container is stopped before
# anything is read (no writer on the volume), the copy goes through a `.backup`
# snapshot (WAL included, integrity-gated), the host file is compared with the
# volume table by table AND by newest sample time before the app is ever started,
# and the volume is never written. The collector's spool covers the window — it
# keeps measuring while the API is down and replays on the next good cycle.
db-move: guard-deploy ## ONE-TIME: stop the container, copy the volume's database to the host, compare, then `make up`
	$(REQUIRE_VOLUME)
	@if [ -f "$(LIVE_DB)" ]; then \
		echo "  ✗ $(LIVE_DB) already exists — the move has happened (or the app started empty). Refusing to overwrite a host database; move it aside by hand if you mean to redo this."; exit 1; \
	fi
	docker compose build
	@mkdir -p "$(DB_DIR)" "$(BACKUP_DIR)"
	docker compose down
	@STATUS=0; \
	( set -e; \
		SNAP="linewatch-move-$$(date -u +%Y%m%dT%H%M%SZ).db"; \
		$(SUBMAKE) --no-print-directory volume-backup SNAP="$$SNAP"; \
		$(SUBMAKE) --no-print-directory volume-counts > "$(BACKUP_DIR)/.move-before.txt"; \
		cp "$(BACKUP_DIR)/$$SNAP" "$(LIVE_DB)"; \
		chmod 600 "$(LIVE_DB)"; \
		[ "$$(sqlite3 -readonly "$(LIVE_DB)" "pragma integrity_check")" = ok ] || { echo "  ✗ the host copy fails integrity_check"; exit 1; }; \
		$(SUBMAKE) --no-print-directory db-counts > "$(BACKUP_DIR)/.move-after.txt"; \
		if ! diff "$(BACKUP_DIR)/.move-before.txt" "$(BACKUP_DIR)/.move-after.txt"; then \
			echo "  ✗ the host copy differs from the volume (diff above: < volume, > host)"; exit 1; \
		fi; \
		echo "  ✓ host copy equals the volume — every table and the newest sample time:"; \
		cat "$(BACKUP_DIR)/.move-after.txt" );   STATUS=$$?; \
	if [ $$STATUS -ne 0 ]; then \
		rm -f "$(LIVE_DB)" "$(LIVE_DB)-wal" "$(LIVE_DB)-shm"; \
		echo "  ! move failed — starting the container again; the volume was never written"; \
		docker compose up -d; \
		exit $$STATUS; \
	fi
	@echo "  · the $(LIVE_VOLUME) volume is untouched and is the rollback for 7 days (docs/storage.md)"
	$(SUBMAKE) up

container-env: env ## (internal, rollback) Write ./.env for the compose container: bearer token + router password
	@TOKEN=$$(cat "$(TOKEN_FILE)"); \
	if [ -f .env ]; then grep -vE '^LINEWATCH_(TOKEN|ROUTER_PASSWORD|UID|GID)=' .env > .env.tmp || true; else : > .env.tmp; fi; \
	chmod 600 .env.tmp; \
	printf 'LINEWATCH_TOKEN=%s\n' "$$TOKEN" >> .env.tmp; \
	if [ -s "$(ROUTER_PW_FILE)" ]; then \
		: "first line only, CR stripped: compose reads .env line-by-line"; \
		ROUTER_PW=$$(head -n 1 "$(ROUTER_PW_FILE)" | tr -d '\r'); \
		[ -z "$$ROUTER_PW" ] || printf 'LINEWATCH_ROUTER_PASSWORD=%s\n' "$$ROUTER_PW" >> .env.tmp; \
	fi; \
	mv .env.tmp .env; \
	chmod 600 .env

# The way back. It carries the record forward, not just the pre-move volume: the
# volume is a week-old (or older) copy, and putting it back as-is would discard
# every measurement taken natively since the move. The volume's own database is
# archived first, so even this is reversible.
rollback-to-container: ## ROLLBACK: stop + unload the native app, carry its database back into the volume, start the container
	$(REQUIRE_DB)
	$(REQUIRE_VOLUME)
	@mkdir -p "$(BACKUP_DIR)"
	$(SUBMAKE) --no-print-directory app-stop
	$(call teardown_agent,$(APP_LABEL))
	@STAMP=$$(date -u +%Y%m%dT%H%M%SZ); \
	$(SUBMAKE) --no-print-directory db-backup SNAP="linewatch-rollback-$$STAMP.db" && \
	$(SUBMAKE) --no-print-directory container-env && \
	docker compose build && \
	$(VOLUME_TOOL) 'set -e; \
		SRC=/backups/linewatch-rollback-'"$$STAMP"'.db; \
		if [ -f $(VOLUME_DB) ]; then \
			sqlite3 $(VOLUME_DB) ".backup /backups/linewatch-volume-pre-rollback-'"$$STAMP"'.db"; \
			echo "  ✓ the volume'\''s own database kept as backups/linewatch-volume-pre-rollback-'"$$STAMP"'.db"; \
		fi; \
		rm -f $(VOLUME_DB) $(VOLUME_DB)-wal $(VOLUME_DB)-shm; \
		sqlite3 "$$SRC" ".backup $(VOLUME_DB)"; \
		chown -R app:app /app/data; \
		[ "$$(sqlite3 -readonly $(VOLUME_DB) "pragma integrity_check")" = ok ] || { echo "  ✗ the volume copy fails integrity_check"; exit 1; }; \
		[ "$$(sqlite3 -readonly $(VOLUME_DB) "select count(*) from probe_sample")" = "$$(sqlite3 -readonly "$$SRC" "select count(*) from probe_sample")" ] || { echo "  ✗ row count mismatch"; exit 1; }; \
		chown -R app:app /app/data; \
		echo "  ✓ the volume now holds the native record"' && \
	docker compose up -d --force-recreate --remove-orphans
	@printf "  waiting for /health… "
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if curl -fsS http://127.0.0.1:7731/health >/dev/null 2>&1; then echo "ok"; exit 0; fi; \
		sleep 2; \
	done; \
	echo "TIMED OUT — check: docker logs linewatch"; exit 1
	@echo "✓ back in the container. The native app is unloaded and its plist removed; its database is still at $(LIVE_DB)."

collector-setup: ## Generate the bearer token (if absent), render + load the native ping collector's LaunchAgent
	@mkdir -p "$(TOKEN_DIR)"
	@if [ ! -f "$(TOKEN_FILE)" ]; then \
		openssl rand -hex 32 > "$(TOKEN_FILE)"; \
		chmod 600 "$(TOKEN_FILE)"; \
		echo "  ✓ generated bearer token at $(TOKEN_FILE)"; \
	else \
		echo "  · token already exists at $(TOKEN_FILE)"; \
	fi
	@: "Retire the burned pre-2026-08-06 label first — otherwise its plist stays"; \
	: "in ~/Library/LaunchAgents and a second probe races this one for the log."; \
	UID_N=$$(id -u); \
	if [ -f "$(LAUNCHAGENTS)/$(OLD_PLIST_LABEL).plist" ]; then \
		launchctl bootout gui/$$UID_N/$(OLD_PLIST_LABEL) 2>/dev/null || true; \
		rm -f "$(LAUNCHAGENTS)/$(OLD_PLIST_LABEL).plist"; \
		echo "  ✓ retired burned label $(OLD_PLIST_LABEL)"; \
	fi
	$(call install_agent,$(PLIST_LABEL),$(COLLECTOR_LOG))

collector-teardown: ## Unload and remove the collector's LaunchAgent (does not delete the token or spool)
	$(call teardown_agent,$(PLIST_LABEL))
	$(call teardown_agent,$(OLD_PLIST_LABEL))

collector-logs: ## Tail the native collector's log (the previous generation is the same path + .1)
	@touch "$(COLLECTOR_LOG)"
	@# The collector rotates this file in place, so `tail -f` survives a rotation
	@# (it reports "file truncated" and reads on) instead of silently following a
	@# renamed inode. Anything older than the truncation is in the .1 generation.
	@if [ -f "$(COLLECTOR_LOG).1" ]; then \
		echo "  · older window kept at $(COLLECTOR_LOG).1"; \
	fi
	tail -f "$(COLLECTOR_LOG)"

heartbeat-setup: ## Render + load the Uptime Kuma heartbeat LaunchAgent (needs the push URL file)
	@# Fails closed here, at setup, because a human is present to fix it. At run
	@# time it fails the other way — loud and non-zero without pushing — so Kuma's
	@# own missed-heartbeat alert fires rather than a silent green.
	@if [ ! -s "$(KUMA_URL_FILE)" ]; then \
		echo "  ✗ no push URL at $(KUMA_URL_FILE)"; \
		echo "    Create the 'Home Line - Push' monitor in Uptime Kuma (homelab/uptime-kuma/monitors.yaml,"; \
		echo "    then 'make uk-sync' there), copy its push URL, and:"; \
		echo "      mkdir -p $(KUMA_URL_DIR) && printf '%s' '<push-url>' > $(KUMA_URL_FILE) && chmod 600 $(KUMA_URL_FILE)"; \
		exit 1; \
	fi
	@PERMS=$$(stat -f '%Lp' "$(KUMA_URL_FILE)"); \
	if [ "$$PERMS" != "600" ]; then echo "  ! $(KUMA_URL_FILE) is mode $$PERMS — tightening to 600"; chmod 600 "$(KUMA_URL_FILE)"; fi
	$(call install_agent,$(HEARTBEAT_LABEL),$(HEARTBEAT_LOG))

heartbeat-teardown: ## Unload and remove the heartbeat LaunchAgent (Kuma will alert on the missed heartbeat)
	$(call teardown_agent,$(HEARTBEAT_LABEL))

heartbeat-status: ## Compute the heartbeat verdict and print it WITHOUT pushing
	@LINEWATCH_HEARTBEAT_DRY_RUN=1 bun run collector/heartbeat.ts

heartbeat-logs: ## Tail the heartbeat log (the previous generation is the same path + .1)
	@touch "$(HEARTBEAT_LOG)"
	@if [ -f "$(HEARTBEAT_LOG).1" ]; then echo "  · older window kept at $(HEARTBEAT_LOG).1"; fi
	tail -f "$(HEARTBEAT_LOG)"

# ---------------------------------------------------------------------------
# Watchdog
# ---------------------------------------------------------------------------

watchdog-setup: ## Render + load the watchdog LaunchAgent (starts DISARMED — shadow mode)
	@# Shadow mode is the default and the plist carries no arming variable at
	@# all, so this is safe to run before any of the conditions in
	@# docs/watchdog-spec.md are met. It walks the whole ladder and writes
	@# `would_*` notes; it cannot touch the line.
	@if [ ! -s "$(WATCHDOG_URL_FILE)" ]; then \
		echo "  ! no watchdog push URL at $(WATCHDOG_URL_FILE)"; \
		echo "    The agent will run and log, but nothing reaches Uptime Kuma — so a"; \
		echo "    latched or crashed watchdog would be invisible on a healthy line."; \
		echo "    Create the 'Home Line - Watchdog' push monitor (homelab/uptime-kuma/monitors.yaml,"; \
		echo "    then 'make uk-sync' there) and:"; \
		echo "      mkdir -p $(KUMA_URL_DIR) && printf '%s' '<push-url>' > $(WATCHDOG_URL_FILE) && chmod 600 $(WATCHDOG_URL_FILE)"; \
	else \
		PERMS=$$(stat -f '%Lp' "$(WATCHDOG_URL_FILE)"); \
		if [ "$$PERMS" != "600" ]; then echo "  ! $(WATCHDOG_URL_FILE) is mode $$PERMS — tightening to 600"; chmod 600 "$(WATCHDOG_URL_FILE)"; fi; \
	fi
	$(call install_agent,$(WATCHDOG_LABEL),$(WATCHDOG_LOG))

watchdog-teardown: ## Unload and remove the watchdog LaunchAgent (leaves the ledger alone)
	@# Deliberately does NOT delete the ledger: the reboot budget and the latch
	@# counter live there, and a teardown/setup cycle that reset them would be a
	@# way to launder a latch a human was supposed to clear.
	$(call teardown_agent,$(WATCHDOG_LABEL))

watchdog-status: ## Evaluate the ladder once and print the decision WITHOUT persisting or acting
	@LINEWATCH_WATCHDOG_ONCE=1 bun run collector/watchdog.ts

watchdog-state: ## Print the ledger: budgets, the latch, any write-ahead entry
	@if [ ! -f "$(WATCHDOG_STATE)" ]; then echo "  · no ledger yet at $(WATCHDOG_STATE) — nothing has run"; else python3 -m json.tool "$(WATCHDOG_STATE)"; fi
	@if [ -f "$(WATCHDOG_DISARM)" ]; then echo "  ! DISARMED by $(WATCHDOG_DISARM):"; cat "$(WATCHDOG_DISARM)"; fi

watchdog-logs: ## Tail the watchdog log (the previous generation is the same path + .1)
	@touch "$(WATCHDOG_LOG)"
	@if [ -f "$(WATCHDOG_LOG).1" ]; then echo "  · older window kept at $(WATCHDOG_LOG).1"; fi
	tail -f "$(WATCHDOG_LOG)"

watchdog-disarm: ## Stand the watchdog down NOW (one file; survives restarts; the phone-in-the-seconds-the-link-is-up escape)
	@mkdir -p "$(TOKEN_DIR)"
	@printf 'disarmed at %s\n' "$$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$(WATCHDOG_DISARM)"
	@chmod 600 "$(WATCHDOG_DISARM)"
	@echo "  ✓ disarmed — every rung refuses until 'make watchdog-arm'. The agent keeps running and reporting."

watchdog-arm: ## Clear the disarm file (does NOT arm the agent — that is LINEWATCH_WATCHDOG_ARMED in the plist)
	@# Two different switches, and conflating them would be dangerous. This
	@# clears a human's explicit stand-down. Whether the agent may act at all is
	@# LINEWATCH_WATCHDOG_ARMED in the plist, which shadow mode leaves unset.
	@rm -f "$(WATCHDOG_DISARM)"
	@echo "  ✓ disarm file cleared"
	@if launchctl print gui/$$(id -u)/$(WATCHDOG_LABEL) 2>/dev/null | grep -q 'LINEWATCH_WATCHDOG_ARMED'; then \
		echo "  ! the agent is ARMED — authorised rungs will be performed"; \
	else \
		echo "  · the agent is in SHADOW mode — it will report what it would do and do nothing"; \
	fi

watchdog-readiness: ## Measure the conditions for arming: poll coverage, p90 spacing, shadow output
	$(REQUIRE_UP)
	@# These are docs/watchdog-spec.md §6's arming conditions, measured rather
	@# than remembered. The binding one is poll coverage: a watchdog whose
	@# authority exceeds its instrumentation fails exactly when the router is
	@# stressed, which is when it is needed.
	@echo "  Arming conditions over the last 48h"
	@echo "  -----------------------------------"
	@# One statement, not several: sqlite3 scopes a WITH clause to the statement
	@# it heads, so a second `select` referencing the CTE fails with "no such
	@# table" - which it did, silently reporting only the first line.
	@docker exec linewatch sqlite3 -readonly $(DB) "\
		with gaps as (select (ts - lag(ts) over (order by ts))/1000 g from router_line_sample where ts > (strftime('%s','now')-172800)*1000), \
		     ranked as (select g, row_number() over (order by g) r, count(*) over () n from gaps where g is not null) \
		select 'poll coverage        ' || round(100.0 * (select count(*) from ranked) / (172800.0/600), 1) || '%  (want >= 80%)' \
		union all select 'p90 poll spacing     ' || coalesce((select g from ranked where r = cast(0.9*n as int)), -1) || 's  (want <= 1200s)' \
		union all select 'worst poll gap       ' || coalesce((select max(g) from ranked), -1) || 's' \
		union all select 'shadow would_* notes ' || (select count(*) from event where kind='note' and ts > (strftime('%s','now')-172800)*1000 and detail like '%would\_%' escape '\\') || '  (read every one before arming)' \
		union all select 'watchdog notes       ' || (select count(*) from event where ts > (strftime('%s','now')-172800)*1000 and detail like '%\"source\":\"watchdog\"%') \
		union all select 'reboots recorded     ' || (select count(*) from event where kind='intervention' and ts > (strftime('%s','now')-172800)*1000 and detail like '%router\_reboot%' escape '\\');"
	@echo "  -----------------------------------"
	@echo "  Still manual: the mini's LAN address pinned by DHCP reservation, and a human"
	@echo "  agreeing with every would_* trigger. 'make watchdog-state' shows the budgets."


check: ## Install (frozen), format check, lint, typecheck (API + collector, then the dashboard) + run the test suite
	bun install --frozen-lockfile
	cd web && bun install --frozen-lockfile
	bun run format:check
	bun run lint
	cd web && bun run lint
	bun run typecheck
	@# The root tsconfig's `include` is src/collector only, so the dashboard needs
	@# its own pass — it has different lib/jsx settings and a generated route tree.
	@# Without this, a broken web/ typechecks clean and only fails at image build.
	cd web && bun run typecheck
	@# Two packages, two installs, so two scoped runs. A bare `bun test` at the root
	@# walks into web/ as well, which passes here only because a previous `cd web &&
	@# bun install` left web/node_modules on this machine — CI's api job installs the
	@# root package alone, and the dashboard's render tests import react-dom, @mantine
	@# and @tanstack/react-query. Scope the filter with `./src ./collector`, not
	@# `src collector`: bun matches those as path substrings and `src` also selects
	@# web/src.
	bun test ./src ./collector
	cd web && bun test

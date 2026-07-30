.PHONY: help up down rebuild logs collector-setup collector-teardown collector-logs check
.DEFAULT_GOAL := help

REPO_DIR      := $(shell pwd)
LAUNCHAGENTS  := $(HOME)/Library/LaunchAgents
TOKEN_DIR     := $(HOME)/.config/linewatch
TOKEN_FILE    := $(TOKEN_DIR)/token
LOG_DIR       := $(HOME)/Library/Logs
COLLECTOR_LOG := $(LOG_DIR)/linewatch-collector.log
PLIST_LABEL   := com.jkrumm.linewatch-collector

help: ## Show targets
	@awk 'BEGIN{FS=":.*##"; printf "Targets:\n"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up: ## Ensure the bearer token + .env exist, build, and (re)start the stack. Safe to re-run any time.
	@mkdir -p "$(TOKEN_DIR)"
	@if [ ! -f "$(TOKEN_FILE)" ]; then \
		openssl rand -hex 32 > "$(TOKEN_FILE)"; \
		chmod 600 "$(TOKEN_FILE)"; \
		echo "  ✓ generated bearer token at $(TOKEN_FILE)"; \
	fi
	@TOKEN=$$(cat "$(TOKEN_FILE)"); \
	if [ -f .env ]; then grep -vE '^LINEWATCH_(TOKEN|UID|GID)=' .env > .env.tmp || true; else : > .env.tmp; fi; \
	printf 'LINEWATCH_TOKEN=%s\n' "$$TOKEN" >> .env.tmp; \
	printf 'LINEWATCH_UID=%s\n' "$$(id -u)" >> .env.tmp; \
	printf 'LINEWATCH_GID=%s\n' "$$(id -g)" >> .env.tmp; \
	mv .env.tmp .env; \
	chmod 600 .env
	@# The container runs as this UID/GID (docker-compose.yml `user:`) so it can
	@# write the bind-mounted SQLite file without the directory being world-
	@# writable.
	@mkdir -p data
	docker compose build
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

collector-logs: ## Tail the native collector's log
	@touch "$(COLLECTOR_LOG)"
	tail -f "$(COLLECTOR_LOG)"

check: ## Typecheck + run the test suite
	bun run typecheck
	bun test

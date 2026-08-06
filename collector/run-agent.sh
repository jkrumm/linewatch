#!/bin/bash
# Launch a linewatch agent's Bun entrypoint.
#
# WHY THIS EXISTS — do not "simplify" the plists back to calling bun directly.
#
# macOS Background Task Management attributes a LaunchAgent to the CODE SIGNING
# IDENTITY of ProgramArguments[0]. Point a plist straight at /opt/homebrew/bin/bun
# and BTM records Bun's signer as the agent's Parent Identifier and can mark the
# job [enabled, disallowed] — at which point launchd skips it SILENTLY at login:
# no error, no log line, nothing in the job's own StandardErrorPath, because the
# job is never considered. Measured on the Mac mini 2026-08-06:
#
#     com.jkrumm.linewatch-collector   Parent Identifier: Jarred Sumner      -> disallowed
#     com.jkrumm.sideclaw-server       Parent Identifier: Unknown Developer  -> allowed
#
# argv[0] being an unsigned shell script attributes to "Unknown Developer",
# which BTM allows. That is the entire job of this file.
#
# This also supersedes the earlier diagnosis of the 2026-08-01 no-show (a launchd
# per-user "disabled override", addressed with `launchctl enable`). That is a
# DIFFERENT database from BTM: `launchctl enable` cannot clear a BTM disallow, so
# it never fixed this and the agent kept coming back late via KeepAlive rescue
# (+2m48s after boot on 2026-08-01, +3m06s/+3m42s observed for sideclaw) rather
# than at RunAtLoad. The enable call is kept as cheap idempotent insurance.
#
# LINEWATCH_BUN is set by the plist (rendered from `command -v bun` by the
# Makefile) so bun's location stays resolved in one place rather than hardcoded
# here.
set -euo pipefail

BUN="${LINEWATCH_BUN:-}"
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  echo "run-agent.sh: LINEWATCH_BUN is unset or not executable: '${BUN}'" >&2
  exit 1
fi

exec "$BUN" run "$@"

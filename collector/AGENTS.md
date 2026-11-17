# collector — Agent Instructions

Read this before changing anything under `collector/`. The native collector, heartbeat and
watchdog are launchd agents; a change here reaches the mini through their `make *-setup`
targets. The whole-system picture is in the root [`AGENTS.md`](../AGENTS.md) (§Shape).

The collector POSTs batches with a bearer token and **spools to
`collector/spool.jsonl` on failure**, replaying on the next successful cycle. Do
not "simplify" the spool away — without it every redeploy writes a fake outage
into the record. The logic lives in `collector/spool.ts` (pure, tested): torn lines
and non-retryable 4xx batches (all but 401/408/429) go to `spool.rejected.jsonl`
instead of blocking the queue, and replay is capped at 200 entries per cycle.

**The watchdog is armed for the reconnect rung only (2026-11-15), and its switches are
load-bearing.** `LINEWATCH_WATCHDOG_ARMED` in the plist decides whether an authorised
rung is *performed*; without it the machine still walks the whole ladder and writes
notes, which is what shadow mode was. `LINEWATCH_WATCHDOG_REBOOT` is a separate switch
and is **off**: the reboot needs a line reading under 60 s old and, at a 10-minute poll
cadence, two successful polls, so it waits for coverage ≥80%
(`docs/watchdog-spec.md` section 6 has the numbers and the procedure).
`LINEWATCH_ROUTER_WRITE` in the app's plist decides whether the executor
can reach the device at all, and the watchdog **reads that capability from
`GET /api/router` rather than assuming it** — the two processes are configured
separately, so guessing would make a shadow run report actions that never
happened. `make watchdog-readiness` measures the arming conditions;
`make watchdog-disarm` is the stand-down, one file, `touch`-able from a phone
in the seconds the link is up.

The ledger lives at `~/.local/state/linewatch/watchdog-state.json`, **never
beside `spool.jsonl`** — a `git clean` that reset the reboot budget and the
latch is the single failure that turns this into a reboot loop. An unreadable
ledger disarms rather than resets: an empty one has a full budget and no latch,
which is exactly the wrong reading after a crash. `decide()` takes `trusted` as
input; untrusted means no action, no ledger write, and a `down` push every tick. Every state transition lives
in `decide()`, not the runner, because the runner executes for real about once a
month and the tests are the only thing that exercises this monthly code daily.

**Both pushers are bounded; launchd never starts a second instance of a running
job, so one hung call silences a monitor for good** (dotfiles hit a 28 h freeze,
2026-11-06). The heartbeat runs under `jobrun --timeout 45 --every 60` (cadence 60 s;
API read 5 s and push 30 s sit inside it — a loaded Kuma host answers in 7–14 s; a killed run pushes nothing, and silence
is what Kuma alerts on). Its log bound survives jobrun's pipe via
`LINEWATCH_HEARTBEAT_LOG_VIA_JOBRUN=1`. A push Kuma did not accept exits **75**
(EX_TEMPFAIL): `jobs-grade` grades that `undelivered`, not the job failing; no push
URL (1) and crashes stay ordinary failures. The watchdog is a KeepAlive daemon, so
jobrun's deadline does not fit: every `ping` goes through `spawnBounded`
(`collector/bounded-spawn.ts`), and a tick past `LINEWATCH_WATCHDOG_TICK_DEADLINE_MS`
pushes `down` to its own monitor and exits for KeepAlive to restart. A new external
call in either pusher needs its own deadline.

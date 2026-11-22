# linewatch — Agent Instructions

Uptime + throughput history for the home internet line. Mac mini only. The dashboard is the Line page in Argo, which reads this history from ClickHouse. Read
[`docs/DESIGN.md`](docs/DESIGN.md) before changing anything structural — it
carries the measurements the design rests on, not just the design.

Before changing anything under a directory, Read its nested file (an Edit or a shell command there loads nothing):

- Under `collector/`, Read [`collector/AGENTS.md`](collector/AGENTS.md): spool, watchdog arming and ledger, bounded pushers.
- Under `src/`, Read [`src/AGENTS.md`](src/AGENTS.md): API routes and bearer gate, probe, link and wifi records, migrations.
- Under `src/export/` or `src/services/retention.ts`, Read [`src/export/AGENTS.md`](src/export/AGENTS.md): the cursor tail, the backfill line, the retention guards.
- Under `src/services/router/`, Read [`src/services/router/AGENTS.md`](src/services/router/AGENTS.md): the router poller and its only write path.

## The one fact that must not be forgotten

**ICMP inside a container on this host is fabricated.** Colima's NAT answers echo
requests itself, including for RFC 5737 black-hole addresses. Verified
2026-07-30, `--network host` included. Any future "let's simplify by moving the
collector into the container" produces a dashboard that reports perfect uptime
forever and is silently wrong.

TCP connect from a container *is* honest (`192.0.2.1:443` correctly times out),
so a TCP-based probe is the legitimate fallback if ICMP ever becomes awkward.
Throughput through the VM was unaffected, which is why the speed tests once lived in
the container; the API now runs natively too (2026-11-14), so they measure from the
host's own interface and the VM's NAT overhead is out of the number.

## Shape

| Piece | Where | Why |
|-|-|-|
| `collector/{probe,ping-parser,vantage,link-sampler,wifi}.ts` | native, launchd | real ICMP + the host's own vantage + 1 Hz link state + the radio; no npm deps |
| `collector/heartbeat{,-verdict}.ts` | native, launchd, 60 s | pushes the Uptime Kuma heartbeat; its own agent so a dead collector is still reportable |
| `collector/watchdog{,-ladder,-state,-report,-poll-request}.ts` | native, launchd, 15 s | decides and acts on a wedged line; **armed for the reconnect rung since 2026-11-15 and the reboot rung since 2026-11-22**. `-poll-request` asks `POST /api/router/poll` (≥120 s apart) only when the reboot rung is otherwise authorised and `no_fresh_poll` is what blocks it; it never permits a rung |
| `collector/app.ts` → `src/index.ts`: API + SQLite + Ookla + router poll | native, launchd `com.jkrumm.linewatch-app` (`127.0.0.1:7731`) | KeepAlive; the Colima VM held 4–6 GiB of host memory for ~50 MiB of this |

**Alerting is a missed heartbeat, and that is the design.** Uptime Kuma runs on
the homelab, on a different WAN, and the Tailscale ACL has no `tag:homelab →
tag:mac` grant — so it cannot probe this line even in principle. The mini pushes
to it every 60 s (`Home Line - Push`, 240 s to DOWN); a home-line outage severs
the push and the alert leaves the homelab over a WAN the outage does not touch.
Silence means the line or the mini is gone; an explicit `down` push means a
dead collector, unreachable API, stale record or real outage. "Not measuring this
line" (Wi-Fi failover, unknown vantage) pushes nothing, so Kuma's window absorbs
transients and only a sustained stretch alarms. **`GET /api/status`'s own `up`
field cannot be used for this** — no ingest means no outage row can open, so a
dead collector reports a flawless line forever. `collector/heartbeat-verdict.ts`
checks sample freshness for that reason and its tests pin it.

**The database is `~/.local/share/linewatch/linewatch.db`, owned by the native app
— and it must never again be opened from inside a container alongside a host
process.** That pairing corrupted it on 2026-07-30. Read it with `make db-counts` /
`make db-shell`; take snapshots with `make db-backup`.
[`docs/storage.md`](docs/storage.md) has the rule, the corruption, the backup and
restore targets, the 2026-11-14 move out of the `linewatch-data` volume, and
`make rollback-to-container`. The volume stays untouched until 2026-11-21 as the
rollback; `docker-compose.yml` and the `Dockerfile` exist for that and for nothing
else — nothing on the mini starts the container.

## Conventions

- This is a public repo: no real MAC, hostname, ISP name, city, public IP or
  credential in tracked files, fixtures and tests included.

## Validate

`make check` (format, lint, typecheck, `bun test`). A fresh worktree has no `node_modules`: `bun install`
at the root first, or `make check` dies on `tsc: command not found` (exit 127). The ping parser is tested against real
macOS `ping` output fixtures — including the 100%-loss case, where `ping` **exits
non-zero and prints no round-trip summary line**. That is a valid measurement,
not an error; never gate on the exit code.

The only container left is the rollback one: drive it via `make`, never raw `docker`
(the global docker-makefile rule, and a hook enforces it). A fresh worktree cannot
`make up` — the deploy guard refuses a branch other than `master` and a linked worktree,
because the launchd plist points at the directory it was rendered from.

## Deploy

There is **no CD**: `.github/workflows/` holds only `check.yml`, and no rollhook webhook ships
this repo (verified 2026-10-15 — a merged fix stayed undeployed until `make up`). The API, SQLite
store and router poller ship by **`make up` on the mini from an
up-to-date `master` checkout of the main clone**: it installs, renders and
restarts the `com.jkrumm.linewatch-app` launchd job, waits for `/health`, and asks the kernel that
the process on `:7731` runs from this directory and holds the live database. So pull `master`
first; never `make up` from a feature branch, a linked worktree or a dirty tree. A first deploy
after 2026-11-14 on a mini that still has the volume runs `make db-move` once (it chains into `make up`). `make deploy` only prints this. The native collector, heartbeat and
watchdog are launchd agents with their own `make *-setup` / `make *-teardown`; a change under
`collector/` reaches the mini through those.

## Verify & Monitor

- **Health URL:** `http://127.0.0.1:7731/health` — `GET /health`; the app binds
  loopback only. `make verify` curls it and exits non-zero when the app is not
  answering. The app log is `~/Library/Logs/linewatch-app.log` (`make logs`),
  bounded in place at 8 MiB + one `.1` generation by `collector/app.ts`.
- **Uptime Kuma:** the line monitor is `Home Line - Push`, fed every 60 s by
  `collector/heartbeat.ts`, 240 s to DOWN. **Silence is the alert** — it runs on the
  homelab's different WAN, so a severed push is the home-line outage signature. A
  second push monitor, `Home Line - Watchdog`, carries the watchdog's own liveness.
  `make heartbeat-status` prints the verdict without pushing. How the two pushers are bounded: `collector/AGENTS.md`.
- **OTel `service.name`:** `linewatch-app` (namespace `linewatch`), metrics `line.*` and
  log events `line.outage.*`, `line.intervention`, `line.speedtest.failed`, exported by the app
  to the host agent when `LINEWATCH_OTLP_ENDPOINT` is set. ClickHouse is the history; SQLite
  keeps 90 days of samples as the working store of the self-healing chain. The export reads SQLite back and
  is never called from a write path — keep it that way: the watchdog's API must not depend on it.
  What goes out, the backfill and the retention job: [`docs/DESIGN.md`](docs/DESIGN.md) §Export and retention.
  The Uptime Kuma heartbeat above stays the alert surface.

## Gotchas

- **`make logs` is a bounded tail now** (`--tail=200`, then exits). It no longer
  follows; `make logs-follow` does (both read the launchd job's log, not a container's). `make collector-logs` / `heartbeat-logs` /
  `watchdog-logs` are unchanged and still follow their host-side logs.
- **Container ICMP is fabricated** — see "The one fact that must not be forgotten"
  at the top. The collector stays native; a containerised probe reports a flawless
  line forever.

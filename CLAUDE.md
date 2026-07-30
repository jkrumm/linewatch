# linewatch — Claude Code Instructions

Uptime + throughput history for the home internet line. Mac mini only. Read
[`docs/DESIGN.md`](docs/DESIGN.md) before changing anything structural — it
carries the measurements the design rests on, not just the design.

## The one fact that must not be forgotten

**ICMP inside a container on this host is fabricated.** Colima's NAT answers echo
requests itself, including for RFC 5737 black-hole addresses. Verified
2026-07-30, `--network host` included. Any future "let's simplify by moving the
collector into the container" produces a dashboard that reports perfect uptime
forever and is silently wrong.

TCP connect from a container *is* honest (`192.0.2.1:443` correctly times out),
so a TCP-based probe is the legitimate fallback if ICMP ever becomes awkward.
Throughput through the VM is unaffected, so speed tests belong in the container.

## Shape

| Piece | Where | Why |
|-|-|-|
| `collector/probe.ts` | native, launchd | real ICMP; ~150 lines, no npm deps |
| API + SQLite + Ookla + UI | Docker (`:7731`) | restart policy, rollhook CD |

The collector POSTs batches with a bearer token and **spools to
`collector/spool.jsonl` on failure**, replaying on the next successful cycle. Do
not "simplify" the spool away — without it every redeploy writes a fake outage
into the record.

## Boot order trap, already hit once

`src/db/client.ts` runs migrations **at module load**, not from a statement in
`src/index.ts`. ES imports are evaluated before any statement in the importing
module's body, so a `runMigrations()` call at the top of `index.ts` still runs
after every transitively imported module — including
`services/outage-detector-instance.ts`, which queries at module scope. On a fresh
database that ordering crashed the process with `no such table: outage`, and the
test suite did not catch it because tests use a pre-migrated DB. Keep migration
an invariant of importing the client.

## Conventions

- Bearer auth on the two write routes only (`POST /api/probes`,
  `POST /api/speedtests/run`). Reads are open on the tailnet.
- `GET /api/probes` **must** bucket in SQL. Never return raw rows for a long
  range — the table grows ~4.2M rows/year.
- Outages are materialised on write by `services/outage-detector.ts`, not derived
  on read. Single-cycle blips are recorded honestly and filtered in the UI.
- The `event` table is the extension point for router control (TP-Link reconnect,
  LAN↔WLAN failover). Nothing writes `intervention` or `link_change` yet — they
  exist so phase 2 needs no migration.
- The dashboard's fetch layer has a single `USE_MOCK` switch. Keep it working;
  it is how the UI is developed before real data accumulates.

## Validation

`make check` (typecheck + `bun test`). The ping parser is tested against real
macOS `ping` output fixtures — including the 100%-loss case, where `ping` **exits
non-zero and prints no round-trip summary line**. That is a valid measurement,
not an error; never gate on the exit code.

Drive containers via `make`, never raw `docker` (the global docker-makefile rule,
and a hook enforces it).

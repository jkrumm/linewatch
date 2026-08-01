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
| `collector/{probe,ping-parser,vantage,link-sampler,wifi}.ts` | native, launchd | real ICMP + the host's own vantage + 1 Hz link state + the radio; no npm deps |
| `collector/heartbeat{,-verdict}.ts` | native, launchd, 60 s | pushes the Uptime Kuma heartbeat; its own agent so a dead collector is still reportable |
| `collector/watchdog{,-ladder,-state,-report}.ts` | native, launchd, 15 s | decides and acts on a wedged line; **ships in shadow mode** |
| API + SQLite + Ookla + router poll + UI | Docker (`:7731`) | restart policy, rollhook CD |

The collector POSTs batches with a bearer token and **spools to
`collector/spool.jsonl` on failure**, replaying on the next successful cycle. Do
not "simplify" the spool away — without it every redeploy writes a fake outage
into the record.

**Alerting is a missed heartbeat, and that is the design.** Uptime Kuma runs on
the homelab, on a different WAN, and the Tailscale ACL has no `tag:homelab →
tag:mac` grant — so it cannot probe this line even in principle. The mini pushes
to it every 60 s (`Home Line - Push`, 240 s to DOWN); a home-line outage severs
the push and the alert leaves the homelab over a WAN the outage does not touch.
Silence means the line or the mini is gone; an explicit `down` push means
linewatch stopped measuring while the line works. **`GET /api/status`'s own `up`
field cannot be used for this** — no ingest means no outage row can open, so a
dead collector reports a flawless line forever. `collector/heartbeat-verdict.ts`
checks sample freshness for that reason and its tests pin it.

**The watchdog ships disarmed, and both of its switches are load-bearing.**
`LINEWATCH_WATCHDOG_ARMED` in the plist decides whether an authorised rung is
*performed*; without it the machine still walks the whole ladder and writes
`would_*` notes, which is the only thing that makes a shadow run worth its
weeks. `LINEWATCH_ROUTER_WRITE` in the container decides whether the executor
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
which is exactly the wrong reading after a crash. Every state transition lives
in `decide()`, not the runner, because the runner executes for real about once a
month and the tests are the only thing that exercises this monthly code daily.

**The database is in the `linewatch-data` named Docker volume and the host
cannot open it.** Read it with `make db-counts` / `make db-shell`, never by
opening the file — [`docs/storage.md`](docs/storage.md) has the rule, the
corruption that forced it, and the backup/restore targets.

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

- Bearer auth on the five routes that write to the historical record or to the
  line itself: `POST /api/probes`, `POST /api/interventions`, `POST
  /api/router/poll`, `POST /api/router/actions/reconnect` and `POST
  /api/router/actions/reboot`. The last two carry a **second, independent gate**,
  `LINEWATCH_ROUTER_WRITE`, unset by default: the bearer stops someone else
  acting, the capability switch stops *us* — a bad deploy, a watchdog gone
  wrong, a test pointed at the wrong host. Everything
  else is open on the tailnet — including `POST /api/speedtests/run`, which is a dashboard button
  with no token to present and is **rate-limited instead** (429 within
  `speedtestMinIntervalS`, 5 min by default, measured against the newest
  `speed_test` row so a container restart cannot reset it). Saturating the line
  is its only abuse and the limit caps that. `grep -rn hasValidBearer src/` is
  the source of truth; keep this list in sync with it.
- `GET /api/probes` **must** bucket in SQL, and so must any new range route.
  Never return raw rows for a long range — `probe_sample` grows ~4.2M rows/year.
  The router range routes cap with an explicit `limit` instead.
- Outages are materialised on write by `services/outage-detector.ts`, not derived
  on read. Single-cycle blips are recorded honestly and filtered in the UI.
- `probe_cycle` records what each cycle measured **through** — default-route
  interface, path class, negotiated media/link speed/duplex, the NIC's
  *supported* ceiling (`link_max_mbit`, which is what tells a cable fault from a
  100 Mbit adapter), gateway, DHCP lease start, link-sampling coverage, NIC
  error counters. `on_home_line` is three-state: 1 / 0 / **null = unknown**. Never
  coalesce null to 1 on a read path, and never default an unparseable field to a
  plausible value; that fabrication is the exact bug the table exists to prevent.
  `ts` is UNIQUE so a spool replay is idempotent.
- `link_change` events are materialised on write, like outages — by the probe
  ingest when the host-side vantage changes, by the same ingest for each
  sub-cycle transition the collector's 1 Hz link sampler reports
  (`detail.source: "link-sampler"`, de-duplicated by an explicit ts+kind check
  because `event.ts` must never gain a unique index), and by the router poller
  from the carrier side. **1 Hz resolves transitions of ~2 s and longer: no
  recorded transition means none was observed above that resolution, never that
  the link was stable.** `intervention` is written by `POST /api/interventions`.
  All four `event` kinds are now written. `config_change` records container
  starts, so a deploy stops being indistinguishable from the router refusing to
  answer; `note` carries poller telemetry (non-clean polls only — a clean poll
  evidences itself in the rows it stored, and one note per poll would be 52k
  rows a year in the table the UI timeline reads).
- `wifi_sample` records the radio every 10th cycle (5 min — `system_profiler
  SPAirPortDataType` costs 4.8 s median, so per-cycle is not affordable). Call
  it **an alternate radio path currently attached**, never "the standby path":
  the service order puts a cellular hotspot above Wi-Fi, and Wi-Fi is only the
  effective alternate because no cellular device is attached today. `ssid`,
  `bssid`, `mac`, `security`, `country_code`, neighbour rows and a stored `snr`
  are deliberately absent and must stay absent; the parser reads only the
  connected interface's `Current Network Information` block and stops at `Other
  Local Wi-Fi Networks`. `tx_rate_mbps` is a PHY/MCS rate, not throughput — no
  verdict may call the radio faster than the wire off it (measured: 9.99 ms RTT
  on Wi-Fi vs 5.24 ms on Ethernet).
- The router **poller** is read-only, and writes live in one place:
  `services/router/actions.ts`, off unless `LINEWATCH_ROUTER_WRITE=1`. A reboot
  reports **three** outcomes, not two: `executed` when the device acknowledged,
  `failed` when it rejected the operation (HTTP 200, `errorcode: 1` — the
  firmware validates the operation before acting, which is what makes a wrong
  name distinguishable from a successful reboot), and `unknown` when the
  transport died, which is the expected signature of success and is settled only
  by the probe record. Never read `unknown` as either. That
  module is the only thing in this repo that can write to the device, and its
  surface is deliberately tiny. The reason is not style: `/js/gdprProxy.js`
  routes every verb — `go`/`gl`/`gs`/`so`/`ao`/`do`/`op`/`cgi` — to the same
  `/cgi_gdpr?9` with the verb inside an AES-encrypted body, so **no firewall,
  proxy or URL rule can tell a line-statistics read from a factory reset**. Code
  is the only layer where that distinction can exist. So the OID never crosses a
  module boundary: `sendAction` takes one of four *intents*, the intent→operation
  map is module-private and frozen, membership is asserted at runtime at the
  single send site, and a test greps the module for destructive operation names.
  Do not add `act(oid: string)`; it would put all eight read call sites one
  argument from an action, and the factory-reset constants are declared five
  lines from the PPP ones in the router's own JavaScript.
- **The `ACT_*` names in that JavaScript are identifiers, not the strings they
  stand for.** `var ACT_OP_PPP_CONN = "ACT_PPP_CONN"` — the whole family drops
  `_OP` between name and value. Sending the identifier gets HTTP 200 with
  `errorcode: 1`, measured. The same fact settles the reboot name that read as
  ambiguous across two firmware pages.
- No schema table stores a MAC — **or a device name**: `router_host.host_name` was dropped in
  migration 0005 because a fifth of the stored names were vendor defaults of the
  form prefix + 12 hex digits, i.e. a MAC with its separators stripped, which no
  value-level MAC pattern catches. `parseHosts` does not read the field and
  `redact.ts` blanks name-shaped keys; do not add either back. **Dropping the
  column does not erase what it held** — SQLite returns the old pages to the
  freelist without zeroing them, so the values stay recoverable from the file and
  its WAL until `make db-vacuum` runs. Migration 0005 is only half the fix; the
  vacuum is the other half, and it has to run after the migration has applied.
- The router poller logs in **fresh every poll** (cadence from
  `LINEWATCH_ROUTER_CRON`, 10 min by default) and never repairs a held session:
  holding it meant an eviction started a 15-minute re-login backoff that
  swallowed the next three polls, measured at 20 of 55 due polls stored. Do not
  reintroduce a session kept alive between polls "to be polite" — a failed login
  must stay a missing sample, never a carried-forward reading.
- This is a public repo: no real MAC, hostname, ISP name, city, public IP or
  credential in tracked files, fixtures and tests included.
- The dashboard's fetch layer has a single `USE_MOCK` switch. Keep it working;
  it is how the UI is developed before real data accumulates.

## Validation

`make check` (typecheck + `bun test`). The ping parser is tested against real
macOS `ping` output fixtures — including the 100%-loss case, where `ping` **exits
non-zero and prints no round-trip summary line**. That is a valid measurement,
not an error; never gate on the exit code.

Drive containers via `make`, never raw `docker` (the global docker-makefile rule,
and a hook enforces it).

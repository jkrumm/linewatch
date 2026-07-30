# linewatch — design

Historical record of one internet connection: is it up, when did it drop, how
long for, and what throughput does it actually deliver. Runs on the Mac mini,
the only always-on machine on this line.

STATUS: v1 in progress (2026-07-30)

## Why this exists rather than a container off the shelf

Speedtest Tracker and MySpeed both cover the speed half well. Neither covers the
uptime half: Speedtest Tracker's ping monitoring is still on its roadmap, and
MySpeed's health checks only fire per speed test — an outage between two hourly
tests leaves no trace in either. Outage detection needs a 30-second cadence;
speed testing at that cadence would saturate the line permanently. Two
cadences, one store, one dashboard.

SmokePing has the right data model for the uptime half and it is copied here
directly: N rapid samples per cycle, stored as median + spread + loss fraction,
so a graph shows jitter as a band rather than a single averaged line that hides
the interesting part.

## The constraint that shapes everything

**ICMP does not work inside a container on this host.** Colima's NAT answers
echo requests itself instead of forwarding them. Measured 2026-07-30:

```
$ docker run --rm alpine fping -C 4 -q 1.1.1.1 192.0.2.1
1.1.1.1   : 0.114 0.354 0.485 0.580
192.0.2.1 : 0.088 0.211 0.483 0.338     # RFC 5737 black hole. Cannot reply.
```

`--network host` behaves identically. A SmokePing container here would have
drawn a flawless 100%-uptime graph forever, which is worse than no graph.

What *does* work in a container, measured the same day:

| Path | Verdict | Evidence |
|-|-|-|
| Throughput | Unaffected | 63.7 MB/s in container vs 61.9 MB/s native, same 100 MB download |
| TCP connect | Honest | `1.1.1.1:443` → 4.5 ms, matching native ICMP RTT; `192.0.2.1:443` times out |
| ICMP | Fabricated | see above |

So the collector runs natively under launchd and everything else runs in Docker.
That split is the whole architecture.

## Shape

```
launchd (native, macOS)              Docker (Colima)
┌────────────────────────┐          ┌──────────────────────────────┐
│ collector/probe.ts     │  POST    │ Elysia API : 7731            │
│  ping ×20 per target   │ ───────► │  ingest → outage state machine│
│  30s cycle             │  batch   │  Ookla CLI, hourly            │
│  spools on failure     │          │  SQLite (Drizzle)             │
└────────────────────────┘          │  static UI (basalt-ui + visx) │
                                    └──────────────────────────────┘
```

The collector is the only native piece: ~410 lines across `probe.ts` and
`ping-parser.ts`, no npm dependencies beyond the system `ping`, and it changes
rarely. Most of `ping-parser.ts` is parsing that output, kept as a pure module
with fixture tests. Everything with a reason to change — schema, detection
logic, API, dashboard — stays in the container with a restart policy and
rollhook deployment.

**The collector spools.** If the API is down (redeploy, container restart) it
appends batches to `collector/spool.jsonl` and replays them on the next
successful cycle. A deploy must not punch a hole in the uptime record — that
hole would read as an outage, which is precisely the thing being measured.

## Targets

| Name | Address | Purpose |
|-|-|-|
| `gateway` | 192.168.1.1 | Distinguishes "router down" from "WAN down" |
| `cloudflare` | 1.1.1.1 | WAN anchor |
| `google` | 8.8.8.8 | WAN anchor |
| `quad9` | 9.9.9.9 | WAN anchor |

Three WAN anchors on three different networks so a single provider's outage or
ICMP deprioritisation cannot register as a local outage. A WAN outage requires
**all three** to fail in the same cycle.

Baseline on this line, 2026-07-30: 4.18 ms avg to 1.1.1.1, 0% loss, 0.62 ms
stddev over 30 packets.

## Cadence

- **Probe cycle: 30 s.** 20 pings at 200 ms spacing per target = ~4 s of
  probing, then idle. Gives 30-second outage resolution.
- **Speed test: hourly.** Ookla CLI, ~250 MB–1 GB of traffic per run.

Volume: 4 targets × 2880 cycles/day = 11.5k rows/day, ~4.2M/year. SQLite is
comfortable there with the right indexes. Rollup and pruning are deferred until
the table is large enough to matter — noted, not built.

## Schema

The database file lives in the `linewatch-data` Docker volume and the host may
never open it — [`storage.md`](storage.md) has the rule, the corruption it
replaced, and the `make db-*` targets that reach it.

`probe_sample` — one row per target per cycle.

| Column | Type | Note |
|-|-|-|
| `id` | integer pk | |
| `ts` | integer | unix ms, cycle start |
| `target` | text | `gateway` \| `cloudflare` \| … |
| `addr` | text | resolved address actually probed |
| `sent`, `received` | integer | |
| `loss_pct` | real | |
| `min_ms`, `med_ms`, `max_ms`, `avg_ms`, `jitter_ms` | real, nullable | null when 100% loss |
| `samples` | text, nullable | JSON array of RTTs — the smoke band |
| `duplicates` | integer, nullable | `+N duplicates,` from ping's summary; makes `samples` longer than `received` |
| `out_of_wait_time` | integer, nullable | replies that arrived after `-W`: counted in `received`, never timed, so this row's min/med/max/jitter are a floor |

Both are nullable rather than `default 0`: null means the collector that wrote
the row did not report the number, which is what every row predating the
clause-by-clause ping parser is. A 0 there would claim it was measured.

Indexes: `(target, ts)`, `(ts)`.

`outage` — written by the state machine on ingest, not derived on read.

| Column | Type | Note |
|-|-|-|
| `id` | integer pk | |
| `scope` | text | `wan` \| `gateway` |
| `started_at` | integer | |
| `ended_at` | integer, nullable | null while ongoing |
| `duration_s` | integer, nullable | |
| `cycles` | integer | failing cycles observed |
| `evidence` | text | JSON: which targets failed |

Materialised because "when did it drop and for how long" is the primary
question and it should answer instantly, not scan 4M rows. Single-cycle blips
are recorded honestly and filtered in the UI rather than swallowed at write
time.

`speed_test`

| Column | Type | Note |
|-|-|-|
| `id` | integer pk | |
| `ts` | integer | |
| `backend` | text | `ookla` \| `cloudflare` |
| `ok` | integer | 0/1 |
| `download_mbps`, `upload_mbps` | real, nullable | |
| `ping_ms`, `jitter_ms` | real, nullable | idle latency |
| `latency_down_ms`, `latency_up_ms` | real, nullable | **loaded** latency — bufferbloat |
| `packet_loss` | real, nullable | |
| `server_name`, `server_location`, `server_id` | text, nullable | |
| `isp`, `external_ip` | text, nullable | |
| `bytes_down`, `bytes_up` | integer, nullable | |
| `result_url` | text, nullable | |
| `duration_s` | real, nullable | |
| `error` | text, nullable | |

Loaded latency is the reason to prefer the Ookla CLI over a plain download
benchmark. It is the number that shows whether a router change fixed
bufferbloat, and it is the one the FRITZ!Box-era line is most likely to be bad at.

`event` — the extension point.

| Column | Type | Note |
|-|-|-|
| `id` | integer pk | |
| `ts` | integer | |
| `kind` | text | `intervention` \| `link_change` \| `config_change` \| `note` |
| `detail` | text | JSON |

Nothing writes `intervention` or `link_change` in v1. They exist so that phase 2
— TP-Link reconnect, LAN↔WLAN failover, forced re-dial — can correlate an
action against the recovery it caused without a migration.

## API

Bearer token on writes; reads are open on the tailnet.

| Route | Purpose |
|-|-|
| `GET /health` | container healthcheck |
| `POST /api/probes` | batch ingest from the collector (bearer) |
| `GET /api/status` | now: up/down, ongoing outage, last sample per target, last speed test |
| `GET /api/probes?from&to&target&bucket` | server-bucketed timeseries: median of medians, aggregate and worst-cycle loss, p5/p95 band |
| `GET /api/outages?from&to&minDuration` | list |
| `GET /api/speedtests?from&to` | list |
| `GET /api/speedtests/summary?days` | p50/p95 down/up, best, worst |
| `POST /api/speedtests/run` | trigger one now (bearer) |
| `GET /api/events?from&to` | timeline overlay |

Bucketing happens in SQL. The dashboard must never pull 4M rows to draw a year.

The token lives in a chmod-600 `~/.config/linewatch/token`, generated at setup
— the same pattern as the Uptime Kuma push URL, and for the same reason: it
must not depend on the secrets cache being seeded, or a stale cache takes
monitoring down with it.

## Dashboard

basalt-ui (Mantine v9) + visx, per the `/dataviz` conventions. Four views:

- **Now** — current state, ongoing outage if any, last speed test, 24 h sparkline.
- **Uptime** — outage list plus a day/hour availability heatmap. The headline
  number is total downtime per period, not a 99.x% figure; on a home line the
  percentage flatters and the minute count informs.
- **Latency** — SmokePing-style band: median line, p5–p95 shaded, loss as colour.
- **Speed** — download/upload over time, hourly heatmap, loaded-vs-idle latency.

## Ports

`7731` — service (API + built UI, one container). `7732` — Vite dev only.

## Known limits, stated rather than discovered later

- **The mini's NIC is 1 GbE** (`media: autoselect (1000baseT`). Fiber above
  1 Gbit to the apartment will read as ~940 Mbit and look like a cap on the
  line. It is a cap on the measurement. Fixing it means a Thunderbolt/USB
  2.5G+ adapter.
- **One vantage point.** This measures the line as the mini sees it over
  Ethernet. It says nothing about Wi-Fi quality in other rooms.
- **Ookla picks a server per run.** Server changes move the numbers
  independently of the line, so `server_id` is stored and the UI flags a change.

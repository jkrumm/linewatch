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
│  30s cycle + vantage   │  batch   │  Ookla CLI, hourly            │
│  spools on failure     │          │  SQLite (Drizzle)             │
└────────────────────────┘          │  static UI (basalt-ui + visx) │
                                    └──────────────────────────────┘
```

The collector is the only native piece: ~870 lines across `probe.ts`,
`ping-parser.ts` and `vantage.ts`, no npm dependencies, and nothing shelled out
to beyond the system `ping`, `route`, `ifconfig`, `netstat` and `networksetup`.
Most of it is parsing their output, kept in pure modules with fixture tests.
Everything with a reason to change — schema, detection logic, API, dashboard,
and the 5-minute read-only router poll — stays in the container with a restart
policy and rollhook deployment.

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

Indexes: `(target, ts)`, `(ts)`.

`probe_cycle` — what the cycle measured *through*. One row per cycle, not per
target.

| Column | Type | Note |
|-|-|-|
| `id` | integer pk | |
| `ts` | integer, **unique** | same cycle start as the cycle's `probe_sample` rows |
| `path_if` | text, nullable | interface carrying the default route, e.g. `en0` |
| `path_class` | text, nullable | `ethernet` \| `wifi` \| `cellular` \| `other` |
| `link_media` | text, nullable | raw media token as printed, e.g. `1000baseT` |
| `link_mbit` | integer, nullable | parsed from the token; null when unparseable, never a default |
| `link_duplex` | text, nullable | `full` \| `half` |
| `gateway_addr` | text, nullable | gateway from the default route, not from config |
| `if_ierrs`, `if_oerrs`, `if_coll` | integer, nullable | cumulative `netstat` counters, not per-cycle deltas |
| `on_home_line` | integer, nullable | 1 / 0 / null = **unknown** |

Index: unique `(ts)`.

Per cycle rather than per sample for two reasons. The vantage is a property of
the cycle, so columns on `probe_sample` would repeat it four times across the
~4.2M rows/year that table grows by. And `ts` is UNIQUE because the collector
spools failed batches and replays them verbatim, so ingest has to be idempotent
— a replay must not append a second vantage row for an instant already on
record.

Everything except `id`/`ts` is nullable, and that is load-bearing rather than
lax. The collector is native under launchd and the API is in Docker, so they
deploy independently: a collector predating a field must still write a valid
row, and the 945 rows recovered from the 2026-07-30 corruption have no vantage
to claim. Unparseable is `null`. A fabricated `1000` for `link_mbit` or an
assumed `ethernet` for `path_class` is exactly the lie this table was added to
prevent, because it reads as measured.

`on_home_line` is three-state on purpose: 1 = Ethernet *and* the configured home
gateway, 0 = anything else, null = not reported. Read paths must treat null as
unknown and never coalesce it to 1. The server re-derives the verdict from
`path_class` + `gateway_addr` whenever both are present and takes the stricter of
its own and the collector's — which gateway is home is server config, so the
server gets the last word.

A change in `path_if`, `path_class`, `link_mbit` or `link_duplex` between
consecutive cycles materialises an `event` of kind `link_change` at ingest, the
same architecture as `outage`: written once on write, never recomputed on read.
`null` on either side of the diff is *unknown*, not a value, so a collector
gaining or losing the ability to report a field is silence rather than a
fabricated link change. The router poller writes `link_change` rows too, from
the carrier side.

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

Two of the four kinds are now written. `link_change` is materialised on write —
by the probe ingest when the host-side vantage changes, and by the router poller
when the carrier side does. `intervention` is written by `POST
/api/interventions`, which exists for attribution: without it a recovery two
minutes after a power-cycle is indistinguishable from one that would have
happened anyway, and the record silently credits the ISP for a fix that was a
human with a plug.

`config_change` and `note` are still unwritten. They stay so that phase 2 —
TP-Link reconnect, LAN↔WLAN failover, forced re-dial — can land without a
migration.

Four more tables hold the carrier-side view, written by the read-only router
poller every 5 minutes. They answer *why* a line is slow, which no amount of
probing from the host can.

| Table | Holds |
|-|-|
| `router_line_sample` | sync and current rates, noise margin, attenuation, profile, showtime seconds, errored seconds |
| `router_intf_sample` | per-interface rx/tx kbps and cumulative byte counters, one row per interface per poll |
| `router_eth_port` | each LAN port's negotiated status, max bit rate and duplex |
| `router_host` | which hosts were connected, for an outage's blast radius |

Neither `router_eth_port` nor `router_host` carries a MAC column. The port alias
already identifies the port, so a MAC would buy nothing and leak a stable device
identifier out of a public repo.

## API

Bearer token on the two routes that write to the historical record, and so are
the two worth forging: `POST /api/probes` and `POST /api/interventions`.
Everything else is open on the tailnet, including `POST /api/speedtests/run`: it
is a dashboard button with no token to present, and its only abuse is saturating
the line, which a 5-minute rate limit caps more usefully than a shared secret
would. The limit is enforced against the newest `speed_test` row, not an
in-process timer, so restarting the container cannot reset the budget.

| Route | Purpose |
|-|-|
| `GET /health` | container healthcheck |
| `POST /api/probes` | batch ingest from the collector: one cycle, one sample per target, plus the optional `cycle` vantage (bearer) |
| `GET /api/status` | now: up/down, ongoing outage, last sample per target, last speed test, latest vantage |
| `GET /api/probes?from&to&target&bucket` | server-bucketed timeseries: median of medians, max loss, p5/p95 band, plus a parallel per-bucket `vantage` series |
| `GET /api/outages?from&to&minDuration` | list, plus a range `summary` when both bounds are given |
| `GET /api/speedtests?from&to` | list |
| `GET /api/speedtests/summary?days` | p50/p95 down/up, best, worst |
| `POST /api/speedtests/run` | trigger one now (no bearer; 429 within 5 min of the last run) |
| `GET /api/events?from&to` | timeline overlay |
| `POST /api/interventions` | record a manual action — power-cycle, cable swap — as an `intervention` event (bearer) |
| `GET /api/router` | latest line sample, WAN/LAN throughput, collector host, LAN ports |
| `GET /api/router/line?from&to&limit` | carrier line history: sync rates, noise margin in real dB, attenuation, showtime |
| `GET /api/router/throughput?from&to&role&limit` | per-interface rates, `role=wan` for the live internet-facing one |

Bucketing happens in SQL. The dashboard must never pull 4M rows to draw a year.

Ingest is idempotent on the cycle `ts`, because the spool replays batches
verbatim: an already-ingested `ts` returns `skipped: true` and writes nothing,
and `probe_cycle.ts` is UNIQUE so a replayed vantage cannot duplicate either.

Two read shapes exist because a bucket can lie by omission. The `vantage` series
on `GET /api/probes` reports, per bucket, every distinct path class and link
speed seen and an `onHomeLine` verdict of `all` / `none` / `mixed` / `unknown` —
never a majority vote, so a bucket that mixed Ethernet and Wi-Fi says so. The
`summary` on `GET /api/outages` reports `recordedCycles` against
`expectedCycles`: "24 h, 0 min downtime" over a database missing six of those
hours is the most expensive lie this service could tell, and coverage is what
catches it. It also counts `degradedCycles` — cycles losing at least
`LINEWATCH_DEGRADED_LOSS_PCT` (default 20%) that no outage row covers, because
the outage machine only fires when *nothing* comes back.

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
- **The vantage is measured, not assumed — and it says nothing about other
  rooms.** This document used to claim "one vantage point: the line as the mini
  sees it over Ethernet", stated as a static fact. It is a time-varying measured
  property, and the wrong version of it was itself the bug: it made every
  `probe_sample` row *implicitly* the home line over Ethernet, so five different
  situations were indistinguishable — WAN down, gateway down, `en0` renegotiated
  to 100baseTX (a throughput cap, not an outage), failover to Wi-Fi, and failover
  to cellular, which is not this line at all. The last is real on this host: its
  service order carries two cellular egresses, a hotspot and iPhone USB
  tethering. `probe_cycle` now records per cycle the default-route interface,
  path class, negotiated media/duplex/link speed, gateway, NIC error counters,
  and the three-state `on_home_line`. What remains true is the narrow part: one
  host, one point on the LAN. Wi-Fi quality in other rooms is still unmeasured.
- **Ookla picks a server per run.** Server changes move the numbers
  independently of the line, so `server_id` is stored and the UI flags a change.

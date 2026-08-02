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
and the 10-minute read-only router poll — stays in the container with a restart
policy and rollhook deployment.

**The collector spools.** If the API is down (redeploy, container restart) it
appends batches to `collector/spool.jsonl` and replays them on the next
successful cycle. A deploy must not punch a hole in the uptime record — that
hole would read as an outage, which is precisely the thing being measured.

**The collector bounds its own log, in place.** `~/Library/Logs/linewatch-collector.log`
grows ~400 KB/day and is not disposable — 106 silently dropped vantage payloads
were visible only there, in what the collector logged it had sent. It rotates at
8 MiB keeping one previous generation (≤16 MiB, 21–42 days of history) by copying
to `.log.1` and truncating the live file rather than renaming it: launchd opens
`StandardOutPath` once with `O_APPEND` and never reopens it (verified with `lsof
+fg` — `1u REG R,W,AP`), so `newsyslog`, which rotates by rename, would leave the
collector writing into the renamed inode and the visible log frozen at zero.

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

That diff compares 30 s snapshots, so a flap that restores to the same media
token is invisible to it by construction — macOS logged a continuous 14.3 s
`hasLink: false` on en0 inside a recorded 90 s WAN outage while the `event`
table stayed empty. The collector therefore also samples `ifconfig <path_if>`
at 1 Hz (1.71 ms per spawn, 0.17 % of one core) and ships the transitions with
the cycle, where they become `link_change` rows carrying `detail.source:
"link-sampler"`. `link_watch_s` records how many seconds of that cycle were
actually sampled — null when the collector runs no sampler. **1 Hz resolves
transitions of roughly 2 s and longer, so no recorded transition means "none
longer than the sampling resolution was observed", never "the link was
stable".**

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
by the probe ingest when the host-side vantage changes, by the same ingest for
each sub-cycle transition the collector's 1 Hz sampler reports, and by the
router poller when the carrier side does. `detail.source` is what tells them
apart — `vantage-diff`, `link-sampler`, `router-poller` — and `GET /api/events`
lifts it out of the JSON for that reason. It is not a byline: the three observe
the same kind of fact from three distances (somewhere in the preceding 30 s
cycle, the transition itself to ~1 s, the carrier's side up to a poll interval
late), so a timeline showing them in one timestamp column without naming the
source claims a precision two of them do not have. A row written before the
field existed carries none, and is left unlabelled rather than attributed to the
likeliest writer. `event.ts` deliberately carries no unique index — interventions legitimately
share a timestamp — so replayed sampler transitions are de-duplicated by an
explicit ts+kind check at ingest instead. `intervention` is written by `POST
/api/interventions`, which exists for attribution: without it a recovery two
minutes after a power-cycle is indistinguishable from one that would have
happened anyway, and the record silently credits the ISP for a fix that was a
human with a plug.

`wifi_sample` — the radio, every 10th cycle (5 min).

| Column | Type | Note |
|-|-|-|
| `id` | integer pk | |
| `ts` | integer, **unique** | cycle start; unique so a spool replay is idempotent |
| `iface` | text, nullable | the interface the sample was taken *through* |
| `status` | text, nullable | `Connected` \| `Not Connected` \| …, verbatim |
| `phy_mode`, `band` | text, nullable | e.g. `802.11ax`, `2GHz` |
| `channel`, `width_mhz`, `rssi_dbm`, `noise_dbm`, `mcs_index` | integer, nullable | |
| `tx_rate_mbps` | real, nullable | negotiated PHY/MCS rate — **not** throughput |
| `rtt_med_ms`, `loss_pct` | real, nullable | from a ping bound to `iface` |

Five minutes rather than 30 seconds because `system_profiler SPAirPortDataType`
costs 4.8 s median here (six runs, 4.63–4.95 s), 2.4× the vantage capture's
per-command budget; `-detailLevel mini` saves nothing and drops Signal/Noise,
Transmit Rate, MCS Index and Channel outright. 288 rows/day, ~105k/year.

It exists so **an alternate radio path currently attached** is measured rather
than inferred — and that phrasing is the honest one.
`networksetup -listnetworkserviceorder` here ranks Ethernet, then a **mobile
hotspot**, then Wi-Fi; Wi-Fi is the effective alternate today only
because no cellular device is attached, so "the standby path" would name the
wrong hop. Nothing in this table is throughput: `tx_rate_mbps` is a PHY/MCS
rate, and the radio's own round trip measured 9.99 ms against 5.24 ms on
Ethernet.

`ssid`, `bssid`, `mac`, `security`, `country_code`, every neighbour network and
a derived `snr` column are deliberately absent (SNR is computed on read, only
when both sides are non-null). The raw output prints two MAC addresses in the
clear and enumerates every neighbour SSID with its channel and security, so the
parser reads only the connected interface's `Current Network Information` block,
stops at `Other Local Wi-Fi Networks`, and extracts a fixed whitelist of keys.
The SSID currently prints as `<redacted>` only because Location Services is off
— a side effect that can reverse, so the guard is the missing column, not the
redaction. `ifconfig -v`'s `uplink rate`/`downlink rate` are omitted too: they
disagree with the PHY rate by ~4× (53.95 vs 229 Mbit) and would only invite a
fabricated single "wifi speed".

All four kinds are now written. `config_change` records a container start:
downtime was otherwise invisible in the schema, and the 07:10→08:17 hole on
2026-08-01 — six missed polls over 67 minutes, almost certainly a rebuild — was
indistinguishable from the router refusing for that long, so every coverage
figure computed from `router_line_sample` blamed the router for the deploys.
`note` carries poller telemetry, and only for polls that were not clean: a clean
poll evidences itself in the rows it stored, and one note per poll would be 52k
rows a year in the table the timeline reads. It is in the record rather than
stdout because `make up` runs `--force-recreate`, which destroys the previous
container's log — so every failure-mode tally in this repo was bounded by
time-since-last-deploy.

`router_wan_sample` — the WAN *connection*, one row per poll, between the
carrier line and the IP interface. It exists because the 2026-08-01 outage could
not be diagnosed: `parseLiveWan` parsed five fields and the poller stored one of
them, so the layer that failed had to be inferred from byte counters resetting.

Reading the live device settled what the code comments only asserted. This line
**is** DS-Lite (`X_TP_DsliteEnable=1`, from the router's own data model), the
connection's stack is `3,0,0,0,0,0` while `DEV2_IP_INTF`'s `ppp0` is stack 4, and
`connIPv4Enabled` is 0 with a 0.0.0.0 address — so IPv4 is *entirely* the
softwire. That last one is why **`conn_status_v4` is a constant, not a signal**:
it reads `Connecting` in health and in failure alike, and `uptime_v4_s` is pinned
at 0 forever. `conn_status_v6` and `uptime_v6_s` are the live pair.

`uptime_v6_s` is what the table was worth adding for on its own. It is the WAN
session's own age, so a decrease between polls proves the session was torn down
and re-established — the fact the 08-01 diagnosis had to reconstruct from byte
counters, and the poll that would have shown it directly is the one that failed.
It is materialised into `event` as a `link_change` with `reason:
wan_session_restart`, and it fired on its first real event: an unprompted session
restart at 12:30:00 on 2026-08-01, named 7 seconds later.

`selected_by` records how the row was chosen out of `DEV2_ADT_WAN`'s six
instances. `status` means the router reported it not-disconnected; `continuity`
means nothing was, and this is the connection that was live at the previous poll.
The poller carries one forward so `ppp0`'s counters and the session state keep
being recorded *through* an outage — the old behaviour wrote no WAN row at all
then, which was honest about the label and expensive about the record. Nothing is
fabricated to do it: the counters are read live, and `continuity` says plainly
that the router did not vouch for the connection.

Four more tables hold the carrier-side view, written by the read-only router
poller every 10 minutes. They answer *why* a line is slow, which no amount of
probing from the host can.

**Every poll logs in fresh.** The first version held the single admin session
between polls and answered an eviction with a 15-minute re-login backoff, which
measured at 36% coverage: 20 of 55 due polls stored over 4.5 hours, gaps
alternating 300 s and 1500 s, because one drop silently swallowed the next three
polls. Re-establishing the session per poll costs 72 logins a day against ~144
for repairing a held one.

**It did not remove the failure mode, and the two claims that said so were
wrong.** Per-attempt success roughly doubled — 33.5% under the held session,
45.6% after — but the same two-successes-then-a-hole pattern survives, unbroken
overnight with nobody present, which proves the 15-minute re-login backoff was a
contributing cause rather than the mechanism. And the same change halved the
cadence, so effective sampling fell from 4.04 to 3.23 samples/hour: a better
success rate bought with a worse record. "Nothing measurable was lost" was an
artefact of the 20-sample window it was computed over; 163 samples later,
`down_sync_kbps` shows seven distinct values across eight transitions.

What *is* now fixed is the other half: a poll abandoned partway through no longer
throws away the reads that already succeeded. Two of the ten attempts in the only
log window that survived a deploy were abandoned at reads 3 and 7, and a line
sample needs reads 1 and 2 — so both had one in hand and discarded it. A failed
*login* still stores nothing; the gap is the honest record of a poll that did not
happen.

| Table | Holds |
|-|-|
| `router_line_sample` | sync and current rates, noise margin, attenuation, profile, showtime seconds, errored seconds |
| `router_intf_sample` | per-interface rx/tx kbps and cumulative byte counters, one row per interface per poll |
| `router_eth_port` | each LAN port's negotiated status, max bit rate and duplex |
| `router_host` | which addresses were connected, over which medium, for an outage's blast radius |

Neither `router_eth_port` nor `router_host` carries a MAC column. The port alias
already identifies the port, so a MAC would buy nothing and leak a stable device
identifier out of a public repo.

`router_host` carried a device-name column for its first 102 rows and no longer
does (migration 0005 drops it). 20 of those rows held a vendor-default name of
the form three-letter prefix + 12 hex digits — a MAC address with its separators
stripped — so the table was storing the identifier the paragraph above says it
does not. Redaction could not have saved it either way: the key matched neither
denylist and the MAC pattern requires separators, and redacting at parse time
cannot clean rows already written. The name was also never load-bearing. The
collector host is looked up by its configured IP, not by name, and blast radius
is answered by how many addresses were active on which medium. What replaces it
is nothing; `redact.ts` now blanks name-shaped keys as a second guard, and
`parseHosts` does not read them at all.

## API

Bearer token on the four routes that write to the historical record or to the
line itself: `POST /api/probes`, `POST /api/interventions`, `POST
/api/router/poll` and `POST /api/router/actions/reconnect`. The last carries a
second, independent gate — `LINEWATCH_ROUTER_WRITE`, unset by default — because
the two stop different people: the bearer stops someone else acting, the
capability switch stops *us*.
Everything else is open on the tailnet, including `POST /api/speedtests/run`: it
is a dashboard button with no token to present, and its only abuse is saturating
the line, which a 5-minute rate limit caps more usefully than a shared secret
would. The limit is enforced against the newest `speed_test` row, not an
in-process timer, so restarting the container cannot reset the budget.

| Route | Purpose |
|-|-|
| `GET /health` | container healthcheck |
| `POST /api/probes` | batch ingest from the collector: one cycle, one sample per target, plus the optional `cycle` vantage (bearer) |
| `GET /api/status` | now: up/down, ongoing outage, last sample per target, last speed test, latest vantage (negotiated link, the NIC's supported ceiling, DHCP bind time) |
| `GET /api/probes?from&to&target&bucket` | server-bucketed timeseries: median of medians, max loss, p5/p95 band, plus a parallel per-bucket `vantage` series |
| `GET /api/outages?from&to&minDuration` | list, plus a range `summary` when both bounds are given |
| `GET /api/speedtests?from&to` | list |
| `GET /api/speedtests/summary?days` | p50/p95 down/up, best, worst. **Not used by the dashboard** — `days` is whole days against the server's own clock, so it cannot answer for the page's selected window; the Speed section computes its percentiles from the run list above. Kept for API consumers that want a fixed-day figure. |
| `POST /api/speedtests/run` | trigger one now (no bearer; 429 within 5 min of the last run) |
| `GET /api/events?from&to&kind` | timeline overlay, plus `linkSamplingSince` — without it an empty array reads as "the link held" |
| `POST /api/interventions` | record a manual action — power-cycle, cable swap — as an `intervention` event (bearer) |
| `GET /api/router` | latest line sample, WAN/LAN throughput, the collector host's presence and medium, LAN ports |
| `GET /api/router/line?from&to&limit` | carrier line history: sync rates, noise margin in real dB, attenuation, showtime |
| `GET /api/router/throughput?from&to&role&limit` | per-interface rates, `role=wan` for the live internet-facing one |
| `POST /api/router/poll` | run one read-only poll now (bearer; 429 within 60 s of the newest stored sample) |
| `POST /api/router/actions/reconnect` | re-dial the WAN (bearer **and** `LINEWATCH_ROUTER_WRITE=1`; 403 without it) |
| `GET /api/wifi?from&to&bucket` | radio history, bucketed in SQL: signal/noise, SNR derived on read, PHY rate (not throughput), interface-bound RTT |

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

basalt-ui (Mantine v9) + visx, per the `/dataviz` conventions.

**One page, one range control, no navigation chrome.** This was five routes, then
one route with four tabs, then one route with five stacked sections each hiding a
second screenful behind a disclosure. What each attempt bought and cost is in
`web/src/routes/index.tsx`'s docblock; what settled is worth stating here because
it constrains everything below.

- **Every figure on the page is taken over the window the range control selects.**
  The one exception is the 30-day availability heatmap, whose shape is a fixed
  hour × day grid, and it says so on itself. The speed percentiles are computed
  client-side from the runs inside the window (`web/src/lib/speed-stats.ts`)
  rather than read from `GET /api/speedtests/summary`, whose `days` parameter is
  anchored to the server's clock and takes whole days — on the 1 h range it
  answered for a day while every other number answered for an hour.
- **A section's evidence lives behind a named view switch, never behind a chevron
  saying "Details".** The reader can see what each cut contains without opening
  it, and the *primary* view is the one a verdict's "see the Uptime section" link
  lands on.
- **No conclusion is ever behind a switch.** Every rule the engine fires renders
  in the verdict band above every section, unconditionally.
- **The three anchors are folded.** The primary latency chart is one band over
  the median-across-anchors of each statistic, with the router's own median drawn
  over it — see `foldInternetBuckets` for what each field folds by and why
  `down_cycles` takes a provable lower bound rather than a plausible guess. Every
  anchor is still drawn separately in the section's other view.

The five sections, in reading order:

- **Now** (the strip above the sections) — current state, ongoing outage if any, the verdict set, last speed
  test, 24 h availability strip. Two states are not derived from the absence of an outage
  row: a collector that stopped reporting is its own non-green banner (no cycle
  ingested means no outage row can ever open, so "no outage" is not "up"), and a
  target whose newest sample is older than two probe cycles goes neutral instead
  of green. The strip is one column per bucket over the whole window, because a
  sparkline over a dense array closes over every unmeasured bucket and draws a
  guaranteed-healthy trend. The verdict set comes from `GET /api/verdicts` and
  is rendered whole, `uncertainty` included: that sentence is where a rule says
  why it withheld a cause, and dropping it turns a deliberate refusal into
  apparent silence, which reads as health. An empty result renders as "no
  verdicts for this window", never as a green all-clear — no rule firing
  includes every rule that fell silent for want of inputs.
- **Uptime** — outage list plus a day/hour availability heatmap. The headline
  number is total downtime per period, not a 99.x% figure; on a home line the
  percentage flatters and the minute count informs. It counts an ongoing
  outage from its start (`duration_s` is null while one is open, and reading
  that as 0 printed "0 min" under a live outage banner) and clips an outage
  straddling the window to its time inside it. Directly under it sits the
  `GET /api/outages` range summary — coverage, degraded cycles and the vantage
  verdict — because the headline is only true to the extent the window was
  measured.
- **Latency** — SmokePing-style band: median line, p5–p95 shaded, loss as colour.
  Drawn once over the folded internet series with the router overlaid, and again
  per target in the section's other view.
- **Speed** — download/upload over time, hourly heatmap, loaded-vs-idle latency.
  Runs are plotted oldest-first: `GET /api/speedtests` answers newest-first,
  which is right for a list and backwards for a time axis.
- **Throughput** — what the line actually carried, differenced from the interface
  counters. A different question from Speed, and the two must never be read as
  one: a quiet night reads as near-zero here and says nothing about capacity.
- **Path & hardware** — what the line is being measured *through*. The current cycle's
  interface, path class, negotiated media/speed/duplex, the NIC's supported
  ceiling, gateway and DHCP bind time, with `on_home_line: null` rendered as an
  "unknown" chip and never a check mark. Then the carrier's sync rate beside the
  host's negotiated link beside the last measured throughput, each with its own
  age — and **no ratio at all while either side is stale**, because
  `GET /api/router`'s parts age independently and dividing a 25-minute-old sync
  figure by a 30-second-old link speed manufactures a disagreement between two
  moments. Then link speed per bucket, where a bucket holding more than one
  speed is marked as a renegotiation rather than averaged into a rate the link
  never ran at. Then the transition timeline from `GET /api/events`, with the
  observing source in its own column.

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

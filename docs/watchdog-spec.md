# Watchdog — from the 2026-08-01 outage to an automated control path

*What happened, what the record could and could not prove, why it could not, and
what has to be built before anything is allowed to touch the router by itself.*

STATUS: specification only (2026-08-01). Nothing in phases 0–2 is implemented.

**All times in this document are UTC, which is how they are stored.** The
container has no `TZ` set, so SQLite's `localtime` modifier renders UTC too. The
user's wall clock is CEST = UTC+2: the incident below happened between 12:09 and
12:30 local.

---

## 1. What happened

On 2026-08-01 the line lost all WAN reachability for 21m30s while the gateway
stayed up throughout, and it came back one minute after the user rebooted the
router by hand. Every line below carries the query or file that produced it. All
database reads were `echo "<sql>" | make db-shell`; the row counts reconcile
against `probe_sample` unless noted.

| UTC | Event | Evidence |
|-|-|-|
| 10:04:35 | Ookla speed test, 552/205 Mbps, 0% loss, 11.18 s, 263 MB down / 106 MB up, `server_id` 31470 | `speed_test` row, `ok=1` |
| 10:04:34 | The one probe cycle the test disturbed — cloudflare med 12.65 ms vs 4.4 baseline | `probe_sample` |
| 10:05:04–10:08:34 | Eight consecutive pristine cycles | `probe_sample`, all four targets 20/20 |
| 10:08:34 | Last fully clean cycle. cloudflare med 4.53 ms | `probe_sample` |
| ≈10:08:38 | Last successful WAN reply. 20 pings at 200 ms from a 10:08:34 cycle start | arithmetic on the cycle |
| **10:09:04** | **First failing cycle.** gateway 20/20 @ 0.98 ms; cloudflare, google, quad9 all 0/20 | `probe_sample`; `outage` id 4 `started_at` |
| ≈10:09:38 | The gfast line reached showtime | back-solved: 10:10:01 poll − `showtime_start_s` 23 |
| 10:10:01 | Router poll succeeds. Line `Up`, 814.9/227.6 Mbit sync, noise margin 6.0/6.1 dB. **`ppp0` byte counters reset 29,368,365,157 → 0 and 11,847,899,388 → 0**, rx/tx 0 kbps. `br0` keeps climbing, 13,903,933,986 → 14,038,088,191 | `router_line_sample`, `router_intf_sample` |
| 10:12:34, 10:17:34, 10:22:34 | Wi-Fi samples: `rtt_med_ms` and `loss_pct` NULL — the `en1`-bound ping to the WAN anchor timed out. 10:07:34 read 30.3 ms / 0% | `wifi_sample`; collector log `wifi.command_timeout` |
| 10:20:00 | Router poll **fails**: `no TokenID in the logged-in shell — the login did not take` | container log; nothing stored |
| 10:09:04–10:27:04 | **37 consecutive cycles**: gateway 0% loss, all three WAN anchors 100% loss, every sample `sent=20 received=0` — no partial replies anywhere | `probe_sample`, 37 distinct `ts`, all 30 s apart |
| 10:27:21 | `en0` down — the user starts rebooting the router | `event` kind `link_change`, `detail.source: link-sampler` |
| 10:27:34, 10:28:04 | Probe cycles with **no vantage at all** | `probe_cycle` all-NULL; collector log `vantage.no_default_route` |
| 10:27:34–10:28:34 | Gateway 100% loss, 3 cycles | `outage` id 5, 90 s |
| 10:27:38 / 10:27:42 / 10:28:13 | Further `en0` up/down/up | link-sampler events |
| 10:28:26 → 10:28:49 → 10:29:48 | Three DHCP re-binds | `probe_cycle.dhcp_bound_at` |
| ≈10:29:37 | Second showtime — the post-reboot resync | back-solved from the 10:40 (623), 10:50 (1223) and 11:00 (1825) readings |
| 10:29:44 → 10:29:47 | A 3 s `en0` flap, entirely between two probe cycles, **zero measured loss** | link-sampler events vs `probe_sample` |
| 10:30:00 | Router poll. Whole device's counters reset (`br0` → 3,137,305). **`ppp0` already holds 1,334,162 rx / 635,240 tx at showtime+23 s** | `router_intf_sample` |
| 10:30:04 | Last failing cycle | `probe_sample` |
| **10:30:34** | **First clean cycle** — WAN restored | `outage` id 4 `ended_at` |
| 10:32:34 | Wi-Fi back: 31.1 ms / 0% | `wifi_sample` |
| 10:40:00 | `ppp0` rx 5548 kbps, `bytes_rx` 594,253,035 | `router_intf_sample` |

Materialised outages, and they reconcile exactly against the raw rows:

| id | scope | started | ended | duration_s | cycles | evidence |
|-|-|-|-|-|-|-|
| 4 | wan | 10:09:04 | 10:30:34 | 1290 | 43 | cloudflare, google, quad9 |
| 5 | gateway | 10:27:34 | 10:29:04 | 90 | 3 | gateway |

### The precursors, which the first pass missed

10:08:34 was not the last unhealthy-free moment of the day. On 2026-08-01, cycles
losing WAN packets with a clean gateway:

| UTC | Loss | Note |
|-|-|-|
| 09:02:34 | cf 5%, google 5% | the 09:02 speed test saturating; med ~32 ms |
| 09:27:04 | google 5% | one packet |
| 09:28:04 | google 5% | one packet |
| **09:38:34** | **cf 40% (12/20), google 45% (11/20), quad9 40% (12/20)** | gateway 20/20 @ 1.04 ms, surviving RTTs normal (4.40 / 4.83 / 9.87 ms) — a ~1.5–2 s total WAN blackout inside the 4 s probe window, 30.5 min before the outage |
| 09:56:34 | cf 5%, google 5%, quad9 5% | |

Base rate for "all three WAN anchors losing packets in one cycle with the gateway
clean": ~1/day across the record (07-30 h10 ×1, h12 ×2, 07-31 h05 ×1, 08-01 h09
×2). Two of them landed in the hour before the outage, one at 40–45%.

And in that same hour, between the 09:20:01 and 09:29:35 polls, `ppp0` moved
**4,386,704,726 bytes** — 61.13 Mbit/s sustained, three times the volume of the
largest other inter-poll interval in the whole record (1.46 GB, 07-31
17:30→17:55). The 09:02 speed test was 275 MB and predates the window. **Nobody
knows what that transfer was.** Two off-cadence polls at 09:29:35 and 09:33:54
mark container restarts (the poller fires 5 s after boot), so at least part of it
may have been image pulls.

---

## 2. What the record proves, and what it does not

The first analysis of this incident concluded: *the physical gfast line recovered
itself in ~20 s, the router's IP layer stayed wedged for 18.5 minutes, only a
reboot cleared it, and neither the line nor linewatch caused it.* Two independent
verification passes over the database and the source refuted or weakened most of
the specifics while leaving the shape intact. The corrections are recorded here
rather than smoothed over, for the same reason `storage.md` records the
measurement `db-restore` destroyed: this project's whole product is an honest
record.

### Confirmed

- **The WAN interface was destroyed and recreated, and the device was not
  rebooted.** `ppp0`'s cumulative byte counters reset to zero at the 10:10:01
  poll while `br0`'s kept climbing. A query for every decreasing byte counter in
  the entire database returns exactly two rows: `ppp0` at 10:10:01 and `br0` at
  10:30:00 (the human reboot). A query for `bytes_rx=0 OR bytes_tx=0` returns
  exactly one row: `ppp0` at 10:10:01. `parse.ts`'s `int()` returns null for an
  absent or empty field, so those zeros are the router's own numbers, not a
  parser default. **This is the single strongest fact in the incident and it was
  absent from the first analysis.**
- **The recreated interface passed nothing.** 0 bytes in either direction at
  showtime+23 s.
- **The controlled comparison.** Two polls landed at *exactly* the same offset
  from their respective resyncs — showtime+23 s. At 10:10:01, `ppp0` totals were
  0/0. At 10:30:00 they were 1,334,162 / 635,240. Same offset, opposite outcome,
  and the measurement itself carries no reboot confound.
- **The host is comprehensively ruled out.** Every cycle 10:09:04–10:27:04:
  `path_if=en0`, `ethernet`, `1000baseT`, 1000/1000 Mbit full duplex, gateway
  192.168.1.1, `on_home_line=1`, `if_ierrs`/`if_oerrs`/`if_coll` all 0,
  `link_watch_s` 29–30 (near-total 1 Hz coverage) with **zero** link-sampler
  transitions, `dhcp_bound_at` frozen at 08:16:34. Gateway RTT during the outage
  averaged 1.040 ms against a 0.965 ms pre-incident baseline — no router stress.
- **It was not `en0`-specific either.** The `en1`-bound Wi-Fi pings failed for
  the same window and recovered with it. That rules out the mini's Ethernet port,
  its DHCP lease and its ARP state.
- **A prior instance of the same shape exists, and it recovered on its own.**
  `outage` id 1 (2026-07-30 12:07:51 → 12:09:21, 90 s, 3 cycles, identical
  evidence set). Back-solving the earliest router poll's `showtime_start_s`
  places that resync at 12:09:05–12:09:07 — **IPv4 came back 14–16 s after
  showtime, with no intervention.** That precedent is what makes the 08-01
  non-recovery anomalous, and it is confound-free.
- **The speed test is exonerated temporally.** It finished 4m18s and eight clean
  30 s cycles before the first failure.
- **The line quality shows nothing.** `status` `Up` on every row 06:10 → 11:00.
  Down/up noise margin 5.8–6.2 dB with no trend across the event (6.0/5.8 at
  10:00, 6.0/6.1 at 10:10, 6.0/6.1 at 10:30). Down attenuation 8.5 dB on every
  single row in the table. Sync rates wobble ±0.9% independently of resyncs
  (810115 → 807600 with no resync between 07:10 and 08:17), so a rate change is
  not evidence of a retrain.

### Corrected

| First analysis said | The record says |
|-|-|
| "10:10–10:27, thirty-seven consecutive cycles" | The gateway-up/WAN-down condition holds for **40** cycles, starting at **10:09:04**: 37 cycles (10:09:04–10:27:04), 3 gateway-down cycles during the reboot, then 3 more (10:29:04–10:30:04). The WAN outage as a whole is 43 cycles / 1290 s. |
| "The physical gfast line recovered itself in ~20 s" | Not derivable. WAN was already dead at 10:09:04 and showtime is 10:09:38, so the bound is ≤34 s from the first *observed* failure. More importantly **the break precedes the resync**: last WAN reply ≈10:08:38, first failure 10:09:04, showtime 10:09:38. |
| "…and the IP layer then failed to follow" | The causal order is inverted. The resync is consistent with being *part of* the fault, not a recovery the IP layer failed to follow. The `ppp0`-only counter reset with `br0` untouched is equally consistent with "the line dropped and the router retrained it" and "the router tore down its WAN stack, which retrained the line as a side effect". |
| "18.5 minutes" | Ambiguous. Resync (10:09:38) → reboot start (10:27:21) = **17m43s**. Outage start → reboot start = **18m17s**. Full recorded WAN outage = **21m30s**. Say which. |
| "The router remained continuously reachable and answering polls" | ICMP: yes, 20/20 replies at ~1.0 ms on 40 of the 43 failing cycles. **The management plane produced exactly one successful poll inside the 21.5-minute window.** And a missed poll proves nothing here — see below. |
| "10:20's poll failure shows the user was in the router UI" | Weak. The poller's habitual pattern is two successes then 2–3 failures on a 40–50 min period, running unbroken all night with nobody present. 10:00 ok / 10:10 ok / 10:20 fail / 10:30 ok fits it exactly. The two failures whose reason is readable (09:40, 09:50) were 406/socket-close, a *different* symptom from 10:20's "no TokenID", so it stays ambiguous rather than resolved either way. |
| "Recovery 57 s after the post-reboot resync" | Upper bound only. The last failing cycle's last packet was ≈10:30:08, the first clean cycle 10:30:34, so restoration falls in **31–57 s** after the 10:29:37 resync. 30 s probe cadence is the resolution limit. And it is the wrong comparison to lead with: human-action-to-recovery was **3m13s** from the 10:27:21 link flap. |
| "~10:29:37 the line resynced again" | True, but **the record does not contain that event**. `src/services/router/derive.ts:142` `detectResync` uses strict `<`, and both the 10:10:01 and 10:30:00 polls read `showtime_start_s = 23`. There is exactly one `line_resync` event in the whole `event` table (10:10:01). The second resync is only recoverable by back-solving the 10:40/10:50/11:00 readings. |
| "Identical speed tests at 07:01 and 09:02 caused nothing" | Not identical. 10:04:35 ran against `server_id` 31470; 07:01:42 and 09:02:32 ran against 69406. 11.18 s vs 9.121/9.400 s, `latency_down_ms` 12.609 vs 40.699/40.063. The temporal exoneration stands; "identical" is not a fact in the record. |
| "Neither the line nor linewatch caused it" | linewatch is exonerated. The line is **un-implicated, not exonerated**: there is no positive evidence of a physical fault, but `errored_secs` and `severely_errored_secs` are **NULL in all 165 rows** — this firmware never populates them through the polled OIDs — so the field that would incriminate the line has never been readable in either direction. |
| "The router poller stores ~22% of due polls" | Wrong on every day. See §5 — the correct figures are 33.5% and 45.6% per-attempt across two cadence regimes, and the two verification passes disagreed with each other before the cadence split resolved it. |

### Unverifiable from the record

- **Whether the router's pppd kept retrying across those 18 minutes or gave up.**
  No PPP session state is stored. Phase 0.1 fixes this.
- **Whether the wedge was in PPP, in the router's tunnel driver, or at the
  carrier.** All four probe targets are IPv4. Phase 0.2 fixes this.
- **Anything about the line between 10:10:01 and 10:30:00.** One observation
  inside a 21-minute outage, because the 10:20 poll failed. Phase 1 fixes this.
- **What the 4.4 GB transfer at 09:20–09:29 was.**
- **Whether a PPP reconnect would have helped.** On this incident, almost
  certainly not — see §7.

### Two record-integrity findings, unrelated to the incident but found while checking it

- **`sum(outage.cycles)` for `scope='wan'` is 46 against only 43 all-WAN-down
  cycles in `probe_sample`.** The 3-cycle deficit is `outage` id 1, which lies
  inside the 07-30 11:20:51 → 12:18:51 `probe_sample` hole left by the corruption
  documented in `storage.md`. Materialise-on-write preserved a finding whose raw
  evidence was lost. Know this before anyone "reconciles" the tables by deleting
  the orphan — it is the design working, not a bug.
- **`outage.id = 3` does not exist.** Rows are 1, 2, 4, 5; `sqlite_sequence.seq`
  is 5. No probe cycle anywhere justifies a missing outage — 07-31 has 2864/2880
  cycles with zero failures. What row 3 was, and when it was removed, is
  unknown. Flagged, not explained.
- **No `intervention` event was written for the router reboot.** Three were
  written earlier the same day (06:55 cable swap, 07:25 relocation, 08:33
  collector restart). This is exactly the failure `POST /api/interventions`
  exists to prevent, per `DESIGN.md`: the record now shows a 21.5-minute outage
  that ended on its own, and any future automated verdict will read it that way.

---

## 3. Why the system could not diagnose it

Three independent gaps. Each has a file and a line.

### 3.1 Every probe target is IPv4

`src/config.ts:17-22` and `collector/probe.ts:49-54` both define the same four
targets — 192.168.1.1, 1.1.1.1, 8.8.8.8, 9.9.9.9. So the record cannot separate
"the whole WAN path is down" from "IPv6 is fine and the IPv4-over-IPv6 tunnel is
wedged". That distinction is the difference between "reboot the router" and
"phone the ISP".

There is one hint at the answer buried in the timing: at the 10:30:00 poll
`ppp0` already held 1,334,162 bytes rx while the 10:30:04 probe cycle was still
100% loss on all three IPv4 anchors, recovering only at 10:30:34. That is a
30–60 s window in which the WAN interface carried IP traffic while IPv4 ICMP to
the internet did not work — the closest thing to a tunnel-endpoint signature the
record contains. It is one observation at 30 s resolution. It is not a
conclusion.

**The DS-Lite premise itself is not established.** The claim that this line
carries IPv4 over DS-Lite rests on exactly two code comments
(`src/services/router/parse.ts:139-141`, `src/services/router/redact.ts:20-23`)
and `src/services/router/fixtures.ts:68-77`, which the repo itself declares
sanitised. `docs/DESIGN.md`, `README.md` and `CLAUDE.md` contain zero occurrences
of "ipv6", "v6", "ds-lite" or "dslite". Nothing is persisted. Live read-only
measurements from the mini lean mildly *against* an active tunnel without
refuting it: a 1500-byte DF IPv4 datagram reaches both 1.1.1.1 and 8.8.8.8
(`ping -D -c1 -s 1472`; DF is genuinely enforced — `-s 1473` gives `sendto:
Message too long`), IPv4 and IPv6 RTT to Cloudflare differ by 0.19 ms
(3.906 vs 3.719 ms), and `traceroute`'s second IPv4 hop sits at the same latency
as the second IPv6 hop rather than deeper. A naive DS-Lite deployment caps IPv4
at ~1460 and puts the AFTR deeper than the BNG. None of that is proof — ISPs
commonly run a >1500 access MTU precisely so DS-Lite customers keep 1500 — but
**treat "this line is DS-Lite" as an unverified developer note, not a measured
fact.** The blind-spot conclusion survives regardless, because it follows from
"all four targets are IPv4" alone.

Separately confirmed from firmware (§7): the router's data model *does* carry
`DEV2_DSLITE_INTFSET` and `X_TP_DsliteEnable`. The firmware supporting DS-Lite
says nothing about whether this line uses it.

### 3.2 The field that would name the layer is parsed and thrown away

`src/services/router/parse.ts:122-130` declares `LiveWan { name, ifName,
connType, connStatusV4, connStatusV6 }` and `parseLiveWan` at `:144-158` returns
all five. The complete set of consumers is:

- `src/services/router/poll.ts:179` — `wanIfName: wan?.ifName ?? null`
- `src/services/router/poll.ts:343` — `wanIfName: wan?.ifName ?? null`

**Four of five parsed fields are discarded.** No column anywhere stores a WAN
connection status: `grep -rn "connStatus|Dslite|ADT_WAN"` over `src/ collector/
docs/ drizzle/ web/` hits only `parse.ts`, `fixtures.ts`, `poll.ts`, `redact.ts`
and their tests, with zero hits in `src/db/schema.ts` and zero in `drizzle/*.sql`.
The three `status` columns that exist are unrelated (`router_line_sample.status`
is the carrier's, `router_eth_port.status` is a port link).

One subtlety worth knowing before relying on the persisted `ppp0` row as
evidence of anything: `parse.ts:22`'s `present()` treats an absent field as null,
and `parseLiveWan`'s filter is `connStatusV4 !== 'Disconnected' || connStatusV6
=== 'Connected'`. A row with **no** status fields at all therefore qualifies. The
fact that `ppp0` was persisted with `role='wan'` at 10:10:01 does not even prove
the router called the connection not-disconnected.

### 3.3 The carrier-side view was unavailable at the one moment it mattered

The 10:20 poll failed with `no TokenID in the logged-in shell — the login did not
take`, 11 minutes into the outage, while the line had already resynced and the IP
layer was wedged. The next carrier reading is 10:30:00, **two minutes after the
human had already rebooted the box.**

That is not an accident of this incident; it is the poller's normal state. §5 has
the measurements. The short version: 45.6% of scheduled polls are stored, the
expected wait from a random instant to a confirmed-working control path is 13.3
minutes, and p90 sample spacing is 40 minutes. **An 18.5-minute outage is inside
that noise floor.**

---

## 4. Phase 0 — measurement

Nothing here automates anything. Each item closes a gap that made the 08-01
incident undiagnosable. They are independent and can land in any order, though
0.1 is the cheapest and the highest value.

### 0.1 Persist the WAN connection state

The data is already parsed and dropped. This is the change that would have named
the failing layer.

| | |
|-|-|
| Files | `src/db/schema.ts`, new `drizzle/0006_*.sql`, `src/services/router/poll.ts` (~:216-260), optionally `src/routes/router.ts` |
| Shape | A **new table `router_wan_sample`**, not columns on `router_line_sample` |
| Columns | `id`, `ts`, `if_name`, `conn_name`, `conn_type`, `conn_status_v4`, `conn_status_v6`, `access_mode`, `stack` — all nullable except `id`/`ts` |
| `parse.ts` | **No change.** `parseLiveWan` already returns everything except `stack` and `accessMode`; add those two to `LiveWan` and it is done |

Why a separate table and not columns on `router_line_sample`:
`src/services/router/poll.ts:216,221` gates that insert on `hasLineReading` (i.e.
`DEV2_FAST_LINE` or `DEV2_DSL_LINE_STATS` returned rows). A poll where only
`DEV2_ADT_WAN` answered would silently drop the status — which is precisely the
partial-poll case Phase 1 exists to stop discarding.

**Acceptance:** after 24 h, `router_wan_sample` has one row per successful poll;
`conn_status_v4` and `conn_status_v6` hold the router's verbatim strings; a
`connStatusV4` of `Connecting` alongside `connStatusV6` of `Connected` is
visible, or its absence proves the parse.ts:139-141 comment wrong. Either result
is a win — this is the measurement that settles §3.1's DS-Lite question.

**Add `stack` too, even though it is not needed for diagnosis.** §7 shows the
WAN reconnect action requires the `DEV2_ADT_WAN` instance's own `stack`, and
`ppp0`'s `DEV2_IP_INTF` stack (4, confirmed live) is the wrong one. Persisting it
now closes the only blocking unknown in the write envelope, at zero extra router
traffic.

### 0.2 An IPv6 probe anchor

There are **five** blockers, not the two originally identified. Do not ship
partially.

| # | Blocker | File |
|-|-|-|
| 1 | `const [name, addr, scope] = entry.trim().split(':')` — an IPv6 literal cannot be expressed | `src/config.ts:29` **and** `collector/probe.ts:67`, which must accept identical strings |
| 2 | The whole argv is IPv4-specific | `collector/probe.ts:276` |
| 3 | `LINEWATCH_TARGETS` never reaches the launchd collector | `collector/com.jkrumm.linewatch-collector.plist.template:25-36` |
| 4 | The server maps target *name* → scope from its own config and silently defaults an unknown name to `'wan'` | `src/routes/probes.ts:288` |
| 5 | A `wan`-scoped v6 anchor would **suppress** the outage it exists to characterise | `src/services/outage-detector.ts:72` |

Blocker 2 is worse than "the binary is hardcoded". Measured on this host (macOS
26.5.2, build 25F84):

- `/sbin/ping -c2 2606:4700:4700::1111` → `ping: cannot resolve
  2606:4700:4700::1111: Unknown host`. `/sbin/ping -6` → `invalid option -- 6`.
  `ping` cannot do IPv6 here at all.
- **`-W` on `ping6` is a completely different flag.** `man ping6`: `-W  Same as
  -w, but with old packet format based on 03 draft`, and `-w  Generate ICMPv6
  Node Information DNS Name query, rather than echo-request`. It takes no value,
  so `ping6 -c 20 -i 0.2 -W 1000 <addr>` swallows `1000` as the hostname and
  fails with `nodename nor servname provided`. Swapping only the binary produces
  a target stuck at 100% loss forever.
- **`ping6` has no timeout option whatsoever** — no `-W` value form, no `-X`, no
  deadline (checked against the full usage string and the man page). A fully-lost
  run blocks on the ~10 s MAXWAIT: measured 11 s wall for `ping6 -c 3 -i 0.2
  2001:db8::1`. At the configured `-c 20 -i 0.2` that is ~14 s of a 30 s cycle.
  Targets are pinged in parallel (`collector/probe.ts:329-330`, `Promise.all`),
  so it is 14 s and not 56 s — but it is a new failure mode with no knob, and the
  collector must impose its own wall clock and kill the process, the same belt
  `captureWifi` already uses.

Blocker 5 is the dangerous one. `outage-detector.ts:72` is `wanResults.every((r)
=> r.down)`. A v6 anchor scoped `wan` makes that false during a v4-only failure
and **no outage row opens at all** — replayed against 2026-08-01, the entire
21-minute outage would have vanished from the record. So a third scope is
required *before* the target.

`Scope` is `'gateway' | 'wan'` at `src/services/outage-detector.ts:6`. Adding
`'wan6'` costs **no migration** — `drizzle/0000_dapper_molecule_man.sql:11` is
bare `scope text NOT NULL` with no CHECK. But it is hardcoded in nine more
places, three of which fail at *runtime* rather than at build:

| File | Why it bites |
|-|-|
| `src/routes/status.ts:11,24` | `z.enum(['gateway','wan'])` used as `response: StatusResponse` at `:164` — a third value fails Elysia **response** validation and breaks `GET /api/status` at runtime |
| `src/routes/outages.ts:39` | same enum |
| `web/src/components/status-banner.tsx:7` | `Record<OutageScope,string>` — a missing key renders `undefined` |
| `web/src/components/outage-table.tsx:46` | two-way colour ternary |
| `src/lib/verdict-queries.ts:246,355` | `WHERE scope = 'wan'` / `= 'gateway'` as SQL literals |
| `src/routes/verdict.ts:38-39` | derives wanTargets/gatewayTarget from config scope |
| `src/config.ts:30`, `collector/probe.ts:68` | reject any scope not `gateway|wan` |
| `src/db/schema.ts:178` | drizzle enum (no migration) |
| `web/src/lib/types.ts:20` | `OutageScope` |

Two things need no change, both verified: `collector/ping-parser.ts` parses real
`ping6` output unchanged in both the 0%-loss and 100%-loss shapes (`ping6` exits
2 on total loss, which the existing "never gate on the exit code" rule already
covers), and `collector/ping-parser.test.ts:84-86` already anticipates `ping6`'s
`+N errors,` clause.

**One repo-hygiene trap:** `ping6` prints the host's own **global IPv6 address**
as the packet source on its first output line. `probe.ts` never logs stdout
today, so nothing leaks — but any future "log the raw ping output on parse
failure", or a fixture captured verbatim, would put a routable subscriber
identifier into a public repository. Put a comment at `collector/probe.ts:276`
and scrub any `ping6` fixture.

**Acceptance:** a v6 anchor probed every cycle at `scope: 'wan6'`; a v4-only
failure opens a `wan` outage and no `wan6` outage; `GET /api/status` still
validates; a totally-lost v6 cycle completes inside the 30 s budget.

### 0.3 Fix `detectResync`

`src/services/router/derive.ts:142` uses strict `<`, so two consecutive polls
reading the same `showtime_start_s` record no resync. That is exactly what
happened at 10:30:00 (23 vs 23) and it is why the post-reboot resync is missing
from the `event` table. The same class of blind spot bit the analysis: a
"decreasing byte counter" test misses `ppp0`'s second reset because its prior
reading was 0.

Fix: compare back-solved showtime **epochs** (`ts − showtime_start_s × 1000`)
with a tolerance of a few seconds, not the raw counter. **Acceptance:** replaying
the 10:10:01 / 10:30:00 / 10:40:00 readings produces two resync events.

### 0.4 Record service starts

Container downtime is currently invisible in the schema. The 07:10→08:17 UTC hole
on 08-01 (6 missed polls, 67 minutes) is almost certainly `make up` rebuild
downtime — it ends in a boot poll and correlates with commit `cc07642` — but
nothing distinguishes it from 67 minutes of the router refusing. Any coverage
metric built on `router_line_sample` alone will mis-attribute deploys as router
failures.

Write a `config_change` event at container boot (`kind` is already in the drizzle
enum at `src/db/schema.ts:227-229`; `DESIGN.md:297` reserves it for exactly
this). One line of code. **Acceptance:** coverage calculations can exclude
downtime windows.

### 0.5 Two `outage` semantics to document, not change

- `duration_s` is measured to the first **recovering** cycle, so 1290 s is an
  upper bound; the true outage is bounded at 1260–1290 s. Do not "fix" it — the
  30 s cadence is the resolution, and both endpoints are defensible. Document it.
- `outage.evidence` is overwritten on every extend (`outage-detector.ts`
  `evaluateScope`), so it holds the *last* failing cycle's target list, not a
  union across the outage.

---

## 5. Phase 1 — a trustworthy control path

**A watchdog's authority must not exceed its instrumentation's reliability.**
Today it does, by a wide margin.

### The measured baseline

`CLAUDE.md` and `DESIGN.md:305-313` claim the "fresh login every poll" change
removed the failure mode ("removes the failure mode instead of tuning its
constant", "the cadence halved to pay for it and nothing measurable was lost").
Both halves are wrong, and the arithmetic in the original complaint about it was
wrong too. The record splits into two regimes, and the split is visible in the
timestamps themselves:

| Regime | Window (UTC) | Cadence | Timestamp signature | Due | Stored | Per-attempt |
|-|-|-|-|-|-|-|
| A — held session | 07-30 14:55 → 07-31 17:55 | `*/5` | 0–17 ms past the boundary (too early to follow a login) | 325 | 109 | **33.5%** |
| B — fresh login | 07-31 17:57 → 08-01 11:00 | `*/10` | 820–1621 ms past the boundary (a login precedes it) | 103 | 47 on-grid (+7 boot) | **45.6%** |

The fix (`a8b0935`) was committed 2026-07-31 06:00 UTC and **deployed at 17:57
UTC — twelve hours later**. That timestamp signature is a free way to date any
future deploy against the record.

| Claim | Correction |
|-|-|
| "~22% of due polls" | No day is near 22%. Per day: 07-30 33.9% (37 of 109 due, partial day at `*/5`), 07-31 35.7% (90 of 252 due, mixed cadence), 08-01 to 11:00 44.8% (30 on-grid of 67 due). |
| "07-31's 93 was inflated by dev restarts" | Only 3 of 93 rows are boot polls. 07-31 is high because 18 of its 24 hours ran at `*/5`. |
| "the fresh-login change did not help" | Per-attempt success roughly doubled the *rate*: 33.5% → 45.6%, overnight 34.0% → 42.9%. |
| "…so it worked" | It did **not** remove the failure mode. The identical 2-on-then-hole structure survives with no backoff anywhere in the code, which proves the 15-minute re-login backoff was a contributing cause, not the mechanism. And the same commit halved the cadence, so **effective sampling fell from 4.04 to 3.23 samples/hour**. Better success rate, worse record. |
| "nothing measurable was lost — `down_sync_kbps` had zero variance across all 20 samples" | Refuted by the record it now has: 163 samples show 7 distinct `down_sync_kbps` values spanning 803140–814864 kbps with 8 transitions. Zero variance was an artefact of a 20-sample window. |
| "the router allows one admin session, so the poller and a human evict each other" | True mechanism, false explanation for the routine loss. Overnight with nobody present: 42.9% against 45.6% overall. The 2-on/2-3-off pattern runs unbroken 22:00 → 06:00. |
| "gaps of 30–40 min" | Regime B holes are 1, 2 or 3 missed slots (10/20/30 min). The one 40-minute-plus hole (67 min) is container downtime ending in a boot poll. Median spacing 10.0 min, mean 18.9, p90 40.0. |

**The two verification passes disagreed here before the cadence split resolved
it.** One reported ~53% for 08-01 and per-day counts of 37/93/34; the other
computed 44.8% for the same day. The difference is entirely the denominator —
partial days, and a cron that changed mid-record. Any future coverage number
must state its cadence regime and its window, or it is not a number.

### What is actually failing

From the only log window that exists (the container started 09:33:49 UTC; `make
up` runs `--force-recreate`, which destroys the previous container's json-file
log, so **all failure-reason evidence in this repo is bounded by
time-since-last-deploy**): 10 attempts, 7 stored, 2 abandoned, 1 login failure.
`[router] skipped — a poll is already in progress` never appears, so the
scheduler fires reliably.

- **Both abandonments had the same shape:** `406 on <OID>` → `session dropped
  (transport failure ... while the router still answers)` → `poll abandoned`. The
  OIDs were `DEV2_ADT_WAN` (read 3 of 8) and `DEV2_HOSTS` (read 7 of 8).
- **`classifyTransportFailure()` diagnoses an eviction it never observed.** It
  fires only when `isReachable()` confirms the router *is* answering, and the
  router never returned 401/403 or an unparsable body — the two paths that would
  actually evidence an eviction. It said 406 (the client's own "busy, not broken"
  code) and then closed the socket. `readWith()` retries a 406 four times with
  800/1600/2400 ms backoff, but **any `post()` that throws goes straight to
  classification: there is no transport-level retry anywhere. One closed socket
  ends the poll.**
- **Not a generic idle timeout.** Tested read-only: GET `/` on a reused
  connection after 0.05 / 0.8 / 2 / 5 s idle returned 200 OK all four times, and
  the router advertises `Connection: keep-alive` with no `Keep-Alive: timeout=`
  header. The close is specific to the `/cgi_gdpr` 406 path, and in 2 of 2
  observed cases came on the retry immediately after a 406 on the same OID.

### The work, ranked by leverage

| # | Change | Cost | Effect |
|-|-|-|-|
| 1 | **Write what was already read.** A poll abandoned at read 3–8 discards reads that succeeded. `router_line_sample` needs only reads 1 and 2, so both observed abandonments had a **complete line sample in hand and threw it away**; the read-7 case also had complete intf and eth-port rows. | Zero extra router traffic | Observed coverage 7/10 → **9/10** |
| 2 | **Retry a closed socket** at the transport layer, not just a 406 at the HTTP layer. | One extra request | Addresses the mechanism, not the symptom |
| 3 | **`POST /api/router/poll`** — an on-demand poll, bearer-gated, rate-limited to 60 s against `max(router_line_sample.ts)` (the same row-based pattern as the speedtest limit, so a container restart cannot reset the budget). | New route | The 10:20 hole becomes fillable |
| 4 | **Log poll outcomes into the `event` table**, not stdout. | One insert per poll | Failure modes become tallyable past one deploy |
| 5 | Investigate the restart burst. A restart reliably buys 3–4 consecutive successes then the pattern resumes (17:57/17:59/18:00/18:10, 20:29/20:30/20:40, 06:54/07:00/07:10, 08:17/08:20/08:30; the 10:28 router reboot produced the longest clean run in the record — 10:30/10:40/10:50/11:00). Something accumulates and clears on restart: the router's session table, or Bun's fetch connection pool. **Testable without touching the router**, by restarting only the container. | An afternoon | The actual fix, if it lands |

The "one poll, one fresh login" doctrine in `client.ts` and `DESIGN.md:305-313`
must be corrected in the same commit as any of this. It is not wrong that a held
session was worse; it is wrong that the failure mode was removed.

**Acceptance for Phase 1:** over a 48 h window with no deploys, ≥80% of due polls
stored, p90 sample spacing ≤20 min, and `POST /api/router/poll` returns a fresh
`router_line_sample` within 30 s at p90. **Until those hold, Phase 2 must not be
armed.** At 45.6% and a 13.3-minute expected wait, a watchdog would fail exactly
when the router is stressed — which is when it is needed.

---

## 6. Phase 2 — the watchdog

A native launchd process that watches the record, and when the line has been
demonstrably down long enough with a demonstrably healthy local path, asks the
container to reconnect the WAN or reboot the router — and records what it did.

### 6.1 Placement, and a disagreement worth stating

Two of the analysis passes landed on opposite recommendations.

- **"Put it in the container."** There is already exactly one `RouterClient`, so
  one owner of the router's single admin session; the DB provides a
  tamper-resistant budget; attribution needs no spool. Native placement buys only
  the ability to act while the container is down — which is exactly the state in
  which it must not act (no record to decide from, no way to write the
  intervention, probes spooling rather than landing).
- **"Put it on the host."** The host cannot open the database
  (`src/db/client.ts` refuses by path, see `storage.md`), so the watchdog is an
  HTTP client of `localhost:7731` either way — and *the API container being down
  must not look like the internet being down*. A native process carries its own
  ICMP probe as a second, independent evidence source.

**The resolution is a split, and it satisfies both:**

| Piece | Where | Why |
|-|-|-|
| Decision — classification, ladder, budget, kill switch | native, launchd | independent ICMP evidence; survives the container; the API is one of two sources, never the only one |
| Action — `reconnect`, `reboot` | container, `src/services/router/actions.ts` | one `RouterClient`, one session owner, one place a write can originate |
| Recording | container, `POST /api/interventions` | the record is the container's |

Residual, stated rather than discovered later: **the watchdog is by design unable
to act while the container is down.** That is correct, not a gap.

### 6.2 Files

| Path | Contents |
|-|-|
| `collector/watchdog.ts` | launchd entry point: tick loop, I/O, dispatch. Mirrors `probe.ts`'s shape — dependency-free beyond Bun, own `log()`, own spool, SIGTERM handling |
| `collector/watchdog-ladder.ts` | **pure** state machine. No I/O, no clock, no fetch. This is the file that gets the tests |
| `collector/watchdog-state.ts` | ledger load/save (atomic), the two spools, crash reconciliation |
| `collector/watchdog-probe.ts` | the self-probe, incl. the `ping6` wall-clock kill |
| `collector/watchdog-report.ts` | status file, webhook queue, event payload construction |
| `collector/com.jkrumm.linewatch-watchdog.plist.template` | LaunchAgent |
| `collector/watchdog-ladder.test.ts` | table-driven over `decide()` |
| `src/services/router/actions.ts` | `RouterActionExecutor` (§7) |
| `src/routes/router-actions.ts` | `POST /api/router/poll`, `/api/router/actions/{reconnect,reboot}` |

`watchdog.ts` may import `./vantage.ts`, `./ping-parser.ts`, `./log-rotate.ts` —
all three are pure and `probe.ts` already depends on them. It must **not** import
`src/config.ts` or anything pulling elysia/drizzle.

### 6.3 The pure core

```ts
// collector/watchdog-ladder.ts
export type Rung = 'observe' | 'reconnect' | 'reboot' | 'exhausted'

export type OutageClass =
  | 'healthy'
  | 'partial'              // some but not all v4 WAN anchors down
  | 'no_evidence'          // neither the record nor a self-probe is usable
  | 'off_home_line'        // vantage.onHomeLine is false or null
  | 'local_link_down'      // the gateway itself is unreachable
  | 'carrier_down'         // a fresh router reading says the line is not Up
  | 'full_wan_down'        // v4 down, v6 down, v6 known-good recently
  | 'v4_only_down'         // v4 down, v6 up
  | 'wan_down_v6_unknown'  // v4 down, v6 never observed working

export type WatchdogState =
  | 'boot' | 'normal' | 'suspect' | 'confirmed' | 'pre_announce'
  | 'armed' | 'acting' | 'settling' | 'blocked' | 'exhausted' | 'recovered'

export function decide(input: LadderInput): LadderDecision
export function classify(input: LadderInput): OutageClass
```

`decide()` is total, deterministic, and never throws. `watchdog.ts` is a thin
shell: gather → `decide()` → perform → persist → report. `LadderDecision.blockedBy`
returns **all** failed preconditions in evaluation order — never short-circuited
to the first, because a stand-down whose reason is a single name is a stand-down
you cannot debug at 03:00.

### 6.4 Policy constants, and the measurement behind each

```ts
export const DEFAULT_POLICY: WatchdogPolicy = {
  tickMs: 15_000,
  confirmTicks: 2,
  observeS: 240,
  reconnectSettleS: 360,
  rebootAtS: 600,
  rebootAtSv4Only: 900,
  rebootSettleS: 300,
  exhaustAtS: 900,
  announceLeadS: 60,
  resyncGraceS: 120,
  staleSampleS: 90,
  reconnectMinIntervalS: 3_600,
  reconnectMaxPer24h: 6,
  rebootMinIntervalS: 21_600,
  rebootMaxPer24h: 2,
  postActionCooldownS: 900,
  escalationQuietS: 3_600,
  v6BaselineMaxAgeS: 86_400,
  armed: false,
  rebootEnabled: false,
}
```

| Constant | Value | Justification |
|-|-|-|
| `tickMs` | 15 s | Half the 30 s probe cycle, so every new cycle is seen within ≤15 s with no aliasing. Faster buys nothing — 30 s is the record's own resolution |
| `confirmTicks` | 2 (30 s) | The class must hold across two independent self-probes before a ladder clock starts. Costs zero ladder time because T0 comes from `outage.started_at`, not from the confirmation |
| `observeS` | 240 s | The longest **self-recovery** in the record is 90 s / 3 cycles (`outage` id 1, IPv4 back 14–16 s after showtime, no intervention). 240 s = 8 cycles = 2.7× that. Independently, the 08-01 event was 8-for-8 all-down at the 240 s mark. The asymmetry decides it: waiting 150 s longer costs 150 s of downtime in a true positive; acting at 90 s re-dials a line that was already recovering |
| `reconnectSettleS` | 360 s | The only measured *complete* recovery is human-reboot→IPv4: 10:27:21 → 10:30:08–10:30:34 = **167–193 s**, and that includes a device boot. A re-dial has no boot, so 360 s is ~1.9× the worst measured superset, and ~10× the two measured resync→IPv4 latencies (14–16 s on 07-30, 31–57 s on 08-01) |
| `rebootAtS` | 600 s | `observeS + reconnectSettleS`. Not a round number by choice — it is where the previous rung's settle window ends |
| `rebootAtSv4Only` | 900 s | §6.7 |
| `rebootSettleS` | 300 s | 1.55× the 193 s worst measured reboot→IPv4, and it covers the *multi-phase* reboot the record actually shows: flaps at 10:27:21 / :38 / :42 / 10:28:13 / 10:29:44 / :47 plus three DHCP rebinds ending 10:29:48 — **147 s of churn before the line even resynced** |
| `exhaustAtS` | 900 s | The whole ladder finishes in 15 min. The human intervened at 18m17s from outage start; the ladder is designed to be done escalating before a human would have reached the box |
| `announceLeadS` | 60 s | Reboot rung only. The router allows a single admin session, so a reboot fired while a human is mid-remediation in the web UI is a real hazard. The WAN is already dead at that point, so 60 s costs nothing measurable |
| `resyncGraceS` | 120 s | If a non-stale reading shows `showtime_start_s < 300`, defer the pending rung until showtime+120 s. IPv4 returned 14–16 s after showtime on 07-30 and 31–57 s on 08-01; 120 s is >2× the worst |
| `staleSampleS` | 90 s | Three probe cycles. Beyond that `GET /api/status` describes the past — the collector is wedged, spooling, or the container restarted — and the record stops counting as evidence |
| `rebootMaxPer24h` | 2 | The record contains **one** event of this class in three days. 2/day is ~40× the observed base rate; a breach is a signal to a human, not a workload to automate through |
| `rebootMinIntervalS` | 6 h | A reboot costs every device in the household its LAN |
| `postActionCooldownS` | 900 s | A recovery that holds two cycles and fails again must not be laundered into a fresh independent outage with a fresh budget |
| `v6BaselineMaxAgeS` | 24 h | §6.7 — the guard against reading "IPv6 is not deployed here" as "IPv6 is down" |
| `armed`, `rebootEnabled` | `false`, `false` | Ships in shadow mode. Two independent switches because the reboot rung is the destructive one and §7's write envelope has one unverified field |

### 6.5 Evidence

**From `GET /api/status`** (exists, no change): `ongoingOutages[].{scope,startedAt,cycles,evidence}`
for T0 and the outage identity key; `lastSamples[].{target,scope,ts,received}`
for per-anchor state and record freshness; `vantage.{onHomeLine,pathIf,gatewayAddr}`.

**From `GET /api/router`** (exists, no change): `line.{stale,ageMs}` for
admissibility; `line.value.status` for the carrier veto;
`line.value.showtimeStartS` for the resync grace; `wan.value.{bytesRx,bytesTx,rxKbps}`
for the evidence payload — these are the counters that made the 08-01 diagnosis.
After Phase 0.1, `connStatusV4`/`connStatusV6` corroborate the class from the
carrier side.

**From its own ICMP** (`collector/watchdog-probe.ts`): v4 `ping -c 5 -i 0.2 -W
1000 <addr>` per target in parallel, ~1.0 s wall, parsed with the existing
`parsePingOutput`, **never gating on the exit code**. v6 `/sbin/ping6 -c 5 -i 0.2
<addr>` with **no `-W`** (§4, Phase 0.2) and a self-imposed 4000 ms kill.
`captureVantage({ expectedGateway, report })` from `collector/vantage.ts` gives
the independent `onHomeLine: 0 | 1 | null`. Runs every tick while not `normal`,
and every 4th tick (60 s) in `normal` to keep the v6 baseline warm — ~1 s of
pinging per minute, negligible beside the collector's 4 s per 30 s.

**The load-bearing asymmetry: router data may VETO or DELAY a rung, never PERMIT
one.** A ladder gated on fresh carrier evidence would have been inert for the
entire actionable window on 08-01. Silence from the poller is not evidence.

### 6.6 Classification

Evaluated in order, first match wins:

| # | Class | Condition |
|-|-|-|
| 1 | `no_evidence` | record `=== null` AND self `=== null` |
| 2 | `off_home_line` | `self.vantage.onHomeLine !== 1` OR (record present AND `record.vantage.onHomeLine !== true`) |
| 3 | `local_link_down` | self gateway `received === 0` OR the record's gateway sample `received === 0` |
| 4 | `carrier_down` | a WAN class below would apply AND carrier present AND not stale AND `line.value.status !== 'Up'` |
| 5 | `v4_only_down` | every wan-scoped v4 anchor `received === 0` in both sources AND `self.v6.received > 0` |
| 6 | `wan_down_v6_unknown` | …AND `v6Health === 'unusable' \| 'unconfigured'` |
| 7 | `full_wan_down` | …AND `self.v6.received === 0` AND `v6Health === 'usable'` |
| 8 | `partial` | at least one v4 anchor down, not all |
| 9 | `healthy` | otherwise |

Rules 5–7 additionally require agreement between the record and the self-probe
when both are present. **On disagreement the class is the healthier of the two**
and `blockedBy` gains `record_and_self_disagree`. Disagreement is never resolved
by picking the alarming one.

Three cases deserve naming:

- **"One target is down" vs "the internet is down"** needs no new logic:
  `partial` requires only that one anchor still answers, the same `every()` rule
  `outage-detector.ts:72` already uses. Three anchors on three networks is the
  existing defence against one provider's ICMP deprioritisation; the watchdog
  inherits it and confirms it independently rather than trusting it.
- **"The mini is not on the home line"** is deliberately the strictest gate.
  `probe_cycle.on_home_line` is three-state and `null` means *the collector did
  not report*, not *yes*. Over 5160 cycles: 5152 are `1`, 6 are `0` (07-31
  06:07–07:15, over `en1`), and **2 are NULL — 10:27:34 and 10:28:04 on 08-01,
  i.e. the two cycles inside the router reboot where the collector logged
  `vantage.no_default_route`**. NULL is not a rare theoretical state; it is the
  signature of the very condition the watchdog acts on. Coalescing it is the
  fabrication `CLAUDE.md` names explicitly.
- **"The carrier is down and no local action will help"** is `carrier_down`: a
  **non-stale** `router_line_sample.status !== 'Up'`. A router whose gfast line
  is not in showtime cannot complete a re-dial and will not gain showtime from a
  reboot. Note the asymmetry with the veto rule above: a *stale or missing*
  reading does not produce this class and does not block.

### 6.7 The v4/v6 branch

The watchdog closes the operational half of §3.1's gap without waiting for Phase
0.2, by pinging a v6 anchor itself.

**The baseline guard is not optional.** If IPv6 is simply not deployed on this
line, `ping6` fails forever and every outage would classify as `full_wan_down`.
So the ledger carries `v6.lastUpTs`, updated only from a `healthy` tick:

```
v6Health = self.v6 === null                              -> 'unconfigured'
         : ledger.v6.lastUpTs === null                   -> 'unusable'
         : now - ledger.v6.lastUpTs > v6BaselineMaxAgeS  -> 'unusable'
         : 'usable'
```

`unusable` and `unconfigured` both yield `wan_down_v6_unknown`, never
`full_wan_down`. **The watchdog does not infer a negative from a channel it has
never seen work.**

| Aspect | `full_wan_down` | `v4_only_down` |
|-|-|-|
| reconnect rung | T0+240 s | T0+240 s — *unchanged, and this is the point*: a WAN re-dial is the precisely-targeted remedy if the tunnel is what is wedged |
| reboot rung | T0+600 s | **T0+900 s**, and additionally gated on `policy.rebootOnV4Only` |
| escalation target | the line / the router | the ISP |

Why defer the reboot: a reachable IPv6 anchor proves the physical line is in
showtime, the WAN session is established, the router is routing, and the ISP's
BNG is forwarding. Every layer a reboot could fix is demonstrably working.
Rebooting on top of that is a household-wide LAN outage bought with evidence
pointing elsewhere.

### 6.8 Preconditions

Every predicate is evaluated on every tick and *all* failures are returned.
Nothing short-circuits.

Shared, both rungs:

| # | Predicate | Block reason |
|-|-|-|
| S1 | `~/.config/linewatch/watchdog-disarmed` absent | `disarmed` |
| S2 | `policy.armed === true` | `disarmed` |
| S3 | `self !== null && self.vantage.onHomeLine === 1` | `off_home_line` |
| S4 | record absent, or `record.vantage.onHomeLine === true` | `off_home_line` |
| S5 | self gateway `received > 0` | `gateway_down` |
| S6 | record gateway sample `received > 0`, or the record is stale/absent | `gateway_down` |
| S7 | record fresh within `staleSampleS`, **or** a self-probe alone is admitted | `no_evidence` |
| S8 | class ∈ {`full_wan_down`, `v4_only_down`, `wan_down_v6_unknown`} | — |
| S9 | carrier absent, or stale, or `status === 'Up'` | `carrier_down` |
| S10 | carrier absent, or stale, or `showtimeStartS >= resyncGraceS` | `resync_grace` (a **delay**, re-evaluated; not terminal) |
| S11 | `ledger.pending === null` | `settling` |
| S12 | `now >= ledger.postActionCooldownUntil` | `post_action_cooldown` |
| S13 | executor capability is `live` | `executor_unavailable` |

Reconnect rung, additionally:

| # | Predicate |
|-|-|
| R2 | `now - T0 >= observeS` (240 s) |
| R3 | `ongoingOutages[wan].cycles >= 8`, **or** the record is unavailable and the self-probe has been all-down for ≥8 consecutive ticks |
| R4 | no reconnect within `reconnectMinIntervalS` |
| R5 | reconnects in the last 24 h < `reconnectMaxPer24h` |

R3 is the belt on R2's braces: the timer says "long enough", the cycle count says
"and we measured it that many times". They disagree exactly when the collector was
down for part of the window — which is the case where acting would be wrong.

Reboot rung, additionally:

| # | Predicate |
|-|-|
| B2 | `policy.rebootEnabled === true` — the independent second switch |
| B3 | `now - T0 >= (class === 'v4_only_down' ? 900 : 600)` |
| B4 | `ledger.ladder.rung === 'reboot'` — rung 1 was reached and either executed or was itself blocked and reported. **The ladder is never skipped** |
| B5 | no reboot within 6 h |
| B6 | reboots in the last 24 h < 2 |
| B7 | the `announceLeadS` notification was emitted ≥60 s ago |
| B8 | class !== `v4_only_down`, or `policy.rebootOnV4Only === true` |

Failing B5/B6 does not stall the machine — it goes straight to `exhausted` with
`blockedBy: ['rate_limit_*']` and escalates to a human, which is the correct
behaviour for "this has happened three times today".

### 6.9 State machine

| From | Condition | To | Side effect |
|-|-|-|-|
| `boot` | `ledger.pending !== null` | `settling` | reconcile: convert pending to `actions[]` with `outcome:'unknown'`, count it against the rate limits, enter that rung's settle window |
| `boot` | otherwise | `normal` | |
| `normal` | class is any WAN/link/carrier class | `suspect` | start `confirmTicks` |
| `suspect` | held `confirmTicks`, both sources agree | `confirmed` | T0 := `outage.startedAt` if present else `now`; emit `poll_router`; set `outageKey = "wan:<T0>"` |
| `suspect` | class back to `healthy`/`partial` | `normal` | |
| `confirmed` | a hard block applies | `blocked` | report once |
| `confirmed` | reboot rung due, announce not yet served | `pre_announce` | notification + `note` event |
| `confirmed`/`pre_announce` | due, all preconditions pass | `armed` | write `ledger.pending`, **fsync**, then dispatch |
| `armed` | dispatch returns | `acting` → `settling` | write `intervention` event with the outcome |
| `settling` | `now >= settleUntil` and still down | `confirmed` | advance rung |
| `settling` | class `healthy` | `recovered` | |
| `confirmed` | `now - T0 >= exhaustAtS`, or every remaining rung is rate-limited out | `exhausted` | `escalate`, throttled by `escalationQuietS` |
| any | class `healthy` for 2 ticks | `recovered` | write the outcome `note`, clear the ladder, set the cooldown |
| `recovered` | cooldown elapsed | `normal` | |
| any | disarmed | unchanged | force `action.kind = none`, log `would_<rung>`, write a shadow `note` |

**Probe evidence does not advance a rung while `settling`.** The box is
rebooting; of course it is down. It still feeds classification, for the record
and for detecting recovery.

`nextEvaluationAt = min(now + tickMs, rungDueAt, settleUntil, announceAt)` so the
loop never oversleeps a boundary.

### 6.10 Persistence

Ledger at **`~/.local/state/linewatch/watchdog-state.json`**, mode 0600:

```ts
interface Ledger {
  version: 1
  ladder: { outageKey: string | null; t0: number | null; rung: Rung
            enteredAt: number; settleUntil: number | null; announcedAt: number | null }
  actions: Array<{ ts: number; kind: 'reconnect' | 'reboot'; outageKey: string
                   outcome: 'executed' | 'failed' | 'not_executed' | 'unknown' }>  // trimmed to 48 h
  pending: { ts: number; kind: 'reconnect' | 'reboot'; outageKey: string } | null
  v6: { lastUpTs: number | null; lastCheckedTs: number | null }
  postActionCooldownUntil: number | null
  lastEscalationTs: number | null
}
```

Not `collector/` beside `spool.jsonl`: the repo directory is not durable state. A
`git clean -xfd`, a re-clone or a moved checkout resets the file, and **a reset
reboot budget is the one failure that turns this from a watchdog into a reboot
loop**. `spool.jsonl` can afford that (worst case: lost samples); the ledger
cannot. Not `~/.config/linewatch/` either — that is a chmod-600 secrets directory
and a file rewritten every 15 s does not belong beside credentials. Override with
`LINEWATCH_WATCHDOG_STATE_PATH` for tests.

**Atomic write:** `writeFileSync(tmp)` → `fsyncSync` → `renameSync`. The rename
half is the pattern `replaySpool()` already uses at `collector/probe.ts:482-484`;
the `fsync` is added because unlike the spool, this file's loss is not
recoverable by re-sending.

**Crash reconciliation fails toward having acted.** `pending` is written and
fsync'd *before* dispatch. At boot a non-null `pending` becomes an action with
`outcome: 'unknown'`, counts against the rate limits, and enters the settle
window. That is the deliberate inverse of the spool's fail-toward-resending: a
probe batch is idempotent (`probe_cycle.ts` is UNIQUE, ingest returns `skipped`);
a router reboot is not.

**Two spools, deliberately separate**, same shape as `collector/probe.ts:443-491`:

| Path | Carries | Drains against |
|-|-|-|
| `~/.local/state/linewatch/watchdog-events.jsonl` | `intervention` / `note` rows | localhost — usually up during a WAN outage |
| `~/.local/state/linewatch/watchdog-notify.jsonl` | webhook payloads | the WAN — **by definition down when it matters** |

Separate so an API hiccup cannot stall notifications and a dead webhook cannot
stall the record. Every delayed notification carries `delayedMs` and its original
`ts` — **it must never arrive looking live.**

### 6.11 Recording

`POST /api/interventions` at `src/routes/interventions.ts:40` hardcodes `source:
'manual'` and accepts no `detail`. **A watchdog posting there is recorded as a
human with a plug** — the exact attribution lie the route exists to prevent.
Extend it:

```ts
const InterventionBody = z.object({
  kind: z.enum(['intervention', 'note']).default('intervention'),
  source: z.enum(['manual', 'watchdog']).default('manual'),
  action: z.string().min(1),
  note: z.string().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  ts: z.number().int().optional(),
})
```

**No migration.** `drizzle/0000_dapper_molecule_man.sql:4` is bare `kind text NOT
NULL` with no CHECK, and `src/db/schema.ts:227-229` already enumerates
`'intervention' | 'link_change' | 'config_change' | 'note'`. `DESIGN.md:297-299`
reserves `note` for exactly this phase. `GET /api/events` already lifts
`detail.source` into a top-level field (`src/routes/events.ts:53-58`), so
`source: "watchdog"` renders in the timeline with no route change.

**`kind: 'intervention'` is written only for an action actually attempted against
the router.** Everything else — blocked, shadow-mode, escalation, outcome — is
`kind: 'note'`. This preserves `intervention`'s meaning as "something was done to
the line", which the dashboard's attribution logic depends on.

```json
{
  "source": "watchdog",
  "action": "router_reconnect",
  "rung": "reconnect",
  "outcome": "executed",
  "capability": "live",
  "trigger": { "outageKey": "wan:1785578944000", "outageId": 4, "scope": "wan",
               "startedAt": 1785578944000, "downForS": 241, "cycles": 8,
               "class": "v4_only_down" },
  "evidence": {
    "record":  { "lastSampleTs": 1785579180000, "wanTargetsDown": ["cloudflare","google","quad9"],
                 "gatewayReceived": 20, "onHomeLine": true, "pathIf": "en0" },
    "self":    { "probeTs": 1785579186000, "wanTargetsDown": ["cloudflare","google","quad9"],
                 "gatewayReceived": 5, "v6": "up", "onHomeLine": 1 },
    "carrier": { "observedAt": 1785579001000, "ageMs": 185000, "stale": false, "status": "Up",
                 "showtimeStartS": 23, "connStatusV4": "Connecting", "connStatusV6": "Connected",
                 "wanBytesRx": 0, "wanBytesTx": 0 }
  },
  "guards": { "reconnectsLast24h": 0, "rebootsLast24h": 0, "sinceLastRebootS": null },
  "blockedBy": [],
  "note": "8 consecutive all-WAN-down cycles, IPv6 reachable, line in showtime for 23 s"
}
```

`evidence.carrier` is `null` when no admissible reading existed — **never a
fabricated one**. `evidence.self.v6` is `"up" | "down" | "unusable" |
"unconfigured"`, never a boolean, because "unusable" and "down" are different
facts.

`note` actions:

| `action` | Written when |
|-|-|
| `would_reconnect` / `would_reboot` | shadow mode or disarmed: every precondition passed and the action was suppressed. **This is what makes shadow mode worth running** |
| `blocked` | a rung was due and a hard precondition failed; `blockedBy` names all of them |
| `announce_reboot` | 60 s before the reboot rung; `detail.firesAt` set |
| `escalated` | `exhausted` reached; `detail.reason` ∈ `ladder_complete` / `rate_limit_daily` / `carrier_down` / `local_link_down` |
| `recovery_observed` | on `recovered`. `detail.outcome.attributedTo` ∈ `reconnect` / `reboot` / **`self_recovery`** — the last whenever recovery landed with no action in the ladder. The record must not credit the watchdog for a line that fixed itself; that is the same failure `POST /api/interventions` was built to prevent for humans |

### 6.12 Kill switch

Three layers, independent, decreasing blast radius.

1. **`make watchdog-disarm`** (or `touch ~/.config/linewatch/watchdog-disarmed`,
   optionally `REASON="working in the router UI"`). Checked **at the top of every
   tick and again immediately before dispatch**, not once at startup — so it
   takes effect within ≤15 s and cannot be beaten by a rung already armed. The
   process keeps running, keeps classifying, keeps writing `would_*` notes.
   Disarmed is not silent. `make watchdog-arm` removes it.
2. **`LINEWATCH_ROUTER_WRITE` unset** (the default) makes both action routes
   return 403 with `capability: 'null'`. Independent of the host process
   entirely: a runaway watchdog still cannot write to the router. This is the
   switch that matters if the watchdog itself is what broke.
3. **`make watchdog-teardown`** — `launchctl bootout gui/$UID/…` and remove the
   plist. Use the modern `bootout`/`enable`/`bootstrap` triple, **not legacy
   `load`/`unload`**: `Makefile`'s `collector-setup` target already documents
   (lines 461-473) that a disabled override in launchd's per-user database is
   skipped **silently** and only `enable` clears it. That trap already cost this
   repo one agent after a reboot; do not reintroduce it in a second plist.

Also `LINEWATCH_WATCHDOG=0` in the plist → log `disabled`, exit 0.

### 6.13 Reporting on a headless mini

| Channel | Works during an outage | Carries |
|-|-|-|
| `~/Library/Logs/linewatch-watchdog.log` | yes | one JSON line per state change plus every decision with `blockedBy`. Bounded by reusing `rotateLogIfNeeded` from `collector/log-rotate.ts` verbatim. **`LINEWATCH_WATCHDOG_LOG_PATH` must equal the plist's `StandardOutPath`** — launchd opens the path once with `O_APPEND` and never reopens, the same invariant the collector's plist spells out |
| `~/.local/state/linewatch/watchdog-status.txt` | yes | rewritten atomically every tick: state, class, T0, seconds down, current and next rung, every active `blockedBy`, 24 h action counts, armed/disarmed. This is what `make watchdog-status` prints |
| `event` rows via `POST /api/interventions` | yes (localhost) | the durable record; surfaces via `GET /api/events` |
| `LINEWATCH_WATCHDOG_NOTIFY_URL` webhook | **no — that is the point** | queued to `watchdog-notify.jsonl`, delivered on recovery with `delayedMs` set. linewatch stays agnostic about the far end |

`make watchdog-status` is the one command a human runs over Tailscale. The line
that matters most in its output is `attributed: self_recovery` — that is what
tells you whether shadow mode's numbers are any good.

### 6.14 Ranked failure modes

Not an appendix. These are the reasons the phases and switches above exist.

| # | Failure | Severity | Scenario | Mitigation |
|-|-|-|-|-|
| 1 | **Reboot loop during a long ISP outage locks the user out of the mini** | critical | ISP down 4 h. Gateway up, all WAN anchors down — preconditions satisfied *correctly*, continuously. The watchdog reboots; the reboot takes the gateway down for 90 s (measured, `outage` id 5), preconditions go false, ladder resets; 90 s later the gateway is back, WAN still down, ladder re-arms from the top. With a rolling 1 h cooldown that is 4 reboots. The user's only route to the mini is Tailscale over this router, which dies for ~90 s each cycle, and the machine that would run the kill command is the one behind the router | The escalation cap is a **latch, not a rolling window**: after 2 actions without ≥30 consecutive clean minutes (60 cycles), write `~/.config/linewatch/watchdog-disarmed` and refuse everything until `make watchdog-arm`. Exclude the gateway-down cycles a reboot itself causes from ladder re-arming. `watchdog-disabled` as an unconditional pre-action check, stoppable by a single `touch` from a phone during the 90 s the link is up |
| 2 | **The factory-reset opcode is reachable through the same envelope as every read** | critical | `/js/gdprProxy.js` routes `go`, `gl`, `gs`, `so`, `ao`, `do`, `op` and `cgi` all to `/cgi_gdpr?9`; the verb is a field inside the AES body. **A URL allowlist, a proxy rule or a firewall rule buys exactly nothing.** The natural implementation widens `RouterOperation` and adds `client.act(oid, …)` — at which point all eight `read(oid, operation)` call sites in `poll.ts` are one argument from an action, `oid` is a free `string`, and reset constants are lexical copy-paste neighbours in the router's own JS | §7's whitelist rule, in full |
| 3 | **An action fired but not recorded — and a crash between firing and recording double-fires** | critical | (a) The reboot takes the LAN down while the `POST /api/interventions` is in flight. Probe samples survive (the collector spools); **interventions do not spool at all**. The record then shows an outage that ended spontaneously — verbatim the failure the route was built to prevent, and it already happened once for a human on 08-01. (b) The reboot command's socket closes without an ack (documented behaviour, `classifyTransportFailure`), the process crashes, launchd restarts it, in-memory state is gone, it fires reboot #2 into a router already rebooting | Write-ahead, fsync, then act (§6.10). Start cooldowns from the **attempt**, never the ack. Treat an un-acked action as **fired**. Spool the intervention, and make a successful *local* spool write a hard precondition of acting: **no attribution possible means no action** |
| 4 | **The watchdog reboots the router out from under the human troubleshooting it** | critical | One admin session, every login force-evicts the holder. On 08-01 the poller logged in at 10:10:01 and 10:30:00, inside the window the user spent in the router UI. Worst case the reboot lands mid-firmware-flash and the router does not come back | You **cannot** detect a human on this router — the 2-on/2-off failure pattern runs unbroken all night with nobody present, so poll failures are not a presence signal. So require an explicit quiet period instead: stand down 30 min after any `intervention` event (the human already tells you, via `make intervention`); add `make watchdog-hold [MIN=60]`; announce-then-wait 60–120 s with an abort file; and never reboot without a successful full poll in the last 60 s — proof the control path is currently yours |
| 5 | **Acting when the mini is not on the home line, and NULL is the ambiguous case** | high | The failover variant is the nasty one: the mini fails over to a travel router or hotspot that also uses 192.168.1.0/24 with gateway 192.168.1.1. The gateway target answers, all three anchors fail because that uplink has no signal, and a watchdog gated only on "gateway up, WAN down" reboots a home router that is working perfectly, in an empty house | §6.8 S3–S6, plus `path_class === 'ethernet'`, `gateway_addr` equal to the configured home gateway, `link_watch_s ≥ cycle − 1 s` for every cycle (`DESIGN.md`: no recorded transition means "none above 1 Hz resolution", *not* "the link was stable" — demand positive coverage rather than treating absence as evidence), and no gap in cycle timestamps |
| 6 | **Each firing destroys the evidence that diagnosed the last incident** | high | A reboot resets `showtime_start_s`, zeroes every `router_intf_sample` byte counter, and empties the host table. **The 08-01 incident was solved by precisely those counters.** Reboot hourly during a long fault and "has this line been stable for three days or retraining constantly?" becomes permanently unanswerable. Worse, `detectResync`'s strict `<` means frequent reboots (small showtime values, likely to repeat) record no resync at all | A full pre-action snapshot is a **hard precondition**, not a nicety: force a complete poll, require it to have persisted a `router_line_sample` and both `router_intf_sample` rows, and store the counter values inside the intervention `detail` as well. If the snapshot fails, do not act — you cannot write to a control path you cannot read. It also fixes the coverage problem for free at exactly the moment a fresh reading is most valuable, which the 10:20 failure denied |
| 7 | **The control path is unreliable exactly when needed, and two clients evict each other** | high | 45.6% per-attempt success, 13.3 min expected wait, p90 40 min. At 10:20 on 08-01 — the one moment it mattered — the login failed. Add a second client: the watchdog authenticates at 10:19:58, the container poller at 10:20:00 and evicts it, the reboot fails with a closed socket, and the watchdog cannot tell "it did not land" from "it landed and the socket closed" | Single-ownership: the action lives **in the container** (§6.1) so exactly one `RouterClient` exists. Treat an un-acked action as fired. And ship Phase 1 first — the watchdog's authority currently exceeds its instrumentation |
| 8 | **The reconnect rung reproduces the fault it is meant to clear** | high | `ACT_PPP_DISCONN`+`ACT_PPP_CONN` tears down and recreates `ppp0`. **That is byte-for-byte the state the 08-01 incident consisted of** — the router did it unprompted at 10:09:38 and the outage continued 18.5 min. If the wedge is "ppp0 comes back but the tunnel does not", a forced re-dial deterministically re-enters it. A re-dial also changes the public IPv4 address and can change a delegated IPv6 prefix, invalidating every LAN device's GUA — breaking IPv6 for the whole house to fix an IPv4 problem | Do not ship the reconnect rung until Phase 0.1 lands and the record can tell the layers apart. Run it in dry-run and require evidence a reconnect has *ever* helped. Cap reconnects harder than their cost suggests, and record pre/post public IP and prefix in `detail` |
| 9 | **The router password reaching a native script by the wrong route hangs it or leaks it** | high | (a) `op read` on the headless mini **hangs** on a biometric prompt with no human to approve it; a `KeepAlive` job blocks forever holding the ladder while still looking healthy. (b) the plist's `EnvironmentVariables` is a readable file and `launchctl print` exposes a job's environment. (c) a future "log the request body on failure" — the login body carries `Passwd: b64(password)`, trivially reversible, and `~/Library/Logs/linewatch-collector.log` is mode **0644**. `redact.ts` only redacts router *responses* | Read `~/.config/linewatch/router-password` directly — already 0600, already the source of truth `make env` copies from, and the reason `src/services/router/config.ts` documents for not depending on a secrets cache. **Never `op`, never `secrets-run`, never the plist, never argv, never the repo `.env`.** Explicit "no request-body logging on the action path" comment at the send site |
| 10 | **Rate limits in host local time against a UTC database** | medium | Host is CEST, container and every stored `ts` are UTC (verified: `datetime('now','localtime')` in the container equals `datetime('now')`). "At most 2 reboots per calendar day" computed with `date +%F` rolls over at 22:00 UTC. At the Berlin DST fall-back, local 02:00–03:00 happens twice, so an hourly budget grants double. And the mini now auto-logs-in after a power cut: if NTP has not converged, `Date.now()` can jump | All budget arithmetic in epoch ms against fixed durations — never calendar days, never local hours. Cross-check the local ledger against the newest watchdog `intervention` row and take the **more restrictive** of the two, so a wiped state file cannot grant a fresh budget. Refuse to act if `now < lastActionAt` |
| 11 | **An action during an in-flight speed test poisons the throughput history** | medium | Tests are hourly, 8–16 s, 42–275 MB. A run completing seconds after PPP came back records `ok=1` at a genuinely low rate and contributes to `GET /api/speedtests/summary`'s p50/p95 as if it measured the line. `speedtest-runner.ts` guards concurrency with a module-scope `let running` **inside the container**, invisible to anyone else. Inferring from "newest `speed_test` row is younger than 90 s" is exactly wrong — the row is written at the *end* | Expose `speedtestRunning` on `GET /api/status` and refuse to act while true, waiting out the ~20 s. Record the ladder window in the intervention `detail` so overlapping rows can be excluded after the fact |
| 12 | **State in the repo, and a crash loop that becomes a fire loop** | medium | The obvious symmetry puts ladder state beside `collector/spool.jsonl`; a `git clean` then resets the budget. Independently, the collector plist sets `KeepAlive` with no `ThrottleInterval`; a watchdog crashing on a parse error restarts in seconds, and if its first act on boot is to evaluate the last 20 minutes from the database, a crash loop becomes a fire loop | §6.10's path. Set `ThrottleInterval`. **Require the escalation window to consist of cycles the running process observed itself** — never act on the first evaluation after start, never on cycles predating process start. That one rule kills both the crash-loop and the stale-history paths |
| 13 | **Watchdog actions indistinguishable from human ones** | medium | `interventions.ts:40` hardcodes `manual`. Six months later, answering "does rebooting actually fix this?" — the entire justification for the watchdog existing — three real human interventions and forty machine reboots are indistinguishable | §6.11 |
| 14 | **The trigger is blind to a degraded line, and fixing that re-introduces false positives** | medium | `outage-detector.ts:72` requires **every** WAN target at zero received. A line at 95% loss never opens an outage and the watchdog never fires while the connection is unusable. But the obvious fix walks into the opposite failure: 09:38:34 on 08-01 was 40/45/40% with a clean gateway and self-healed in ~2 s | **Do not widen the trigger in v1.** Ship the strict all-three-at-100% condition and state the blind spot rather than discovering it during a bad month. If degradation is ever added: ≥20 consecutive cycles, and reconnect-only, never reboot |
| 15 | **The decision code runs for real about once a month** | medium | One qualifying event in the whole database. The ladder, the snapshot, the spool, the latch and the contention handling all go weeks without executing, get refactored around, and are first exercised in anger at 03:00 while holding the power to reboot the user's only route home | Run the full decision function in dry-run on **every** cycle and log the verdict plus the failing precondition, so the logic executes 2880×/day. Add `make watchdog-dryrun FROM=… TO=…` replaying stored windows, and assert three outcomes in the test suite: **fires** on 08-01 10:09–10:27, **does not fire** on the 07-30 90 s outage, **does not fire** on the 07-31 Wi-Fi cycles |
| 16 | **Reboot-driven renumbering breaks the mini's own instrumentation** | low | The observed reboot produced three DHCP re-binds. If the mini's LAN address changes, `LINEWATCH_COLLECTOR_HOST_IP` stops matching, the poller's vantage cross-check starts logging fabricated disagreements, and `GET /api/router`'s `collectorHost` goes permanently stale — caused by the watchdog's own action. Colima's VM sits behind another NAT layer and need not recover its outbound path cleanly | Pin the mini's address by DHCP reservation before enabling reboots. Verify after each action that the collector host still holds the configured IP, and record a mismatch in the outcome |

### 6.15 Order of work

| # | Change | Blocks |
|-|-|-|
| 1 | Extend `POST /api/interventions` with `kind` / `source` / `detail` | everything — without it every watchdog action is recorded as a human's |
| 2 | `POST /api/router/poll` (new `src/routes/router-actions.ts`), bearer + 60 s limit | the carrier veto and the pre-action snapshot |
| 3 | `src/services/router/actions.ts` with **`NullExecutor` only**; the two action routes behind `LINEWATCH_ROUTER_WRITE` | both rungs |
| 4 | `collector/watchdog-ladder.ts` + tests — pure, no I/O | |
| 5 | `collector/watchdog-{probe,state,report}.ts`, `watchdog.ts` | |
| 6 | plist template + `make watchdog-{setup,teardown,arm,disarm,hold,status,logs,dryrun}` | |
| 7 | Ship with `armed=false`. **≥2 weeks of shadow mode.** Read every `would_*` note before arming | |
| 8 | Phase 0.1 / 0.2 upgrade the evidence; neither blocks the ladder | |
| 9 | `LiveExecutor` — only after §7's remaining unknown is settled | the rungs doing anything |
| 10 | Doc edits **in the same commits**: `CLAUDE.md`'s bearer-route list (now four routes), the "the router poller is read-only against the router" sentence in `CLAUDE.md` **and** `DESIGN.md`, the `DESIGN.md:297` note that `note` is now written, the API route table at `DESIGN.md:348`, and `DESIGN.md:305-313`'s claim about the fresh-login fix | |

Item 10 is not bookkeeping. `CLAUDE.md` currently says `grep -rn hasValidBearer
src/` is the source of truth for the bearer list, and it will be — the doc has to
follow it. And "the router poller is read-only against the router" must become
*the poller stays read-only; writes live in a separate module, off by default*.
**Do not let an invariant quietly become false.**

---

## 7. The write envelope

The body shape, the endpoint and the crypto are **settled from the device's own
firmware plus TP-Link's published emulator of this exact model**. No packet
capture is needed for any of that. One field value is not in the record and must
be read at runtime.

All of this came from read-only GETs of static assets on 192.168.1.1 (a
browser-like User-Agent **and** a `Referer: http://192.168.1.1/` header returns
200; without the Referer, 406), the emulator's public webroot, the repo, and the
database. **Zero POSTs were issued and no login was performed.**

### Confirmed from firmware

TP-Link publishes a VX800v emulator at `https://emulator.tp-link.com/VX800v-Emulator/`
— the exact model, whole webroot public and unauthenticated. Its `main/*.htm` are
the real firmware page sources (only `js/proxy.js` is stubbed to a local XML
mock). The live unit's `/main/*.htm` are auth-gated, which is why an earlier pass
could not reach the call sites. Cross-validated against the **live** device's
`/js/proxy.js`, whose `$.dm` transport is the same design.

- **`op` is a first-class operation in the JSON dialect the repo already
  speaks.** `main/restart.htm`: `$.dm.op({oid: ACT_OP_REBOOT})`. `main/sysMode.htm:109`:
  `$.dm.op({oid: 'ACT_REBOOT', data: {}})`.
- **One URL for everything.** Live `/js/proxy.js:904` has `op: {operation: "op"}`
  in the `$.dm` method map alongside `go`/`gl`/`gs`/`so`/`ao`/`do`/`cgi`, and
  `:818` is `url: "/cgi_gdpr?9"` — one constant for every operation. `:827/828`
  fill `data.stack`/`data.pstack` with `"0,0,0,0,0,0"` when absent, then
  `JSON.stringify(data) + "\r\n"`.
- **`?9` is a dialect marker, not an action code, and does not change for
  writes.** Proof from `gdprProxy.js`'s `exe()`: the non-GDPR branch builds `url
  = "/cgi?" + type`; the GDPR branch appends the type to the **body** instead
  (because a query string cannot be encrypted) and trims `url` to bare
  `/cgi_gdpr`. `$.dm.Proxy.setup` then uses the literal `/cgi_gdpr?9` for all
  eight verbs. Corroborated externally by `tplinkrouterc6u`'s `client/ex.py:401`.
- **The plaintext body is exactly the shape `readWith()` already builds:**
  `{"data":{"stack":"<stack>","pstack":"0,0,0,0,0,0"},"operation":"op","oid":"ACT_PPP_CONN"}\r\n`
  and `{"data":{"stack":"0,0,0,0,0,0","pstack":"0,0,0,0,0,0"},"operation":"op","oid":"ACT_REBOOT"}\r\n`.
- **Independent proof that ACT ops travel this path:** live `proxy.js:648` is
  `var ifIgnoreAjaxErr = ((ajaxSettings.data.indexOf("ACT_REBOOT") != -1) || ...)`
  — the firmware string-searches for `ACT_REBOOT` inside the serialized `$.dm`
  JSON.
- **The envelope is identical for reads and writes.** Live `/js/tpEncrypt.js:151-170`:
  non-login `sign` is `RSA("h=" + md5(user+password) + "&s=" + (seq + base64Length))`
  — no `key=`/`iv=` prefix, matching `client.ts:364-366`. **`seq` is never
  incremented per request**; only `+ base64Length` varies. `TokenID` is set
  unconditionally for both dialects. `Content-Type: text/plain`, `sign=…\r\ndata=…\r\n`.
  AES-128-CBC/PKCS7 applies to *all* `$.dm` traffic, not just login.
- **The reconnect op takes the `DEV2_ADT_WAN` instance's own `stack`.** Emulator
  `main/wan.htm:622-700` branches on `connType`: `DHCP` → `ACT_OP_DHCP_RENEW`;
  `PPPoE`/`PPPoA`/`IPoA`/`StaticIP` → `ACT_OP_PPP_CONN`; `L2TP` → `ACT_OP_L2TP_CONN`;
  `PPTP` → `ACT_OP_PPTP_CONN`. `$.wd.dslWan` is populated at `:114-121` from
  `$.dm.getList({oid:'DEV2_ADT_WAN'})`, and the sibling delete handler at `:610`
  uses that same `stack`. The mirror handler at `:740` is `ACT_OP_PPP_DISCONN`.
- **`ACT_REBOOT` takes no stack** (defaults to all zeros).
- **`ACT_REBOOT`/`ACT_FACTORY_RESET` are the only ops whose transport error the
  firmware deliberately swallows** (`proxy.js:648,706`) — the device dies before
  answering. `client.ts` would take that dead socket through
  `classifyTransportFailure()` and log a false eviction. **A reboot path must
  treat "no answer" as success.** PPP ops get no such exemption: `wan.htm`
  reloads 1.5 s later, so a normal JSON reply is expected.
- **There is no ACT_OP for the DS-Lite softwire at all.** It is a separate object,
  `DEV2_DSLITE_INTFSET` at stack `1,0,0,0,0,0` (`main/ipv6Tunnel.htm:773`), bound
  to a `DEV2_ADT_WAN` row by interface name, and the UI enables/disables it with a
  `$.dm.set` pair at `:1171-1200`. So the only levers are a PPP bounce on the
  carrier, a *persistent config write*, or a reboot.

### Inferred, not proven

- That the emulator's firmware build matches this unit's. The pages are
  model-specific and the live `proxy.js` agrees structurally, but the emulator is
  a marketing snapshot.
- That a `$.dm.op` from a non-browser client is accepted. Every ingredient is
  verified independently; the composed request has never been observed on the
  wire. (The browser adds one field the repo omits: `dutPrefilter` sets
  `"isuseractive": true` at top level when a click preceded the request. Reads
  prove the router does not require it.)
- That `ACT_PPP_CONN` alone re-dials rather than being a no-op on an already-up
  session. The UI's two buttons imply a DISCONN→CONN pairing but nothing states it.

**Do not import `tplinkrouterc6u`'s `vr1200v.py:47` behaviour**, which overrides
the hash to `md5(username + token)` post-login. This firmware uses
`md5(user + password)` throughout — the repo's working reads prove it.

**Do not use the bracket dialect.** The legacy `$.act`/`$.exe` client posts to
`/cgi_gdpr` with *no* query and the action type as the first body line
(`7\r\n[ACT_REBOOT#0,0,0,0,0,0#0,0,0,0,0,0]0,0\r\n`). This firmware's post-login
UI uses the JSON dialect.

### Unverified, and blocking a safe first write

**The live `DEV2_ADT_WAN` stack and `connType` for this line.**

- `DEV2_IP_INTF`'s `ppp0` stack is **4** — confirmed live (`SELECT name, stack
  FROM router_intf_sample` → `ppp0 | 4`, `br0 | 1`). **This is the wrong stack for
  the op** and is the trap here.
- `DEV2_ADT_WAN`'s stack is never persisted (`parseLiveWan` drops it). The
  `3,0,0,0,0,0` in `src/services/router/fixtures.ts:78` is a **sanitised** fixture
  (3 rows of a documented 6) and cannot be confirmed against the device.
- `connType` is likewise unverified. The fixture says `PPPoE` with `ifName:
  ppp0`, which is consistent, but `name: ipoe_ptm_0_0_d` is an IPoE-flavoured
  label. **If the real `connType` is `DHCP`, `ACT_PPP_CONN` is the wrong verb
  entirely** and `ACT_DHCP_RENEW` is correct.

**Never hardcode the stack.** The control path must `read('DEV2_ADT_WAN','gl')`,
pick the live row, take *its* `stack`, and branch on *its* `connType` exactly as
`wan.htm` does — refusing outright if `connType` is not in the whitelist.
`redactRow` passes `stack`, `connType` and `accessMode` through untouched, so the
existing client already returns everything needed.

### The evidence that would settle the rest

| Option | Risk | Yields |
|-|-|-|
| **A — Phase 0.1** (persist `stack`, `connType`, `accessMode`, `connStatusV4/V6` from the poll that already happens) | none; no write, no browser | The only *blocking* unknown. **Do this first.** |
| **B — browser hook, log-and-abort** | none; no request leaves the browser | The literal body byte-for-byte. Log into the router UI, open the WAN page, and in DevTools wrap `jQuery.ajax` to `console.log(settings.url, settings.data)` and return a rejected deferred **before** touching the buttons. Then click Disconnect/Connect |
| **C — click for real** | **a real action** — equivalent to a manual reconnect | Whether the router accepts it and whether it works |

### The safety rule — a closed whitelist

This is not a style preference. `/js/gdprProxy.js` routes read verbs and
`ACT_FACTORY_RESET` to the same URL, discriminated only by a string inside an
AES-encrypted body. **No network-layer control — allowlist, proxy rule, firewall
rule — can distinguish them.** The current `RouterClient` is safe purely by
omission: `RouterOperation = 'go' | 'gl' | 'gs'` and the write verbs are simply
unimplemented.

Binding rules for `src/services/router/actions.ts`:

1. **Do not widen `RouterOperation` to include `'op'`.** Actions live in a
   separate module with a separate class that has **no `read()`** and does not
   share the read client's surface.
2. **Expose zero-argument named methods only** — `wanReconnect()`, `reboot()`.
   No `performAction(oid: string)`. The OIDs are module-private `const` literals.
3. **No OID from anywhere else.** Not env, not config, not the DB, not a CLI arg,
   not a Makefile variable. `make watchdog-*` targets take **no** OID parameter.
4. **Back the type layer with a runtime assertion** in the single function that
   sends `operation: 'op'` — types are erased, and a parsed config is `any` at
   runtime. The assertion checks membership in the literal whitelist
   `{ACT_PPP_CONN, ACT_PPP_DISCONN, ACT_DHCP_RENEW, ACT_REBOOT}` and throws
   otherwise.
5. **A test that greps the whole `src/services/router/` tree for
   `/FACTORY|RESET|DEFAULT|RESTORE|UPGRADE|FIRMWARE/i` and fails on any hit
   outside the test file itself.**
6. **Never implement `so` / `ao` / `do`.** They can rewrite WAN credentials,
   DS-Lite config and firewall rules, and they buy the watchdog nothing.
7. **Capture the real `ACT_*` names into a fixture and test against them.** They
   could not be confirmed from the login-page bundle: `/js/oid_str.js` (88 KB)
   contains only three `ACT_*` constants — `ACT_AUTO_CHAN_SELECTION`,
   `ACT_REWRITE`, `ACT_SAME_MODE_WAN` — and none of `lib.js`, `oid_str.js` or
   `gdprProxy.js` mentions reboot or factory reset. The namespace pattern is real
   (`lib.js:2767` uses `$.act(ACT_OP, ACT_OP_DIAG_DNSDIAG, …)`) and the emulator
   supplies the names, but **typing them from memory is exactly the class of
   mistake rule 5 exists to catch.**
8. **`NullExecutor` ships first.** It logs, returns `{ok: true, capability:
   'null'}`, and the route records `outcome: 'not_executed'`. This makes the
   entire ladder exercisable end-to-end against the real router without ever
   writing to it — which is how you find out whether 240 s and 600 s are the
   right numbers before they can cost anything.

### Would a reconnect have helped on 08-01?

Almost certainly not. At 10:10:01 — 23 s after the resync — `ppp0`'s counters had
already reset from 29.4 GB to zero. **The router had already performed,
unprompted, the exact thing `ACT_PPP_DISCONN` + `ACT_PPP_CONN` performs.** All
three WAN targets then stayed at 100% loss for a further 18.5 minutes, and only
the reboot cleared it.

That does not make the rung worthless — a wedge that a PPP bounce *does* clear is
a plausible different failure mode, and it is far cheaper than a reboot. It means
the rung must not be sold as the fix for *this* failure, and the ladder must
escalate when it changes nothing.

---

## 8. Open questions and risks

- **Is this line actually DS-Lite?** Two code comments and a fixture the repo
  declares fake say yes; three live path measurements lean mildly no (§3.1).
  Phase 0.1 settles it at zero cost. Until then, every sentence in this repo that
  asserts DS-Lite is an unverified developer note — including
  `parse.ts:139-141`'s `connStatusV4 reads Connecting as its steady state`, of
  which the live record holds no instance.
- **What is the real `DEV2_ADT_WAN` `connType`?** If `DHCP`, the reconnect rung
  is the wrong verb and §7's whitelist must include `ACT_DHCP_RENEW` as the
  chosen branch, not a fallback.
- **What causes the poller's 2-on/2-3-off pattern?** The restart-burst
  observation (§5, item 5) is the best lead and is testable without touching the
  router. Until it is understood, Phase 1's 80% acceptance target may not be
  reachable and the watchdog may have to live with a 45.6% control path — in
  which case the pre-action snapshot precondition (failure mode 6) becomes a
  frequent stand-down rather than a formality, and that is the correct outcome.
- **What was the 4.4 GB transfer at 09:20–09:29, and did it matter?** The
  precursor loss cluster starts at 09:27:04, inside it. Nobody looked at what
  else is on this LAN.
- **What was `outage` id 3?** Unknown. No probe cycle justifies it, and no
  deletion is recorded.
- **Container downtime is still indistinguishable from router refusal** until
  Phase 0.4 lands. Every coverage number in §5 is therefore an underestimate by
  an unknown amount.
- **Log retention is one deploy.** `make up` runs `--force-recreate`, destroying
  the previous container's json-file log. All failure-reason evidence in this
  repo is bounded by time-since-last-deploy — here, 10 poll attempts. If failure
  modes are to be tallied seriously, the poller must write outcomes to the
  `event` table (Phase 1, item 4).
- **The base rate is one qualifying event in three days.** With a 240 s trigger
  the watchdog would have fired **once** in the entire history of this database.
  Everything about this design — shadow mode, dry-run on every cycle, the
  replayable test window, the latch — exists because code that runs monthly is
  code that is stale when it fires.
- **The biggest risk is not a false positive; it is a correct trigger during a
  long ISP outage.** The preconditions would hold, continuously and correctly,
  for hours, while every action is useless and each one costs 90 s of LAN. That
  is failure mode 1, it is the reason the cap is a latch rather than a window,
  and it is the one to think hardest about before arming anything.

# Watchdog — the evidence, what got built, and what is left

*Why an automated control path was considered, what the record does and does not
support, and the conditions under which any of it may be armed.*

STATUS (updated 2026-11-22): the measurement, the alerting, the write path and the
decision function are built and tested. The runner ran in shadow mode from
2026-08-01 (§6). **Armed:** the reconnect rung since 2026-11-15 and the reboot rung
since 2026-11-22 (`LINEWATCH_WATCHDOG_ARMED` and `LINEWATCH_WATCHDOG_REBOOT` in the
plist). A rung that fires is a real action; the arming numbers are in §6.

**All times are UTC, which is how they are stored.** The container sets no `TZ`,
so SQLite's `localtime` renders UTC too. Local wall clock is CEST = UTC+2.

---

## 1. The three events this rests on

All three share one signature: the gateway answers normally while every WAN
anchor loses 100% of its packets. Nothing else in the record looks like this.

| Started | Duration | Ended by | Evidence |
|-|-|-|-|
| 2026-07-30 12:07:51 | **90 s** | itself | `outage` id 1. IPv4 back 14–16 s after showtime, back-solved from the earliest poll |
| 2026-08-01 10:09:04 | **1290 s** | a human rebooting the router | `outage` id 4, 43 cycles |
| 2026-08-01 12:28:35 | **90 s** | itself | `outage` id 6. `ppp0` counters 4.74 GB → 2.4 MB; IPv4 back within 5 s of the session restarting |

**Two of three healed themselves in ninety seconds.** That asymmetry is the most
important number in this document and it decides the observe window: acting at
90 s would have re-dialled a line that was already coming back, twice, and bought
nothing either time. Waiting 150 s longer costs 150 s of downtime in the one true
positive.

The middle one is the reason any of this exists. It was bounded at 21m30s only
because someone was home to press a button; away, it is unbounded.

### What the 08-01 morning event proves

- **The WAN interface was destroyed and recreated, and the device was not
  rebooted.** `ppp0`'s cumulative byte counters reset to zero at the 10:10:01
  poll while `br0`'s kept climbing. A query for every decreasing byte counter in
  the whole database returns exactly two rows: `ppp0` at 10:10:01 and `br0` at
  10:30:00, the human reboot.
- **The recreated interface passed nothing.** 0 bytes either direction at
  showtime+23 s.
- **A controlled comparison, free of confounds.** Two polls landed at the
  identical offset from their respective resyncs — showtime+23 s. At 10:10:01
  `ppp0` held 0/0. At 10:30:00, after the reboot, 1,334,162 / 635,240.
- **The host is comprehensively ruled out.** Every cycle 10:09:04–10:27:04:
  `en0`, ethernet, 1000baseT full duplex, the home gateway, `on_home_line=1`, all
  NIC error counters 0, `link_watch_s` 29–30 with **zero** sampler transitions,
  DHCP lease frozen since 08:16:34. Gateway RTT averaged 1.040 ms against a
  0.965 ms baseline. The `en1`-bound Wi-Fi pings failed for the same window and
  recovered with it, which rules out the Ethernet port, the lease and the ARP
  state too.
- **The line quality shows nothing.** `Up` on every row 06:10 → 11:00, noise
  margin 5.8–6.2 dB with no trend, attenuation 8.5 dB on every row in the table.

### What it does not prove

- **The order.** The break precedes the resync: last WAN reply ≈10:08:38, first
  failure 10:09:04, showtime 10:09:38. "The line recovered and the IP layer
  failed to follow" is not derivable; the resync is equally consistent with being
  *part of* the fault.
- **Whether the line was at fault.** `errored_secs` and
  `severely_errored_secs` are NULL in all 165 rows — this firmware never
  populates them through the polled OIDs — so the field that would incriminate
  the line has never been readable in either direction. The line is
  un-implicated, not exonerated.
- **What a 4.4 GB transfer between the 09:20 and 09:29 polls was.** 61 Mbit/s
  sustained, three times the largest other inter-poll interval in the record. The
  precursor loss cluster starts at 09:27:04, inside it. Nobody looked at what
  else is on this LAN.

### Two record-integrity findings, unrelated but found while checking

- `sum(outage.cycles)` for `scope='wan'` is 46 against 43 all-WAN-down cycles in
  `probe_sample`. The deficit is `outage` id 1, which lies inside the 07-30
  `probe_sample` hole left by the corruption in [`storage.md`](storage.md).
  Materialise-on-write preserved a finding whose raw evidence was lost. Know this
  before "reconciling" the tables by deleting the orphan — it is the design
  working.
- **`outage.id = 3` does not exist.** Rows are 1, 2, 4, 5, 6; `sqlite_sequence`
  agrees with the max. No probe cycle anywhere justifies a missing outage.
  Flagged, not explained.

---

## 2. What was built

Everything in this section is implemented, tested and deployed.

| Piece | What it closed |
|-|-|
| **Uptime Kuma heartbeat** (`collector/heartbeat{,-verdict}.ts`) | linewatch had no way to tell anyone anything. Kuma is on another WAN and cannot probe this line, so the mini pushes and the missed heartbeat *is* the alert |
| **`router_wan_sample`** + migration 0006 | `parseLiveWan` parsed five fields and the poller stored one. The layer that fails is now recorded, including the WAN session's own uptime |
| **Epoch-based resync detection** | `current < previous` missed the second resync of 08-01 entirely: both polls read `showtimeStart = 23` |
| **Partial-poll persistence** | A poll abandoned at read 3 or 7 threw away a line sample it already held. Observed coverage 7/10 → 9/10, no extra router traffic |
| **`config_change` on boot, `note` on non-clean polls** | Deploy downtime was indistinguishable from the router refusing; failure-mode tallies were bounded by time-since-last-deploy |
| **Intervention attribution** (`source`, `kind`, `detail`) | The route hardcoded `manual`, so any automated action would have been recorded as a human with a plug |
| **`services/router/actions.ts`** | The only thing here that can write to the router, behind two independent gates |
| **`collector/watchdog-ladder.ts`** | The whole decision, pure, with the record replayed in its tests |

### The alerting threshold, validated the day it shipped

240 s to DOWN, four heartbeats of margin, chosen from the 90 s longest
self-recovery. Twenty-three minutes after installation the line dropped for 90 s
on its own. Two heartbeats went missing — the push cannot leave a house with no
WAN — then a `down` beat landed carrying `WAN down 1m30s (3 cycles:
cloudflare,google,quad9), gateway ok 1.0ms`, then recovery. Total silence 135 s.
**It did not page**, which is the correct answer for a line that fixes itself.

---

## 3. The write envelope, now measured rather than inferred

The body shape, the endpoint and the crypto were assembled from the device's own
`/js/proxy.js` and `/js/gdprProxy.js` plus TP-Link's published VX800v emulator,
whose `main/*.htm` are the real firmware page sources. All of that was
read-only. The composed request has now been sent, twice, and both attempts were
informative.

**The envelope is identical to a read.** Same `/cgi_gdpr?9` — `?9` is a dialect
marker, not an action code — same RSA `sign` with a non-incrementing `seq`, same
AES-128-CBC body, same TokenID. Only `operation` and `oid` differ.

**The first attempt failed usefully.** Sent as `ACT_OP_PPP_DISCONN`, the router
answered HTTP 200 with `errorcode: 1`. That alone proved the envelope: the device
decrypted an `operation: 'op'` body, parsed it, and *validated* the OID rather
than doing something arbitrary with an unknown one.

**The names are identifiers, not the strings they stand for.** The firmware's WAN
page calls `$.dm.op({oid: ACT_OP_PPP_CONN, ...})`, and `ACT_OP_PPP_CONN` is a
variable — `gdprProxy.js` declares `var ACT_OP_PPP_CONN = "ACT_PPP_CONN"`. Every
constant in that family drops `_OP` between name and value. This also settles the
reboot name that read as ambiguous across two firmware pages: `ACT_OP_REBOOT` and
`ACT_REBOOT` are the identifier and its value, never two candidates.

**With the right names it works, and it is cheap:**

| Measured, 2026-08-01 13:18 | |
|-|-|
| Both operations | `errorcode 0` |
| Command → session re-established | **13 s** (`uptime_v6_s` 2889 → 68) |
| Packets lost | **zero** — the disruption fell entirely between two 30 s cycles |
| Side effect | a 3 s `en0` flap, visible only to the 1 Hz link sampler |

That replaces an extrapolation. The 360 s reconnect settle window in the original
plan came from a *human reboot* for want of anything better; the binding
constraint is actually how long it takes to **see** a recovery at 30 s
resolution, not how long the router takes.

### The connection, read live

| Field | Value | Consequence |
|-|-|-|
| `X_TP_DsliteEnable` | `1` | This line **is** DS-Lite. It was previously asserted only by two code comments and a fixture the repo declares sanitised |
| `stack` | `3,0,0,0,0,0` | `DEV2_IP_INTF`'s `ppp0` is stack **4**. The obvious one addresses the wrong object |
| `connType` | `PPPoE` | `ACT_PPP_CONN`/`DISCONN` is the right verb; `ACT_DHCP_RENEW` would not have been |
| `connIPv4Enabled` | `0` | IPv4 is *entirely* the softwire |
| `connStatusV4` | `Connecting` | Therefore permanent, in health and failure alike. **Not a signal in either direction** |
| `X_TP_Uptime` | `0` | Pinned forever. A restart detector that reads 0 as "just started" fires every poll |
| `X_TP_UptimeV6` | live | The real session age, and the layer-naming signal the 08-01 diagnosis lacked |

### The safety rule, and why it is not a preference

`/js/gdprProxy.js` routes `go`, `gl`, `gs`, `so`, `ao`, `do`, `op` and `cgi` to
one URL with the verb inside an encrypted body. **No firewall rule, proxy rule or
URL allowlist can distinguish a line-statistics read from a factory reset.** Code
is the only layer where the distinction can exist.

And the hazard is literal: `ACT_OP_FACTORY_RESET` and `ACT_OP_FACTORY_RESET_DEEP`
are declared five lines above `ACT_OP_PPP_CONN` in that same file, under the same
naming rule. So:

1. **No OID crosses a module boundary.** `sendAction` takes one of four intents;
   the intent→operation map is module-private and frozen.
2. **A runtime assertion at the single send site.** Types are erased and anything
   arriving through a parsed body is `any` however it was declared.
3. **Zero-argument named methods only.** No `performAction(oid)`. `make` targets
   take no OID parameter and never will.
4. **A test greps the module for destructive operation names**, in quoted form —
   an unquoted identifier in prose cannot be sent, and the commentary that
   explains the danger has to be able to name it.
5. **`so`/`ao`/`do` are never implemented.** They rewrite WAN credentials,
   DS-Lite config and firewall rules, and they buy a watchdog nothing.
6. **`reboot` is implemented.** It reads `DEV2_ADT_WAN` first and refuses only if
   that snapshot cannot be read — a reboot destroys the evidence, so no snapshot
   means no action. It then sends `ACT_REBOOT` and returns a three-valued outcome:
   `executed` (`errorcode 0`, acknowledged before the device went down), `failed`
   (non-zero errorcode — the firmware rejects an unknown OID with HTTP 200 and
   `errorcode 1`, so a wrong name is distinguishable from success), or `unknown`
   (the transport died after the send). `unknown` is the expected signature of a
   reboot that worked, because the device dies before answering; the probe record
   over the settle window decides, never the reply.

7. **`reconnect` acts on the known connection when no instance is connected.**
   The read-then-act rule above still holds: the stack that goes out is the live
   row's. But `parseLiveWan` (poller semantics, unchanged) yields nothing when
   every instance reports `Disconnected`, which is exactly the PPPoE-session-down
   wedge, so the first version of this rung refused in 2 of 2 real outages (§6).
   Now, with no connected instance, the executor takes the one `DEV2_ADT_WAN` row
   whose `connType` has a reconnect plan, with a stack, and whose name and stack
   both equal the newest stored `router_wan_sample`. Zero or several matches, or
   no stored sample, is still a refusal. The stored value selects, it never
   addresses. The verb is unchanged (`ppp_disconnect` then `ppp_connect`; the
   disconnect on a down session is harmless), and the result's `detail` says which
   path was used: "selected by connection status" or "selected by the last known
   connection (name and stack)".

### Would a reconnect have helped on 08-01?

Almost certainly not. At 10:10:01, 23 s after the resync, `ppp0`'s counters had
already reset from 29.4 GB to zero: **the router had already performed,
unprompted, exactly what a disconnect/connect pair performs.** All three anchors
then stayed at 100% loss for a further 18.5 minutes.

On a DS-Lite line this is worse than it first reads. IPv4 rides the v6 session, so
a re-dial bounces the thing the softwire sits on — and the router's own unprompted
teardown rebuilt that whole stack, softwire endpoint included, with no effect.

The rung survives because it is now measured at 13 s and zero packet loss, which
makes it cheaper than one cycle of measurement — cheap enough to be worth trying
against a *different* wedge. It must never be sold as the fix for that one.

---

## 4. The ladder

The decision lives in `collector/watchdog-ladder.ts` and its justification lives
with it; this is the summary. `decide()` is total, deterministic, never throws,
and returns **every** failed precondition rather than the first — a stand-down
whose reason is a single name is a stand-down nobody can debug at 03:00.

Timeline for a `full_wan_down`, T0 taken from `outage.started_at` so a process
restart mid-outage does not restart the clock:

```
T0        first failing cycle
T0+180    reconnect
T0+270    reboot due; announce
T0+330    reboot fires
T0+900    exhausted, escalate to a human
```

| Constant | Value | Why |
|-|-|-|
| `observeS` | 180 s | The longest self-heal in the 15-outage record: nine healed themselves, all within 180 s; none recorded at 181–240 s. The five human-ended outages ran 720–2160 s |
| `rebootAtS` | 270 s | `observeS` + `reconnectSettleS`: due as the reconnect settle window closes; fires 60 s after the announce |
| `reconnectSettleS` | 90 s | Three probe cycles. The action itself is 13 s; seeing the recovery is the constraint |
| `rebootAtSv4Only` | 600 s | A reachable v6 anchor proves the line, the session and the ISP's forwarding all work. Every layer a reboot could fix is demonstrably fine |
| `exhaustAtS` | 900 s | Strictly after every rung's fire time. The human on 08-01 intervened at 18m17s; the ladder is done escalating before that |
| `rebootMaxPer24h` | 2 | The record holds one qualifying event in three days. Two a day is ~40× the base rate; a breach is a signal to a human, not a workload |

**The load-bearing asymmetry: carrier data may VETO or DELAY a rung, never PERMIT
one.** The poller stores under half its due polls, so a ladder gated on fresh
carrier evidence would have been inert for the entire actionable window on 08-01.

### The defects this fixed

Found by walking the original specification against its own failure-mode table.

| # | Defect | Effect |
|-|-|-|
| 1 | Executor capability was a precondition | The machine could never reach `armed` with a `NullExecutor` wired in, so **shadow mode wrote nothing at all** and two weeks of it would have proved nothing |
| 2 | `rebootOnV4Only` used by two predicates, absent from the default policy | Read `undefined`, blocked forever. On a DS-Lite line `v4_only_down` is the *expected* class |
| 3 | Action routes gated only on `LINEWATCH_ROUTER_WRITE` | An unauthenticated reboot endpoint on the tailnet. Both routes now need the bearer too |
| 4 | The escalation latch existed only in prose | The mitigation for the failure the document calls the worst had no transition and no constant |
| 5 | `resyncGraceS` stated two incompatible ways | Divergent for showtime ∈ [120, 300) |
| 6 | `exhaustAtS` == `rebootAtSv4Only` == 900 | Rung due and ladder exhausted on the same tick, ordering deciding |
| 7 | Six preconditions in the failure-mode prose, absent from the normative list | The normative list is what gets implemented |

---

## 5. Ranked failure modes

These are why the switches exist. Ordered by what they cost.

| # | Failure | Mitigation |
|-|-|-|
| 1 | **A reboot loop during a long ISP outage locks the user out of the mini.** Preconditions hold *correctly* and continuously for hours while every action is useless; each reboot takes the gateway down ~90 s, and Tailscale — the only route to the mini — dies with it | The cap is a **latch, not a rolling window**: two actions without 30 clean minutes writes the disarm file and refuses everything until a human clears it. `touch`-able from a phone in the seconds the link is up |
| 2 | **The factory-reset opcode is reachable through the same envelope as every read** | §3's whitelist, in full. Confirmed hazard: the constants are five lines apart in the device's own JavaScript |
| 3 | **An action fired but not recorded; or a crash between firing and recording double-fires** | Write-ahead, fsync, then act. A pending action at boot counts as **fired** — the deliberate inverse of the probe spool, because a batch is idempotent and a reboot is not. Cooldowns start from the *attempt*, never the ack. A successful local record is a hard precondition: no attribution possible, no action |
| 4 | **The watchdog acts while a human is troubleshooting.** One admin session; every login force-evicts the holder | You *cannot* detect a human on this router — the poller's 2-on/2-off pattern runs unbroken all night with nobody present. So an explicit quiet period instead: stand down 30 min after any `intervention` event, announce-then-wait before a reboot, and never reboot without a successful poll in the last 60 s |
| 5 | **Acting when the mini is not on the home line**, the nasty variant being a travel router on the same 192.168.1.0/24 with the same gateway address | `onHomeLine === 1` from *both* sources, `pathClass === 'ethernet'`, matching gateway addresses, and positive link-sampler coverage — absence of a recorded transition is not evidence of stability |
| 6 | **Each firing destroys the evidence that diagnosed the last incident.** A reboot resets showtime, zeroes every byte counter and empties the host table — precisely what solved 08-01 | A full pre-action snapshot is a hard precondition, and its values go into the intervention `detail`. If the snapshot fails, do not act: you cannot write to a control path you cannot read |
| 7 | **The control path is unreliable exactly when needed** — 45.6% per-attempt, p90 spacing 40 min. At 10:20 on 08-01, the one moment it mattered, the login failed | Single ownership: the action lives in the container, so exactly one `RouterClient` exists. Treat an un-acked action as fired |
| 8 | **The reconnect rung reproduces the fault it is meant to clear** | §3. Not shipped armed; requires evidence a reconnect has *ever* helped |
| 9 | **The router password reaching a native process by the wrong route hangs it or leaks it.** `op` hangs on a headless mini; the plist's environment is readable; the login body carries a reversible password | Read `~/.config/linewatch/router-password` directly. Never `op`, never `secrets-run`, never the plist, never argv. No request-body logging on the action path, ever |
| 10 | **Rate limits in host local time against a UTC database** | All budget arithmetic in epoch ms against fixed durations. Never calendar days, never local hours — the host is CEST and everything stored is UTC, so "2 per day" via `date +%F` rolls over at 22:00 UTC |
| 11 | **An action during an in-flight speed test poisons the throughput history.** The row is written at the *end*, so inferring from "newest row is younger than 90 s" is exactly backwards | Expose `speedtestRunning` on `GET /api/status` and refuse while true |
| 12 | **State in the repo, and a crash loop becoming a fire loop** | Ledger at `~/.local/state/linewatch/`, never beside `spool.jsonl`: a `git clean` resetting the reboot budget is the one failure that turns this into a reboot loop. Never act on the first evaluations after start, nor on cycles predating process start |
| 13 | **The trigger is blind to a degraded line, and fixing that re-imports false positives** | **Do not widen it.** 09:38:34 on 08-01 lost 40–45% across all three anchors with a clean gateway and healed in ~2 s. The blind spot is stated and asserted in a test rather than discovered during a bad month |
| 14 | **The decision code runs for real about once a month** | Run `decide()` in dry-run every tick so the logic executes 2880×/day, and assert the stored windows in the suite — which it does: fires on 08-01 10:09, silent on 07-30 12:07, on 08-01 12:28, on the Wi-Fi failover cycles and on the 09:38 precursor |
| 15 | **Reboot-driven renumbering breaks the mini's own instrumentation** | Pin the mini's address by DHCP reservation before enabling reboots; verify afterwards that it still holds the configured IP |

---

## 6. What is built, and what arming still needs

Everything in the original "what is left" list now exists. It ran in shadow
mode from 2026-08-01, armed for the reconnect rung since 2026-11-15 and for the reboot rung since 2026-11-22.

| Piece | Where |
|-|-|
| Runner — tick, gather, `decide()`, dispatch, record | `collector/watchdog.ts` |
| Ledger, 0600, tmp → fsync → rename → fsync(dir) | `collector/watchdog-state.ts` |
| Report mapping and notification text | `collector/watchdog-report.ts` |
| LaunchAgent, `KeepAlive`, `LINEWATCH_WATCHDOG_ARMED` and `LINEWATCH_WATCHDOG_REBOOT` | `collector/com.jkrumm.linewatch-watchdog.plist.template` |
| `make watchdog-{setup,teardown,status,state,logs,arm,disarm,readiness}` | `Makefile` |
| Two spools — events against localhost, notifications across the WAN | `collector/watchdog.ts` |
| A second Kuma push monitor for the watchdog's own health | `homelab/uptime-kuma/monitors.yaml` |

Three things changed shape while building it, and each is a defect the
specification did not catch.

1. **Three preconditions could never fire.** `speedtest_running` and
   `link_coverage_incomplete` were in the normative list and in §5's mitigation
   column, and `GET /api/status` carried neither `speedtestRunning` nor
   `linkWatchS` — so no evidence path could set either. A precondition that
   cannot fire is worse than a missing one, because the failure-mode table
   counts it as a defence. `newestSampleTs` was added beside them.
2. **The state transitions had no home.** `latchClearAfterCleanS` and
   `postActionCooldownS` were policy fields nothing read. The latch is failure
   mode #1's entire mitigation and its clear condition existed only as prose
   inside a note string. `decide()` now returns the ledger it implies, so the
   rung advance, the T0 capture, the write-ahead and both of those live in the
   tested layer.
3. **Escalation had no class filter.** The exhausted branch fired for any
   non-healthy class, including `off_home_line` — so fifteen minutes on a
   hotspot paged about a line that was not being measured. `no_evidence` is
   excluded too: the heartbeat already reports that, and can, because the WAN is
   up.

### Armed, 2026-11-15 — the reconnect rung only

On 2026-11-15 the home line was down from 07:57:56 to 08:28:26 and came back only
when the router was power-cycled by hand at 08:25. The watchdog confirmed
`wan_down_v6_unknown` at 07:58:37, found the reconnect due at 08:02 and the reboot
due at 08:03, and was refused both by `not_armed` (the reboot also by
`reboot_disabled`, and at 08:03 by `no_fresh_poll`). It decided correctly and could
not act. The same morning the owner asked for the mini to heal the line itself,
including restarting the router, which is the human agreement with the would-be
triggers that this section used to ask for.

| Switch | State |
|-|-|
| `LINEWATCH_ROUTER_WRITE=1` in the app's plist | on, 2026-11-15 |
| `LINEWATCH_WATCHDOG_ARMED=1` in the watchdog's plist | on, 2026-11-15 — the reconnect rung is performed |
| `LINEWATCH_WATCHDOG_REBOOT=1` in the watchdog's plist | on, 2026-11-22 — the reboot rung is performed when its gates hold |
| Budget, latch, announce step, post-action cooldown | unchanged |

The reboot rung was armed on 2026-11-22, once the readiness gate in the next section held
over 72 h. Its budget (2 per 24 h) and latch are unchanged.

### The reconnect rung refused in both real outages, 2026-11-22

The 2026-11-15 outage was not the only one the armed rung met. On 2026-11-22
17:46–18:17 UTC the line was down for 31 minutes until the owner rebooted the
router by hand. The watchdog fired its reconnect at T0+250 s and
`LiveExecutor.doReconnect` refused: "the router reports no connected WAN instance
— nothing was sent". The G.fast line stayed Up throughout (sync about 820/229
Mbit/s); the PPPoE session was down (`lastConnError` `ERROR_ISP_TIME_OUT`). The
2026-11-15 outage refused the same way. The precondition (an instance that is v4
not `Disconnected` or v6 `Connected`) excluded the wedge it exists for, so the
rung has refused in 2 of 2 real outages and has never been sent at a wedge. §3
item 7 is the fix. **A reconnect has been tried against a real wedge only after
that change is deployed**, and whether it clears one is still unobserved (§7).

### Conditions for arming, as measured

- **Poll coverage ≥80% of due polls over 48 h, p90 spacing ≤20 min.** Read on
  2026-11-15 on the native database (`make watchdog-readiness`; the target used to
  call `docker exec` into a container that no longer exists): `router_line_sample`
  has rows only from 2026-11-14 18:00, about 75% of due polls over 6 h and 27% over
  48 h (the window is mostly before the record starts), p90 spacing 1,199 s, worst
  gap 2,023 s. The target now measures against the configured cadence and prints
  where the record starts.
  - **What the misses are.** From the app log: after every restart three clean
    polls, then a repeating four-poll cycle — first read lost (0/8), a partial
    (7/8, the later reads lost), two clean. A poll stores a line reading iff its
    first read answers, so the 0/8 and the login that "did not take" are the
    misses, about one poll in four. Two shapes: the first read answers 406 and the
    retry finds the socket closed; or the router answers every read with an empty
    success. Both are the router, not the mini.
  - **What was ruled out.** Bun's pooled sockets (pooled and `keepalive: false`
    trials at 10-minute gaps in one long-lived process: 3 rounds each, 8/8 reads
    every time); a standalone process logging in every 40 s (12 of 12 clean); another
    router client on the host (none scheduled). The cause is not reproducible from
    outside the app.
  - **What was done.** One retry of a scheduled poll that stored no line reading,
    30 s later (`pollWithRetry`, `services/router/scheduler.ts`). It does not cover
    a degraded window longer than 30 s: the first poll after the deploy that hit one
    (10:50) failed twice. The coverage the retry buys is still to be counted.
  - **Why it gates the reboot rung.** The reboot needs a line reading no older than
    60 s (`no_fresh_poll`), and the announce step fires only on a tick where that
    precondition and everything else already hold. The fire then waits 60 s more,
    outside the freshness window. At a 10-minute cadence that is two successful
    polls after T0+330 s: the 08:10 poll would have announced, and the 08:20 poll
    — the one that was missed — would have fired. Coverage is therefore not a
    nicety here but the reboot's latency. So the watchdog now asks for one
    (`collector/watchdog-poll-request.ts`): when the reboot rung is otherwise fully
    authorised and `no_fresh_poll` (plus the `not_announced` it unblocks) is all that
    blocks it, the last step of the tick POSTs `/api/router/poll`, at most once per
    120 s. It never permits a rung — freshness is still read from the stored line
    reading on the next tick — and it asks nothing while `reboot_disabled`,
    `not_armed` or a disarm is among the blockers. It cannot help while the router
    answers its carrier objects empty: the poll then stores no line reading either,
    and the rung correctly stays blocked.
  - **Armed 2026-11-22:** `make watchdog-readiness READINESS_WINDOW_H=72` read 100.0%
    coverage, p90 spacing 630 s, worst gap 631 s and 0 reboots recorded, over a record
    that starts 2026-11-19 (after the 2026-11-15 10:12 deploy that carries the retry).
    `LINEWATCH_WATCHDOG_REBOOT=1` was then added to the watchdog plist and
    `make watchdog-setup` run. To re-read the gate: the same target, at 80% or better.
- **Shadow mode produced triggers a human agrees with.** Read on 2026-11-15, every
  due-rung note the shadow run wrote (`watchdog_blocked`, 2026-08-01 to 2026-11-15)
  falls in two groups. Three are real WAN outages — `full_wan_down` on 2026-08-27
  and 2026-09-24, `wan_down_v6_unknown` on 2026-11-15 — and their reconnect was
  blocked by `not_armed` alone; arming changes exactly these. The rest are
  `off_home_line` (the mini measuring another uplink, 2026-11-04 to 2026-11-14,
  up to 50 notes a day) and each carries `class_off_home_line` and usually
  `not_ethernet` beside `not_armed`, so arming changes nothing for them.
  `make watchdog-readiness` counts the blocked rungs over its window.
- **The mini's LAN address pinned by DHCP reservation.** The router's DHCP objects
  answer success with no data through its API (checked: the pool, the static
  address list, the server), so the reservation cannot be read back; it was
  confirmed by the owner in the router's web UI on 2026-11-15.
- **The reboot rung sits behind `LINEWATCH_WATCHDOG_REBOOT`** (on since 2026-11-22). The action itself
  is implemented and its failure is distinguishable from its success (§3 item 6).

---

## 7. Open questions

- **What causes the poller's 2-on/2-3-off pattern?** The best lead is that a
  container restart reliably buys 3–4 consecutive successes before it resumes —
  something accumulates and clears on restart, either the router's session table
  or Bun's connection pool. **Testable without touching the router.** Until it is
  understood the 80% target may be unreachable, and the pre-action snapshot
  precondition becomes a frequent stand-down rather than a formality. That is the
  correct outcome, not a problem to tune away.
- **What was the 4.4 GB transfer at 09:20–09:29, and did it matter?** The
  precursor loss cluster starts inside it.
- **What was `outage` id 3?**
- **Does a reconnect ever clear a wedge?** It has been proven to work and to be
  cheap. It has never been observed to *fix* anything: it was fired at a healthy
  line, then refused in both real outages (§6) until the known-connection
  selection (§3 item 7) shipped.
- **What is the reboot's real recovery curve?** The firmware budgets 130 s
  (`INCLUDE_REBOOT_WAIT_TIME` on the device) and the record's worst measured
  reboot-to-IPv4 is 193 s, which is what `rebootSettleS: 300` is scaled from.
  Both are one observation each.
- **The base rate is one qualifying event in three days**, and with a 180 s
  trigger this would have fired **once** in the entire history of the database.
  Everything here — shadow mode, dry-run every tick, the replayed windows, the
  latch — exists because code that runs monthly is code that is stale when it
  fires.

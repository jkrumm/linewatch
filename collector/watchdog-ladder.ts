/**
 * The watchdog's entire judgement, as one pure function.
 *
 * No I/O, no clock, no fetch, no filesystem. `decide()` is total, deterministic
 * and never throws; the process around it gathers evidence, calls this, performs
 * whatever it returns, and writes the outcome down. That split exists for one
 * measured reason: **this code runs in anger about once a month.** The database
 * holds one event that would have triggered it in its entire history. Code that
 * rare is stale when it fires, so the decision is separated from the acting to
 * make it cheap to run the decision constantly — every tick, in dry-run, against
 * real evidence — and to replay it over stored windows.
 *
 * ## What the record actually says, because the thresholds come from it
 *
 * Three events of this shape exist, all gateway-clean with every WAN anchor at
 * 100% loss:
 *
 * | When | Duration | Ended by |
 * |-|-|-|
 * | 2026-07-30 12:07:51 | 90 s | itself — IPv4 back 14–16 s after showtime |
 * | 2026-08-01 10:09:04 | 1290 s | a human rebooting the router |
 * | 2026-08-01 12:28:35 | 90 s | itself — IPv4 back within 5 s of the session restarting |
 *
 * **Two of three healed themselves in 90 seconds.** That asymmetry decides the
 * observe window and it is the single most important number here: acting at 90 s
 * would have re-dialled a line that was already coming back, twice, and bought
 * nothing either time.
 *
 * ## Three corrections to the specification, from measurement
 *
 * 1. `reconnectSettleS` was 360 s, extrapolated from a human reboot for want of
 *    anything better. A reconnect was then measured against the live device: 13 s
 *    from command to a re-established WAN session, and zero packets lost, because
 *    the whole disruption fell between two 30 s probe cycles. 90 s is three
 *    cycles — enough to *observe* a recovery at the record's own resolution,
 *    which is the binding constraint, not the router's speed.
 * 2. The reboot rung was unreachable for `v4_only_down`: two preconditions
 *    consulted a policy key that the default policy did not define, so it read
 *    `undefined` and blocked forever. On a DS-Lite line — confirmed from the
 *    router's own data model — `v4_only_down` is the *expected* class for the
 *    failure this exists for.
 * 3. `exhaustAtS` and the v4-only reboot time were both 900 s, so the rung
 *    became due and the ladder gave up on the same tick, with evaluation order
 *    deciding. Every rung now fires strictly before the ladder exhausts.
 *
 * ## The load-bearing asymmetry
 *
 * **Carrier data may VETO or DELAY a rung. It may never PERMIT one.** The router
 * poller stores under half of its due polls, so a ladder gated on fresh carrier
 * evidence would have been inert for the entire actionable window on 2026-08-01.
 * Silence from the poller is not evidence of anything.
 */

export type Rung = 'observe' | 'reconnect' | 'reboot' | 'exhausted'

export type OutageClass =
  | 'healthy'
  | 'partial'
  | 'no_evidence'
  | 'off_home_line'
  | 'local_link_down'
  | 'carrier_down'
  | 'full_wan_down'
  | 'v4_only_down'
  | 'wan_down_v6_unknown'

export type WatchdogState =
  | 'boot'
  | 'normal'
  | 'suspect'
  | 'confirmed'
  | 'pre_announce'
  | 'armed'
  | 'settling'
  | 'blocked'
  | 'exhausted'
  | 'recovering'
  | 'recovered'
  | 'latched'
  /** The ledger could not be read: budgets unknown, nothing may be acted on or written. */
  | 'untrusted'

export type ActionKind = 'none' | 'reconnect' | 'reboot' | 'announce' | 'escalate'

export interface WatchdogPolicy {
  tickMs: number
  confirmTicks: number
  observeS: number
  reconnectSettleS: number
  rebootAtS: number
  rebootAtSv4Only: number
  rebootSettleS: number
  exhaustAtS: number
  announceLeadS: number
  resyncGraceS: number
  staleSampleS: number
  reconnectMinIntervalS: number
  reconnectMaxPer24h: number
  rebootMinIntervalS: number
  rebootMaxPer24h: number
  postActionCooldownS: number
  escalationQuietS: number
  v6BaselineMaxAgeS: number
  /**
   * How long a recovery must hold before the ladder is torn down.
   *
   * Entry into an outage is gated on `confirmTicks`; exit was gated on nothing,
   * and that asymmetry is a real defect rather than a theoretical one. Measured
   * 2026-08-01 19:11:18, 131 s into a live router reboot with all three WAN
   * anchors at 100% loss in the record: one stray reply to one anchor in the
   * watchdog's own three-packet probe made `anchorsAllDown` false, which is
   * `partial`, which counts as healthy. The ladder reset — T0 cleared, outage
   * key cleared — and a `self_recovery` note went into the record for a line
   * that had not recovered.
   *
   * The attribution lie is the smaller half. The larger one is that a wedge
   * flapping a single reply every couple of minutes would restart the 180 s
   * observe window every time, so the ladder would never advance on exactly the
   * failure this exists for.
   */
  recoverAfterS: number
  /** Consecutive actions with no sustained recovery between them before the watchdog disarms itself. */
  latchAfterActions: number
  /** How long the line must be continuously healthy to clear the latch counter. */
  latchClearAfterCleanS: number
  /** Stand down for this long after any human intervention. They are already working on it. */
  humanQuietS: number
  /** Minimum age of this process before it may act on anything. */
  minProcessAgeS: number
  armed: boolean
  rebootEnabled: boolean
  rebootOnV4Only: boolean
}

/**
 * Every value here is either measured or derived from a measured one. The
 * timeline they compose, for a `full_wan_down`:
 *
 *     T0        first failing cycle, from outage.started_at
 *     T0+180    reconnect
 *     T0+270    reboot becomes due; announce
 *     T0+330    reboot fires
 *     T0+900    exhausted, escalate to a human
 *
 * The human on 2026-08-01 started rebooting at T0+18m17s. The ladder is designed
 * to be finished escalating before a person would have reached the box.
 */
export const DEFAULT_POLICY: WatchdogPolicy = {
  // Half the 30 s probe cycle, so every new cycle is seen within one tick with
  // no aliasing. Faster buys nothing: 30 s is the record's own resolution.
  tickMs: 15_000,
  // The class must hold across two independent self-probes before a clock runs.
  // Costs no ladder time — T0 comes from the outage row, not from confirmation.
  confirmTicks: 2,
  // Ten outages in the record healed themselves: nine within 180 s, none at
  // 181–240 s, and one at 420 s that no action reached (the router re-dialled
  // itself at 150 s). The five of 720–2160 s were all ended by a human.
  observeS: 180,
  // Three probe cycles. The measured reconnect took 13 s and lost no packets, so
  // this is bounded by how long it takes to *see* a recovery, not to cause one.
  reconnectSettleS: 90,
  // observeS + reconnectSettleS: due as the reconnect's settle window closes.
  rebootAtS: 270,
  // Deferred, not disabled: a reachable IPv6 anchor proves the line is in
  // showtime, the session is established and the ISP is forwarding. Every layer
  // a reboot could fix is demonstrably working, and a reboot is a household-wide
  // LAN outage bought with evidence pointing elsewhere.
  rebootAtSv4Only: 600,
  // 1.49x the worst measured reboot-to-IPv4, which is now 201 s rather than the
  // 193 s this was scaled from — a controlled reboot on 2026-08-01 19:08:46 put
  // the gateway back at +111 s (the firmware budgets 130) and every WAN anchor
  // at +201 s. It also has to cover the multi-phase reality: the morning's
  // reboot produced link flaps at 10:27:21/:38/:42, 10:28:13, 10:29:44/:47 and
  // three DHCP re-binds — 147 s of churn before the line even resynced. The
  // margin is thinner than it reads; two observations is not a distribution.
  rebootSettleS: 300,
  // Strictly after every rung's fire time, so no rung races the give-up.
  exhaustAtS: 900,
  // Reboot rung only. The router allows one admin session, so a reboot fired
  // while a human is mid-remediation in its UI is a real hazard. The WAN is
  // already dead by then, so the delay costs nothing measurable.
  announceLeadS: 60,
  resyncGraceS: 120,
  // Three probe cycles. Past that the record describes the past, not now.
  staleSampleS: 90,
  reconnectMinIntervalS: 3_600,
  reconnectMaxPer24h: 6,
  rebootMinIntervalS: 21_600,
  // The record holds one event of this class in three days. Two a day is ~40x
  // the observed base rate; a breach is a signal to a human, not a workload.
  rebootMaxPer24h: 2,
  // A recovery that holds two cycles and fails again must not be laundered into
  // a fresh independent outage with a fresh budget.
  postActionCooldownS: 900,
  escalationQuietS: 3_600,
  v6BaselineMaxAgeS: 86_400,
  // Two probe cycles, the same evidence bar as `confirmTicks` on the way in.
  // Short enough that a genuine recovery is recognised within one ladder tick
  // of the record showing it, long enough that a single anchor's stray reply
  // cannot end an outage on its own.
  recoverAfterS: 60,
  latchAfterActions: 2,
  // 60 clean probe cycles.
  latchClearAfterCleanS: 1_800,
  humanQuietS: 1_800,
  // Never act on the first evaluations after start. Kills the crash-loop-becomes-
  // fire-loop path and the acting-on-history path with one rule.
  minProcessAgeS: 120,
  armed: false,
  rebootEnabled: false,
  rebootOnV4Only: false,
}

type V6Health = 'usable' | 'unusable' | 'unconfigured'

export interface AnchorState {
  target: string
  /**
   * Replies received. 0 is down; the count is kept because partial loss is not an outage.
   * Null is **unmeasured** — `ping` produced no summary at all (spawn error, killed,
   * missing binary). It is neither up nor down and never reads as loss.
   */
  received: number | null
}

/**
 * What `GET /api/status` says. Null when it could not be read at all.
 *
 * **Every field here must be read by a decision.** Three were not: the WAN
 * outage's `evidence` array, and `pathClass`, and `ongoingGatewayOutage` — all
 * three fetched, declared, and consulted by nothing, which is the same defect
 * class as a policy field nothing reads. `ongoingGatewayOutage` now dates the
 * ladder; the other two are gone.
 *
 * `pathClass` is deliberately absent rather than turned into a blocker, and the
 * reason is worth keeping: `vantage.ts` derives `onHomeLine` *from* it — a
 * non-ethernet path yields 0 and an unknown one yields null — so a
 * `not_ethernet_record` precondition could never be the sole reason for a
 * stand-down. `off_home_line_record` has already fired by then. A precondition
 * that cannot fire alone is the mirror of one that cannot fire at all.
 */
export interface RecordEvidence {
  /** Newest probe sample timestamp — freshness of the whole record. */
  newestSampleTs: number
  ongoingWanOutage: { startedAt: number; cycles: number } | null
  ongoingGatewayOutage: { startedAt: number } | null
  gateway: AnchorState | null
  wanAnchors: AnchorState[]
  /** Three-state, never coalesced: null means the collector did not report. */
  onHomeLine: boolean | null
  gatewayAddr: string | null
  /** Seconds of the newest cycle covered by the 1 Hz link sampler. */
  linkWatchS: number | null
  /** True while a speed test is in flight — its result would be poisoned by an action. */
  speedtestRunning: boolean
}

/** The watchdog's own ICMP, taken independently of the collector. */
export interface SelfEvidence {
  probeTs: number
  gateway: AnchorState
  wanAnchors: AnchorState[]
  /** Null when the v6 anchor was not probed this tick. */
  v6: AnchorState | null
  /** From the collector's own vantage capture. 1 / 0 / null = unknown. */
  onHomeLine: 0 | 1 | null
  pathClass: string | null
  gatewayAddr: string | null
}

/** What `GET /api/router` says. Every field may be absent; none of it may permit an action. */
export interface CarrierEvidence {
  stale: boolean
  lineStatus: string | null
  showtimeStartS: number | null
  /** Whether a full poll completed recently enough to prove the control path is ours. */
  freshPollAgeS: number | null
}

/**
 * What the executor's answer was, kept apart on purpose:
 *
 * - `refused` — the executor read the router and declined (no connected WAN
 *   instance, an unrecognised connType). Nothing was sent, and it is a defect
 *   signal during a real outage, not a choice.
 * - `not_executed` — the capability switch is off or the API answered 403.
 *   Nothing was sent, because we are configured not to.
 *
 * Both give the latch increment back; neither is the same fact.
 */
export type LedgerOutcome = 'executed' | 'failed' | 'not_executed' | 'refused' | 'unknown'

export interface LedgerAction {
  ts: number
  kind: 'reconnect' | 'reboot'
  outageKey: string
  outcome: LedgerOutcome
  /** The executor's own words, clipped. Optional: ledgers written before it existed have none. */
  detail?: string
}

/** Who ended an outage, as far as the record can tell. */
export type EndedBy = 'self' | 'reconnect' | 'reboot' | 'external'

export interface OutageSummary {
  outageKey: string
  outageClass: OutageClass | null
  t0: number
  /** When the line first became continuously healthy — the outage's real end, not the tick that confirmed it. */
  endedAt: number
  durationS: number
  endedBy: EndedBy
  /** Every rung the ladder reached in this outage, in order, with what came of it. */
  rungs: Array<{
    rung: 'reconnect' | 'reboot' | 'escalate'
    ts: number
    atS: number
    outcome: string
  }>
  /** When the router (or the link to it) was first lost during the ladder; set only for `external`. */
  externalAt: number | null
}

export interface Ledger {
  version: 1
  ladder: {
    outageKey: string | null
    t0: number | null
    rung: Rung
    enteredAt: number
    settleUntil: number | null
    announcedAt: number | null
    /**
     * The three fields below are optional because a ledger written before they
     * existed must still load: reading it as untrusted would stand the whole
     * watchdog down over a field that only feeds a summary.
     *
     * The class the ladder opened on.
     */
    outageClass?: OutageClass | null
    /**
     * Where the current run of unreachable-gateway ticks began, and where the
     * first run that lasted long enough to be a router restart began. A router
     * that went away and came back while no action of ours reached the line was
     * restarted by someone else.
     */
    gatewayLostAt?: number | null
    externalRestartAt?: number | null
  }
  actions: LedgerAction[]
  pending: {
    ts: number
    kind: 'reconnect' | 'reboot'
    outageKey: string
  } | null
  v6: { lastUpTs: number | null; lastCheckedTs: number | null }
  postActionCooldownUntil: number | null
  lastEscalationTs: number | null
  /** Actions taken with no sustained recovery between them. Reaching the cap self-disarms. */
  consecutiveActions: number
  /** When the line last became continuously healthy — the latch counter's clock. */
  healthySince: number | null
}

export interface LadderInput {
  now: number
  policy: WatchdogPolicy
  record: RecordEvidence | null
  self: SelfEvidence | null
  carrier: CarrierEvidence | null
  ledger: Ledger
  /**
   * False when the ledger file existed and could not be understood. `ledger` is then
   * a placeholder: its budgets are unknown, not empty, so `decide()` takes no action
   * and returns a ledger the runner must not persist.
   */
  trusted: boolean
  /** When this process started. Nothing may be acted on from before it was watching. */
  processStartedAt: number
  /** `~/.config/linewatch/watchdog-disarmed` exists. */
  disarmed: boolean
  /** The executor's real capability. `null` means nothing can reach the router. */
  capability: 'live' | 'null'
  /** Newest human `intervention` event. They are already working on it. */
  lastHumanInterventionTs: number | null
  /** Consecutive ticks this process has itself seen the current class. */
  heldTicks: number
  /** Whether the local event spool accepted a write. No attribution possible means no action. */
  canRecord: boolean
}

/**
 * The decision, plus the ledger it implies.
 *
 * These are one return value rather than two calls because the split was where
 * the mitigations went to die. `latchClearAfterCleanS` and `postActionCooldownS`
 * were policy fields nothing read: the latch is failure mode #1's entire
 * defence against a reboot loop locking the house out of the mini, and its
 * clear condition existed only as a sentence inside a note string. So did the
 * rung advance, the T0 capture and the write-ahead. All of it would have lived
 * in the runner — imperative code exercised for real about once a month, which
 * is the exact thing the pure/impure split was drawn to prevent.
 *
 * `ledger` is what must be on disk, fsynced, **before** anything is performed.
 * `collector/watchdog.ts` persists it and then acts; `recordOutcome` closes the
 * loop afterwards.
 */
export interface LadderOutcome extends LadderDecision {
  ledger: Ledger
  /** False when `ledger` must not be written — an untrusted ledger is never overwritten. */
  persist: boolean
  /** Set on exactly the tick that tears the ladder down: the one-row account of the outage. */
  closed: OutageSummary | null
}

export interface LadderDecision {
  state: WatchdogState
  outageClass: OutageClass
  action: ActionKind
  /**
   * The action was fully authorised and deliberately not performed — shadow
   * mode. The caller writes a `would_*` note. **This is what makes shadow mode
   * worth running**, and it is why executor capability is not a precondition:
   * making it one meant the machine could never reach `armed`, so a shadow run
   * produced no output at all and the two weeks of it proved nothing.
   */
  shadow: boolean
  /** EVERY failed precondition, in evaluation order. Never short-circuited. */
  blockedBy: string[]
  t0: number | null
  outageKey: string | null
  rung: Rung
  nextEvaluationAt: number
  note: string
}

const DAY_MS = 86_400_000

/**
 * The watchdog's own probe with every unmeasured anchor removed from play. A self
 * reading with any hole in it is not evidence of anything, so it is dropped whole
 * and the classification falls back to the record (or to `no_evidence`) rather than
 * reading a broken `ping` binary as an outage — or as a recovery.
 */
function measuredSelf(self: SelfEvidence | null): SelfEvidence | null {
  if (self === null) return null
  if (self.gateway.received === null) return null
  if (self.wanAnchors.some((anchor) => anchor.received === null)) return null
  return self
}

function anchorsAllDown(anchors: readonly AnchorState[]): boolean {
  return anchors.length > 0 && anchors.every((anchor) => anchor.received === 0)
}

function anchorsAnyDown(anchors: readonly AnchorState[]): boolean {
  return anchors.some((anchor) => anchor.received === 0)
}

/** The guard against reading "IPv6 was never deployed here" as "IPv6 is down". */
function v6Health(input: Pick<LadderInput, 'now' | 'policy' | 'self' | 'ledger'>): V6Health {
  if (input.self?.v6 == null) return 'unconfigured'
  if (input.ledger.v6.lastUpTs === null) return 'unusable'
  return input.now - input.ledger.v6.lastUpTs > input.policy.v6BaselineMaxAgeS * 1000
    ? 'unusable'
    : 'usable'
}

/**
 * The record, or null when it is too old to describe now. One definition for
 * `classify`, the gateway reading and the `no_evidence` blocker's freshness test.
 * The other raw reads are deliberate: `recordedOutageStart` dates T0, which a
 * stale row still describes correctly, and the shared blockers only ever veto, so
 * a stale record that says something is wrong keeps standing a rung down rather
 * than being ignored.
 */
function freshRecord(input: Pick<LadderInput, 'record' | 'policy' | 'now'>): RecordEvidence | null {
  const { record, policy, now } = input
  return record !== null && now - record.newestSampleTs <= policy.staleSampleS * 1000
    ? record
    : null
}

/**
 * First match wins. Order is the whole meaning: `off_home_line` outranks every
 * WAN class because a mini measuring a hotspot is not measuring this line, and
 * `local_link_down` outranks them because an unreachable gateway takes every
 * anchor with it and naming the WAN would point at the wrong hop.
 */
export function classify(input: LadderInput): OutageClass {
  const { record, policy, now } = input
  const self = measuredSelf(input.self)

  const usableRecord = freshRecord(input)

  if (usableRecord === null && self === null) return 'no_evidence'

  // `onHomeLine` is three-state and null means the collector did not report,
  // which is unknown, not yes. Of 5210 recorded cycles 5202 read 1, six read 0
  // during a real Wi-Fi failover, and the two nulls fall inside a router reboot
  // — so null is the signature of the very condition this acts on, not a rare
  // theoretical state. Coalescing it is the fabrication DESIGN.md names.
  if (self !== null && self.onHomeLine !== 1) return 'off_home_line'
  if (usableRecord !== null && usableRecord.onHomeLine !== true) return 'off_home_line'

  if (self !== null && self.gateway.received === 0) return 'local_link_down'
  if (
    usableRecord !== null &&
    usableRecord.gateway !== null &&
    usableRecord.gateway.received === 0
  ) {
    return 'local_link_down'
  }

  const selfWanDown = self !== null && anchorsAllDown(self.wanAnchors)
  const recordWanDown = usableRecord !== null && anchorsAllDown(usableRecord.wanAnchors)
  const anySourceSaysDown = selfWanDown || recordWanDown
  const bothSourcesAgree =
    self === null || usableRecord === null ? anySourceSaysDown : selfWanDown && recordWanDown

  if (anySourceSaysDown && bothSourcesAgree) {
    // A carrier reading may veto here, and only here. A router whose line is not
    // in showtime cannot complete a re-dial and will not gain showtime from a
    // reboot. Note the asymmetry: a stale or missing reading does NOT produce
    // this class, because absence of carrier evidence is not evidence.
    if (
      input.carrier !== null &&
      !input.carrier.stale &&
      input.carrier.lineStatus !== null &&
      input.carrier.lineStatus !== 'Up'
    ) {
      return 'carrier_down'
    }
    const health = v6Health(input)
    // A v6 anchor that was probed but produced no summary is unmeasured, not
    // down: it must not promote the class to full_wan_down.
    const v6Received = self?.v6?.received
    if (self?.v6 != null && v6Received === null) return 'wan_down_v6_unknown'
    if (v6Received != null && v6Received > 0) return 'v4_only_down'
    if (health !== 'usable') return 'wan_down_v6_unknown'
    return 'full_wan_down'
  }

  const anyDown =
    (self !== null && anchorsAnyDown(self.wanAnchors)) ||
    (usableRecord !== null && anchorsAnyDown(usableRecord.wanAnchors))
  if (anyDown) return 'partial'

  return 'healthy'
}

const ACTIONABLE: ReadonlySet<OutageClass> = new Set<OutageClass>([
  'full_wan_down',
  'v4_only_down',
  'wan_down_v6_unknown',
])

/**
 * Which classes are worth waking a human for once the ladder has nothing left.
 *
 * Wider than `ACTIONABLE` on purpose — a dead gateway or a line out of showtime
 * is a real fault this cannot fix, and "I cannot fix it" is exactly when a
 * person is needed. But two classes are deliberately excluded, and both were
 * pages this would otherwise have sent:
 *
 * - `off_home_line` — the mini is measuring a hotspot or a travel router.
 *   Nothing is known about the home line at all, so a page claiming it is down
 *   would be a fabrication. Take the mini out for the afternoon and the old
 *   shape paged after fifteen minutes, every time.
 * - `no_evidence` — the API or the collector is unreadable. That is already an
 *   explicit `down` heartbeat from `collector/heartbeat-verdict.ts`, which can
 *   say so precisely because the WAN is up. A second page for one fact trains
 *   the reader to ignore both.
 */
const ESCALATABLE: ReadonlySet<OutageClass> = new Set<OutageClass>([
  ...ACTIONABLE,
  'local_link_down',
  'carrier_down',
])

/**
 * When the outage the record is describing actually began — the earliest scope
 * still open, not the WAN one.
 *
 * Both rows usually open together: 2026-08-01 19:09:07 opened a `gateway` and a
 * `wan` outage in the same second. But only the gateway row can open *first*,
 * because an unreachable gateway takes the anchors with it and the WAN row is
 * the consequence. Dating the ladder from the consequence would have every
 * gateway-side fault escalate a cycle or more late, and the 900 s exhaust window
 * is the one clock a human is waiting on.
 */
function recordedOutageStart(record: RecordEvidence | null): number | null {
  if (record === null) return null
  const starts: number[] = []
  if (record.ongoingWanOutage !== null) starts.push(record.ongoingWanOutage.startedAt)
  if (record.ongoingGatewayOutage !== null) starts.push(record.ongoingGatewayOutage.startedAt)
  return starts.length === 0 ? null : Math.min(...starts)
}

/**
 * A router restart needs the gateway to have stayed away this long. One failed
 * 3-packet ping is a dropped frame, not a reboot, and the shortest real reboot
 * on record kept the gateway away for 111 s.
 */
const EXTERNAL_MIN_GATEWAY_LOSS_MS = 30_000

/** An action that may have touched the line: a verb went out, or we cannot tell. */
function reachedTheLine(action: LedgerAction): boolean {
  return action.outcome === 'executed' || action.outcome === 'unknown'
}

/**
 * What this tick says about the gateway, from the same inputs `classify` uses —
 * the measured self probe and the *fresh* record — and with the same precedence:
 * either source reading zero is `unreachable`, as it is for `local_link_down`.
 * The record's open gateway-outage row is deliberately not consulted: `classify`
 * does not, and a row that outlives the gateway's return must not hold a run open
 * past a tick that measured it reachable.
 * `unknown` is a tick nothing measured.
 */
function gatewayReading(
  input: Pick<LadderInput, 'self' | 'record' | 'policy' | 'now'>,
): 'unreachable' | 'reachable' | 'unknown' {
  const self = measuredSelf(input.self)
  const record = freshRecord(input)
  const recordGateway = record?.gateway ?? null
  if (
    (self !== null && self.gateway.received === 0) ||
    (recordGateway !== null && recordGateway.received === 0)
  ) {
    return 'unreachable'
  }
  if (self !== null && self.gateway.received !== null && self.gateway.received > 0)
    return 'reachable'
  if (recordGateway !== null && (recordGateway.received ?? 0) > 0) return 'reachable'
  return 'unknown'
}

/**
 * Who ended the outage this ladder was tracking.
 *
 * `reconnect`/`reboot` only when an action with outcome executed or unknown
 * happened in the ladder — a refused one touched nothing, and crediting it is
 * the lie this exists to stop. With none, a gateway that was unreachable for a
 * sustained stretch and then came back is a router restarted by someone else
 * (the 2026-11-22 outage ended that way: link down/up at the mini, the router's
 * session uptime reset, nothing of ours sent). Otherwise the line fixed itself.
 *
 * Gateway loss is the signal because it is the one thing the watchdog sees
 * directly on every tick; carrier showtime is no use here, since the ISP
 * re-syncing a wedged line moves it too and that is not a restart.
 */
export function attribute(ledger: Ledger): {
  endedBy: EndedBy
  externalAt: number | null
} {
  const key = ledger.ladder.outageKey
  const acted = ledger.actions.filter(
    (action) => action.outageKey === key && reachedTheLine(action),
  )
  const last = acted.at(-1)
  if (last !== undefined) return { endedBy: last.kind, externalAt: null }

  const restartedAt = ledger.ladder.externalRestartAt ?? null
  if (restartedAt !== null) return { endedBy: 'external', externalAt: restartedAt }
  return { endedBy: 'self', externalAt: null }
}

function summarize(ledger: Ledger, now: number): OutageSummary | null {
  const { t0, outageKey } = ledger.ladder
  if (t0 === null || outageKey === null) return null
  const endedAt = ledger.healthySince ?? now
  const { endedBy, externalAt } = attribute(ledger)
  const rungs: OutageSummary['rungs'] = ledger.actions
    .filter((action) => action.outageKey === outageKey)
    .map((action) => ({
      rung: action.kind,
      ts: action.ts,
      atS: Math.floor((action.ts - t0) / 1000),
      outcome: action.outcome,
    }))
  if (ledger.lastEscalationTs !== null && ledger.lastEscalationTs >= t0) {
    rungs.push({
      rung: 'escalate',
      ts: ledger.lastEscalationTs,
      atS: Math.floor((ledger.lastEscalationTs - t0) / 1000),
      outcome: 'escalated',
    })
  }
  return {
    outageKey,
    outageClass: ledger.ladder.outageClass ?? null,
    t0,
    endedAt,
    durationS: Math.round((endedAt - t0) / 1000),
    endedBy,
    rungs,
    externalAt,
  }
}

function actionsWithin(
  ledger: Ledger,
  now: number,
  windowMs: number,
  kind: 'reconnect' | 'reboot',
): number {
  return ledger.actions.filter((action) => action.kind === kind && now - action.ts <= windowMs)
    .length
}

function lastActionTs(ledger: Ledger, kind: 'reconnect' | 'reboot'): number | null {
  const times = ledger.actions.filter((action) => action.kind === kind).map((action) => action.ts)
  return times.length === 0 ? null : Math.max(...times)
}

/**
 * Preconditions shared by both rungs. **Every one is evaluated and all failures
 * are returned** — a stand-down whose reason is a single name is a stand-down
 * nobody can debug at 03:00.
 *
 * Six of these lived only in the specification's failure-mode prose while its
 * normative table claimed to be the complete list. The normative table is what
 * gets implemented, so they are here: the human quiet period, the process-age
 * floor, the speed-test guard, the spool-can-record gate, the link-coverage
 * demand, and the fresh-poll requirement on the reboot rung.
 */
function sharedBlockers(input: LadderInput, outageClass: OutageClass): string[] {
  const { policy, ledger, now, record } = input
  const self = measuredSelf(input.self)
  const blocked: string[] = []

  if (input.disarmed) blocked.push('disarmed_file')
  if (!policy.armed) blocked.push('not_armed')
  if (ledger.consecutiveActions >= policy.latchAfterActions) blocked.push('latched')

  if (input.self !== null && self === null) blocked.push('self_unmeasured')
  if (self === null || self.onHomeLine !== 1) blocked.push('off_home_line')
  if (record !== null && record.onHomeLine !== true) blocked.push('off_home_line_record')
  if (self !== null && self.gateway.received === 0) blocked.push('gateway_down')
  if (record !== null && record.gateway !== null && record.gateway.received === 0)
    blocked.push('gateway_down_record')

  // The failover case this exists for: a mini that fell back to a travel router
  // on the same 192.168.1.0/24 answers its gateway happily while every anchor
  // fails, and a ladder gated only on "gateway up, WAN down" would reboot a
  // perfectly healthy home router in an empty house.
  //
  // This cannot fire without `off_home_line` also firing — `vantage.ts` derives
  // `onHomeLine` from `pathClass` — and it is kept anyway, because it names
  // *which* half of that derivation failed. Redundant on the self side is
  // diagnostic; redundant on the record side would be noise, which is why
  // `RecordEvidence` carries no `pathClass`.
  if (self !== null && self.pathClass !== 'ethernet') blocked.push('not_ethernet')
  if (self !== null && record !== null && self.gatewayAddr !== record.gatewayAddr)
    blocked.push('gateway_addr_mismatch')

  const recordFresh = freshRecord(input) !== null
  if (!recordFresh && self === null) blocked.push('no_evidence')

  // "No recorded transition" means none above the 1 Hz sampling resolution was
  // observed — never that the link was stable. So demand positive coverage
  // rather than treating absence as evidence.
  if (record !== null && record.linkWatchS !== null && record.linkWatchS < 29)
    blocked.push('link_coverage_incomplete')

  if (!ACTIONABLE.has(outageClass)) blocked.push(`class_${outageClass}`)

  // Carrier evidence may veto or delay. It may never permit.
  if (input.carrier !== null && !input.carrier.stale) {
    if (input.carrier.lineStatus !== null && input.carrier.lineStatus !== 'Up')
      blocked.push('carrier_down')
    // A delay, re-evaluated, not a terminal stand-down: IPv4 returned 14–16 s
    // after showtime on 07-30 and within 5 s on 08-01, so a line that just
    // resynced deserves a moment before anything touches it.
    if (
      input.carrier.showtimeStartS !== null &&
      input.carrier.showtimeStartS < policy.resyncGraceS
    ) {
      blocked.push('resync_grace')
    }
  }

  if (ledger.pending !== null) blocked.push('action_pending')
  if (ledger.postActionCooldownUntil !== null && now < ledger.postActionCooldownUntil)
    blocked.push('post_action_cooldown')

  // The human already told us they are working on it, via `make intervention`.
  // There is no way to detect a person in the router UI — the poller's 2-on/2-off
  // failure pattern runs unbroken all night with nobody present, so poll failures
  // are not a presence signal — so an explicit quiet period is the only honest
  // mechanism available.
  if (
    input.lastHumanInterventionTs !== null &&
    now - input.lastHumanInterventionTs < policy.humanQuietS * 1000
  ) {
    blocked.push('human_quiet_period')
  }

  // A crash loop must not become a fire loop, and the escalation window must
  // consist of cycles this process watched itself.
  if (now - input.processStartedAt < policy.minProcessAgeS * 1000) blocked.push('process_too_young')

  // The runner guards concurrency with a module-scope flag inside the container,
  // invisible from here, and the speed_test row is written at the *end* of a run
  // — so inferring from "newest row is younger than 90 s" is exactly backwards.
  if (record !== null && record.speedtestRunning) blocked.push('speedtest_running')

  // No attribution possible means no action. Probe samples spool; interventions
  // do not, and an action that fired without being recorded leaves a record
  // showing an outage that ended on its own — verbatim the failure the
  // intervention route was built to prevent, which already happened once to a
  // human on 2026-08-01.
  if (!input.canRecord) blocked.push('cannot_record')

  return blocked
}

function reconnectBlockers(input: LadderInput, _t0: number): string[] {
  const { policy, ledger, now, record } = input
  const blocked: string[] = []

  // No `observe_window` blocker here, and its absence is deliberate. One lived
  // here and could never fire: this function is only called from the branch
  // guarded by `downForS >= policy.observeS`, and `downForS` is computed from
  // the same `t0` passed in — so the check was the exact negation of its own
  // caller's condition. It read as defence in depth and was dead code claiming
  // to be a precondition, which is the same class of defect as the two the
  // record-evidence fields left unreachable. The branch is the gate.

  // The belt on the timer's braces: the clock says "long enough", the cycle
  // count says "and we measured it that many times". They disagree exactly when
  // the collector was down for part of the window — which is when acting is wrong.
  const cycles = record?.ongoingWanOutage?.cycles ?? 0
  if (cycles < 8 && input.heldTicks < 8) blocked.push('insufficient_cycles')

  const last = lastActionTs(ledger, 'reconnect')
  if (last !== null && now - last < policy.reconnectMinIntervalS * 1000)
    blocked.push('reconnect_min_interval')
  if (actionsWithin(ledger, now, DAY_MS, 'reconnect') >= policy.reconnectMaxPer24h)
    blocked.push('reconnect_rate_limit')

  return blocked
}

function rebootBlockers(input: LadderInput, t0: number, outageClass: OutageClass): string[] {
  const { policy, ledger, now } = input
  const blocked: string[] = []

  if (!policy.rebootEnabled) blocked.push('reboot_disabled')
  if (outageClass === 'v4_only_down' && !policy.rebootOnV4Only)
    blocked.push('reboot_on_v4_only_disabled')

  // Likewise no `reboot_window`: `rebootIsDue` already requires
  // `downForS >= rebootDueAt` off the same `t0`, so the check could not fire.
  // The due time still lives in the policy and is still what decides the rung;
  // it is simply not restated here as a blocker that cannot block.

  // The ladder is never skipped: the cheap rung is reached and either executed
  // or blocked-and-reported before the destructive one becomes available.
  if (ledger.ladder.rung === 'observe') blocked.push('ladder_not_advanced')

  const last = lastActionTs(ledger, 'reboot')
  if (last !== null && now - last < policy.rebootMinIntervalS * 1000)
    blocked.push('reboot_min_interval')
  if (actionsWithin(ledger, now, DAY_MS, 'reboot') >= policy.rebootMaxPer24h)
    blocked.push('reboot_rate_limit')

  // Proof that the control path is currently ours. A reboot that cannot be
  // preceded by a successful poll is a write to a device we cannot read.
  if (
    input.carrier === null ||
    input.carrier.freshPollAgeS === null ||
    input.carrier.freshPollAgeS > 60
  ) {
    blocked.push('no_fresh_poll')
  }

  if (ledger.ladder.announcedAt === null) blocked.push('not_announced')
  else if (now - ledger.ladder.announcedAt < policy.announceLeadS * 1000)
    blocked.push('announce_pending')

  return blocked
}

/**
 * The judgement, given the ledger as it stands. Never mutates anything; the
 * transitions it implies are `advance`'s job, and `decide` composes the two so
 * a caller cannot take one without the other.
 */
function evaluate(input: LadderInput, outageClass: OutageClass): LadderDecision {
  const { now, policy, ledger } = input
  const healthy = outageClass === 'healthy' || outageClass === 'partial'

  const base = {
    outageClass,
    t0: ledger.ladder.t0,
    outageKey: ledger.ladder.outageKey,
    rung: ledger.ladder.rung,
  }
  const tick = now + policy.tickMs

  // Crash reconciliation, before anything else: a pending action written but not
  // confirmed is treated as having FIRED. That is the deliberate inverse of the
  // probe spool's fail-toward-resending — a probe batch is idempotent, a router
  // reboot is not.
  if (ledger.pending !== null) {
    return {
      ...base,
      state: 'settling',
      action: 'none',
      shadow: false,
      blockedBy: ['action_pending'],
      nextEvaluationAt: tick,
      note: `reconciling a ${ledger.pending.kind} that was written but not confirmed — counted as fired`,
    }
  }

  if (healthy) {
    const inLadder = ledger.ladder.t0 !== null
    if (!inLadder) {
      return {
        ...base,
        state: 'normal',
        action: 'none',
        shadow: false,
        blockedBy: [],
        nextEvaluationAt: tick,
        note: 'healthy',
      }
    }

    // A recovery has to hold as long as an outage takes to confirm. One stray
    // reply to one anchor reads as `partial`, which is healthy — and without
    // this it tore the ladder down mid-outage and wrote a self_recovery for a
    // line that was still at 100% loss.
    const healthyForMs = ledger.healthySince === null ? 0 : now - ledger.healthySince
    if (healthyForMs < policy.recoverAfterS * 1000) {
      return {
        ...base,
        state: 'recovering',
        action: 'none',
        shadow: false,
        blockedBy: ['recovery_not_sustained'],
        nextEvaluationAt: tick,
        note: `looks ${outageClass} again after ${Math.floor(healthyForMs / 1000)}s — holding the ladder until it has held ${policy.recoverAfterS}s`,
      }
    }

    return {
      ...base,
      state: 'recovered',
      action: 'none',
      shadow: false,
      blockedBy: [],
      nextEvaluationAt: tick,
      // Attribution: credit an action only when one reached the line. A refused
      // one did not, and crediting the watchdog for a recovery it had no part
      // in is the same lie the intervention route exists to prevent, told
      // about a machine.
      note: recoveryNote(ledger),
    }
  }

  if (ledger.consecutiveActions >= policy.latchAfterActions) {
    return {
      ...base,
      state: 'latched',
      action: 'none',
      shadow: false,
      blockedBy: ['latched'],
      nextEvaluationAt: tick,
      note: `${ledger.consecutiveActions} actions without ${policy.latchClearAfterCleanS}s of clean line — self-disarmed, needs a human`,
    }
  }

  if (input.heldTicks < policy.confirmTicks) {
    return {
      ...base,
      state: 'suspect',
      action: 'none',
      shadow: false,
      blockedBy: ['confirming'],
      nextEvaluationAt: tick,
      note: `${outageClass} held ${input.heldTicks}/${policy.confirmTicks} ticks`,
    }
  }

  // T0 is the outage's own start, not the moment this process noticed it, so a
  // restart mid-outage does not restart the clock. Falls back to now only when
  // the record has no outage row to read it from.
  const t0 = ledger.ladder.t0 ?? recordedOutageStart(input.record) ?? now
  const outageKey = ledger.ladder.outageKey ?? `wan:${t0}`
  const downForS = Math.floor((now - t0) / 1000)

  if (ledger.ladder.settleUntil !== null && now < ledger.ladder.settleUntil) {
    return {
      ...base,
      t0,
      outageKey,
      state: 'settling',
      action: 'none',
      shadow: false,
      blockedBy: ['settling'],
      nextEvaluationAt: Math.min(tick, ledger.ladder.settleUntil),
      note: `waiting out the ${ledger.ladder.rung} settle window`,
    }
  }

  const shared = sharedBlockers(input, outageClass)

  if (downForS >= policy.exhaustAtS) {
    const quiet =
      ledger.lastEscalationTs !== null &&
      now - ledger.lastEscalationTs < policy.escalationQuietS * 1000
    // An escalation is a notification, not a write to the line, so it is not
    // gated on `armed` — a shadow run that cannot tell you it gave up is the
    // same inert shadow mode the capability precondition already produced once.
    // It *is* gated on the disarm file, which is a human saying they have this.
    const worthWaking = ESCALATABLE.has(outageClass) && !input.disarmed
    const blockedBy = worthWaking ? shared : [...shared, `no_escalation_for_${outageClass}`]
    // Only the classes where a ladder could have run get the "ladder complete"
    // sentence. On a dead gateway or a line out of showtime there was never
    // anything to try, and saying otherwise misdescribes the evidence.
    const ranALadder = ACTIONABLE.has(outageClass)
    return {
      ...base,
      t0,
      outageKey,
      rung: 'exhausted',
      state: 'exhausted',
      action: worthWaking && !quiet ? 'escalate' : 'none',
      shadow: false,
      blockedBy,
      nextEvaluationAt: tick,
      note: worthWaking
        ? ranALadder
          ? `down ${downForS}s with the ladder complete — escalating to a human`
          : `${outageClass} for ${downForS}s and nothing here can address it — escalating to a human`
        : `${outageClass} for ${downForS}s — nothing to escalate, this says nothing about the home line`,
    }
  }

  const rebootDueAt = outageClass === 'v4_only_down' ? policy.rebootAtSv4Only : policy.rebootAtS
  const rebootIsDue = downForS >= rebootDueAt && ledger.ladder.rung !== 'observe'

  if (rebootIsDue) {
    const blockers = [...shared, ...rebootBlockers(input, t0, outageClass)]
    // The announce is its own step, so the abort window is real rather than
    // nominal: it is emitted, then the reboot waits announceLeadS for a human
    // to touch the disarm file from a phone.
    if (blockers.length === 1 && blockers[0] === 'not_announced') {
      return {
        ...base,
        t0,
        outageKey,
        rung: 'reboot',
        state: 'pre_announce',
        action: 'announce',
        shadow: false,
        blockedBy: [],
        nextEvaluationAt: Math.min(tick, now + policy.announceLeadS * 1000),
        note: `reboot due in ${policy.announceLeadS}s — announcing so it can be aborted`,
      }
    }
    return decision('reboot', blockers)
  }

  if (downForS >= policy.observeS) {
    return decision('reconnect', [...shared, ...reconnectBlockers(input, t0)])
  }

  return {
    ...base,
    t0,
    outageKey,
    rung: 'observe',
    state: 'confirmed',
    action: 'none',
    shadow: false,
    blockedBy: [],
    nextEvaluationAt: Math.min(tick, t0 + policy.observeS * 1000),
    note: `${outageClass} for ${downForS}s — observing until ${policy.observeS}s`,
  }

  function decision(kind: 'reconnect' | 'reboot', blockers: string[]): LadderDecision {
    // Capability is deliberately NOT a blocker. Making it one meant the machine
    // could never reach `armed` while a NullExecutor was wired in, so shadow
    // mode produced no `would_*` notes at all and proved nothing. Instead a
    // fully-authorised action against a null capability is reported as one, and
    // suppressed.
    const authorised = blockers.length === 0
    const shadow = authorised && input.capability === 'null'
    return {
      ...base,
      t0,
      outageKey,
      rung: kind,
      state: authorised ? 'armed' : 'blocked',
      action: authorised && !shadow ? kind : 'none',
      shadow,
      blockedBy: blockers,
      nextEvaluationAt: tick,
      note: authorised
        ? shadow
          ? `would ${kind} after ${downForS}s — suppressed, no write capability`
          : `${kind} after ${downForS}s of ${outageClass}`
        : `${kind} due after ${downForS}s but blocked by ${blockers.join(', ')}`,
    }
  }
}

function recoveryNote(ledger: Ledger): string {
  switch (attribute(ledger).endedBy) {
    case 'reconnect':
    case 'reboot':
      return 'recovered after an action in this ladder'
    case 'external':
      return 'router restarted outside the watchdog (likely manual) — recovered with no action that reached the line'
    case 'self':
      return 'recovered on its own — self_recovery'
  }
}

/** A ledger with nothing in it. The shape a first boot writes, and what tests start from. */
export function emptyLedger(): Ledger {
  return {
    version: 1,
    ladder: {
      outageKey: null,
      t0: null,
      rung: 'observe',
      enteredAt: 0,
      settleUntil: null,
      announcedAt: null,
      outageClass: null,
      gatewayLostAt: null,
      externalRestartAt: null,
    },
    actions: [],
    pending: null,
    v6: { lastUpTs: null, lastCheckedTs: null },
    postActionCooldownUntil: null,
    lastEscalationTs: null,
    consecutiveActions: 0,
    healthySince: null,
  }
}

/**
 * A ladder may climb but never descend. `rebootBlockers` refuses while the rung
 * is still `observe` — that is what guarantees the cheap rung is reached and
 * either taken or reported before the destructive one becomes available — so a
 * rung that could slip back would hand out a second reboot window per outage.
 */
const RUNG_RANK: Readonly<Record<Rung, number>> = Object.freeze({
  observe: 0,
  reconnect: 1,
  reboot: 2,
  exhausted: 3,
})

/**
 * Long enough to cover every lookback the blockers perform — 24 h for the daily
 * budgets, 6 h for the reboot spacing — with a wide margin, and short enough
 * that the file cannot grow without bound. Pruning is by timestamp rather than
 * by count so a burst cannot evict the older entry a rate limit still needs.
 */
const ACTION_RETENTION_MS = 2 * DAY_MS

function pruneActions(actions: readonly LedgerAction[], now: number): LedgerAction[] {
  return actions.filter((action) => now - action.ts <= ACTION_RETENTION_MS)
}

/**
 * The ledger the decision implies, to be fsynced **before** anything is
 * performed.
 *
 * Everything here is derived from `decision` rather than recomputed, so the two
 * can never disagree about what is happening — the failure a second
 * reimplementation in the runner would eventually produce.
 */
function advance(input: LadderInput, decision: LadderDecision): Ledger {
  const { now, policy, ledger } = input

  const next: Ledger = {
    ...ledger,
    ladder: { ...ledger.ladder },
    v6: { ...ledger.v6 },
    actions: pruneActions(ledger.actions, now),
  }

  // The v6 baseline is updated *after* classification, never before: `v6Health`
  // reads `lastUpTs` to tell "IPv6 is down" from "IPv6 was never deployed here",
  // and folding this tick's reading in first would let a v6 anchor vouch for
  // itself.
  if (input.self?.v6 != null && input.self.v6.received !== null) {
    next.v6.lastCheckedTs = input.self.probeTs
    if (input.self.v6.received > 0) next.v6.lastUpTs = input.self.probeTs
  }

  const healthy = decision.outageClass === 'healthy' || decision.outageClass === 'partial'
  if (healthy) {
    next.healthySince = ledger.healthySince ?? now
    // The latch's clear condition, which until now existed only as prose inside
    // a note string. A latched watchdog is disarmed until the line has been
    // continuously clean for `latchClearAfterCleanS` — not until the next tick
    // that happens to look fine, which a flapping line supplies every minute.
    if (now - next.healthySince >= policy.latchClearAfterCleanS * 1000) next.consecutiveActions = 0
  } else {
    next.healthySince = null
  }

  // Which ticks count has to be decided once, before any branch can return
  // early: a healthy-looking tick inside a ladder is exactly the tick that
  // proves the gateway came back, and it used to skip this.
  //
  // `gatewayLostAt` is where the current run of consecutive unreachable ticks
  // began. Anything else — a measured reachable tick or one that measured
  // nothing — ends it, so unmeasured time is never counted as lost time and
  // scattered single-probe misses never add up to a run. A run that reaches the
  // minimum is remembered in `externalRestartAt` for the rest of the ladder: the
  // router went away long enough to have been restarted.
  if (ledger.ladder.t0 !== null || decision.t0 !== null) {
    if (gatewayReading(input) === 'unreachable') {
      const lostAt = next.ladder.gatewayLostAt ?? now
      next.ladder.gatewayLostAt = lostAt
      if (
        (next.ladder.externalRestartAt ?? null) === null &&
        now - lostAt >= EXTERNAL_MIN_GATEWAY_LOSS_MS
      ) {
        next.ladder.externalRestartAt = lostAt
      }
    } else {
      next.ladder.gatewayLostAt = null
    }
  }

  // A pending action owns the ledger until `recordOutcome` closes it. Advancing
  // anything else here would be writing over a write-ahead entry that has not
  // been resolved, which is the one state the crash reconciliation depends on.
  if (ledger.pending !== null) return next

  if (healthy) {
    // Gated on the decision, not recomputed: `recovering` keeps T0 and the
    // outage key, so a flapping line continues the outage it is still in
    // rather than starting a fresh one with a fresh action budget.
    if (ledger.ladder.t0 !== null && decision.state === 'recovered') {
      // A recovery that holds a couple of cycles and fails again must not be
      // laundered into a fresh independent outage with a fresh action budget.
      // Armed at the recovery rather than at the action, deliberately: arming it
      // when the action fires would block the ladder's own next rung — the
      // reconnect at 180 s would veto the reboot at 270 s.
      const acted = ledger.actions.some((action) => action.outageKey === ledger.ladder.outageKey)
      if (acted) next.postActionCooldownUntil = now + policy.postActionCooldownS * 1000
      next.ladder = {
        outageKey: null,
        t0: null,
        rung: 'observe',
        enteredAt: now,
        settleUntil: null,
        announcedAt: null,
        outageClass: null,
        gatewayLostAt: null,
        externalRestartAt: null,
      }
    }
    return next
  }

  if (decision.t0 !== null && ledger.ladder.t0 === null) {
    next.ladder.t0 = decision.t0
    next.ladder.outageKey = decision.outageKey
    next.ladder.enteredAt = now
    next.ladder.outageClass = decision.outageClass
  }

  if (RUNG_RANK[decision.rung] > RUNG_RANK[ledger.ladder.rung]) {
    next.ladder.rung = decision.rung
    next.ladder.enteredAt = now
  }

  if (decision.action === 'announce') next.ladder.announcedAt = now
  if (decision.action === 'escalate') next.lastEscalationTs = now

  const settleS = decision.rung === 'reboot' ? policy.rebootSettleS : policy.reconnectSettleS

  if (decision.action === 'reconnect' || decision.action === 'reboot') {
    // Write-ahead. On disk before the action leaves this process, so a crash
    // between the two is reconciled as HAVING FIRED — the deliberate inverse of
    // the probe spool's fail-toward-resending, because a probe batch is
    // idempotent and a router reboot is not.
    next.pending = { ts: now, kind: decision.action, outageKey: decision.outageKey ?? `wan:${now}` }
    // Counted at the attempt, not the acknowledgement. An action whose result
    // never comes back is exactly the case the latch has to cover.
    next.consecutiveActions = ledger.consecutiveActions + 1
    next.ladder.settleUntil = now + settleS * 1000
  } else if (decision.shadow) {
    // Shadow mode still walks the whole machine: without the settle window the
    // suppressed reconnect would re-authorise on every tick and the run would
    // never reach the rung above it, so two weeks of it would report one rung.
    // No `pending`, no action row, no latch increment — nothing touched the
    // line, so nothing may count as if it had.
    next.ladder.settleUntil = now + settleS * 1000
  }

  return next
}

/**
 * The judgement and the ledger it implies, together. Total, deterministic, and
 * it never throws.
 */
export function decide(rawInput: LadderInput): LadderOutcome {
  if (!rawInput.trusted) return untrustedOutcome(rawInput)
  const input = foldStalePending(rawInput)
  const outageClass = classify(input)
  const decision = evaluate(input, outageClass)
  const closed =
    decision.state === 'recovered' && input.ledger.pending === null
      ? summarize(input.ledger, input.now)
      : null
  return {
    ...decision,
    ledger: advance(input, decision),
    persist: true,
    closed,
  }
}

/**
 * An unreadable ledger has unknown budgets and an unknown latch, so nothing may
 * be acted on *and* nothing may be written: the empty placeholder, once on disk,
 * reads as a trusted ledger with a full reboot budget and no latch on the next
 * tick. `down` reaches the watchdog's own monitor via `notificationStatus`.
 */
function untrustedOutcome(input: LadderInput): LadderOutcome {
  return {
    state: 'untrusted',
    outageClass: classify(input),
    action: 'none',
    shadow: false,
    blockedBy: ['ledger_untrusted'],
    t0: null,
    outageKey: null,
    rung: 'observe',
    nextEvaluationAt: input.now + input.policy.tickMs,
    note: 'ledger unreadable — budgets and latch unknown, standing down until a human looks',
    ledger: input.ledger,
    persist: false,
    closed: null,
  }
}

/**
 * A write-ahead `pending` entry is normally closed by `recordOutcome` in the
 * runner. If the process died between the write-ahead and that call, nothing
 * would ever clear it and the watchdog would sit in `settling` for good. Once
 * the settle window has passed the entry is folded into history as `unknown` —
 * never success, never failure: a verb may or may not have reached the line.
 * `consecutiveActions` already counted it at the attempt, so the latch is
 * untouched.
 */
function foldStalePending(input: LadderInput): LadderInput {
  const { ledger, policy, now } = input
  const pending = ledger.pending
  if (pending === null) return input

  const settleS = pending.kind === 'reboot' ? policy.rebootSettleS : policy.reconnectSettleS
  const settledAt = Math.max(pending.ts + settleS * 1000, ledger.ladder.settleUntil ?? 0)
  if (now < settledAt) return input

  const folded: Ledger = {
    ...ledger,
    pending: null,
    actions: [...ledger.actions, { ...pending, outcome: 'unknown' }],
  }
  return { ...input, ledger: folded }
}

/**
 * Close a write-ahead entry once the executor has answered. Called by the
 * runner immediately after performing, and it is the only thing that clears
 * `pending`.
 *
 * `refused` and `not_executed` give the latch increment back, and that
 * asymmetry is the point: the executor read the router and declined (no
 * connected WAN instance, an unrecognised `connType` — `refused`) or the
 * capability switch is off (`not_executed`), so nothing reached the line. Letting two pre-flight refusals self-disarm the watchdog
 * would turn a transient read hiccup into a permanent stand-down needing a
 * human. `failed` and `unknown` both count, because in each of those a verb
 * went out and the state of the line afterwards is not something this process
 * knows.
 */
export function recordOutcome(ledger: Ledger, action: LedgerAction): Ledger {
  const reachedTheLine = action.outcome !== 'not_executed' && action.outcome !== 'refused'
  return {
    ...ledger,
    pending: null,
    actions: [...ledger.actions, action],
    consecutiveActions: reachedTheLine
      ? ledger.consecutiveActions
      : Math.max(0, ledger.consecutiveActions - 1),
    // A refusal bought no settle window either — there is nothing settling.
    ladder: reachedTheLine ? ledger.ladder : { ...ledger.ladder, settleUntil: null },
  }
}

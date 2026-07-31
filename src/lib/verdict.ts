import type { RangeSummary } from '../db/range-summary.js'

/**
 * The rule-based verdict layer: measurements in, sentences out.
 *
 * Every function here is pure — no database, no clock, no I/O. `now` is a field
 * on `VerdictInput` rather than a call to `Date.now()`, so a fixture pins an
 * age-dependent conclusion exactly. All SQL lives in `verdict-queries.ts`; this
 * module sees plain data only.
 *
 * Three properties are load-bearing and easy to lose:
 *
 * 1. **A verdict states its evidence numbers.** `Verdict.evidence` is mandatory
 *    and non-empty — `verdict()` refuses to construct one without it. An
 *    inference presented as a measurement is the failure mode this whole layer
 *    exists to avoid.
 * 2. **A rule that needs a null term returns nothing.** Never a substitute,
 *    never a plausible default. Every field of every input is explicitly
 *    nullable so the refusal is expressible.
 * 3. **The link gate is structural, not a threshold.** Any rule that attributes
 *    a cause across a window has to know the host's link did not change inside
 *    it. Without that coverage the measurement clause stays and the cause clause
 *    goes — see `applyLinkGate`.
 *
 * No model, no LLM, no scoring. Nine rules, each independently testable.
 */

export type Severity = 'critical' | 'warn' | 'info' | 'ok'

export interface Evidence {
  label: string
  value: string
}

export interface Verdict {
  id: string
  severity: Severity
  /** One sentence, templated from live inputs. Never a literal authored in a UI component. */
  conclusion: string
  /** Mandatory and non-empty: a verdict that cannot cite its numbers cannot be constructed. */
  evidence: Evidence[]
  action: string | null
  /** Set when a cause was withheld. The UI must render this, never swallow it. */
  uncertainty: string | null
}

/**
 * Every threshold in one place, so a test and a doc read the same number. The
 * SQL in `verdict-queries.ts` interpolates from here too — a threshold with two
 * homes drifts.
 */
export const VERDICT_THRESHOLDS = {
  /**
   * Collector silence, in probe cycles. Two because a single missed cycle is a
   * normal transient: the collector's own restarts leave 26–31 s gaps. Ten is
   * five minutes of nothing, which no restart explains.
   */
  collectorSilentWarnCycles: 2,
  collectorSilentCriticalCycles: 10,
  /**
   * Fire `throughput_exceeds_link` at `wireMbps > maxLinkMbit × 1.5`. Pure
   * safety margin: `wireMbps` is computed over the run's TOTAL wall clock
   * (ramp-up and the upload phase included), so it is a *lower bound* on the
   * peak download rate, and exceeding a ceiling with a lower bound is
   * unarguable even if `duration_s` under-reports elapsed time by 2×.
   */
  throughputExceedsLinkFactor: 1.5,
  /**
   * TCP payload over a full Ethernet frame including preamble and inter-frame
   * gap (1448/1538). The honest application-layer ceiling of a link is this
   * share of its nominal rate — 94.1 Mbps on a 100 Mbit link — which is already
   * below the number a naive comparison would use.
   */
  ethernetPayloadShare: 1448 / 1538,
  /** A link below half the carrier sync rate is unambiguously the binding constraint. */
  linkBelowSyncFactor: 0.5,
  /**
   * How stale a sync reading may be and still describe now. Wider than the
   * usual two poll intervals because the poller currently stores a minority of
   * its due polls; the reading's age is cited in the sentence regardless.
   */
  syncReadingMaxAgeMs: 30 * 60_000,
  /** Coverage bars, shared by the probe and router sides so one bar means one thing. */
  coverageWarnPct: 90,
  coverageCriticalPct: 60,
  /** Showtime-derived instants within this of each other are one resync. */
  resyncClusterToleranceMs: 60_000,
  resyncMinSamples: 2,
  resyncMaxSpreadMs: 30_000,
  /** How far from the derived resync instant an outage may sit and still be the same event. */
  resyncOutageWindowMs: 120_000,
  /**
   * `max_ms / med_ms` on EVERY target at once. Over 1014 clean 4-target cycles
   * the mean of that per-cycle minimum is 2.03 and its maximum is 8.9, so 8 is
   * roughly 4× the mean and above the 99th percentile. Near-saturated on ten
   * hours of data: re-derive from a trailing 7-day window once the record
   * supports it.
   */
  pathStallMinRatio: 8,
  /** Two independent anchors answering proves forwarding worked; one could be answered off-path. */
  gatewayOutageMinWanAlive: 2,
  /** One lost packet of twenty is 5% and is noise, so symmetric loss starts at 10%. */
  symmetricLossMinPct: 10,
  /** Observed symmetric bursts differ by at most this; a real line event puts the gateway at 0. */
  symmetricLossMaxSpreadPct: 20,
  /** Share of a window the 1 Hz link sampler must cover before any attribution over it is allowed. */
  linkCoverageMinShare: 0.9,
} as const

/**
 * How much of a window the host-side link sampler actually watched, and whether
 * it saw the link move.
 *
 * This is the gate every attributing rule runs on. `watchedS === null` means no
 * cycle reported any sampling, which reads as "link state unknown", never as
 * "the link was stable" — the two are indistinguishable in the data and only
 * one of them licenses a cause.
 */
export interface LinkState {
  /** SUM(probe_cycle.link_watch_s) over the window, in seconds. null = no cycle reported it. */
  watchedS: number | null
  /** (to − from) / 1000. */
  windowS: number
  /** `link_change` events written by the link sampler inside the window. */
  transitions: number
}

/** One speed test whose throughput is checked against the link speed on record. */
export interface ThroughputCandidate {
  speedTestId: number
  ts: number
  bytesDown: number
  durationS: number
  /** bytesDown × 8 / 1e6 / durationS — averaged over the whole run, so a lower bound. */
  wireMbps: number
  /** Fastest `link_mbit` recorded anywhere in the range. */
  maxLinkMbit: number
  /** Cycles in the range that reported a link speed at all. Zero means nothing to contradict. */
  vantageCycles: number
}

/** The newest link, sync and throughput readings, plus what the range says about the vantage. */
export interface LinkVsSync {
  linkMbit: number | null
  linkMaxMbit: number | null
  linkMedia: string | null
  linkDuplex: 'full' | 'half' | null
  pathIf: string | null
  downSyncKbps: number | null
  syncObservedAt: number | null
  downloadMbps: number | null
  /** Distinct `link_mbit` values in the range. More than one and no single denominator is honest. */
  distinctLinkMbits: number
  /** Cycles in the range reporting a link speed, and how many of those were on the home line. */
  vantageCycles: number
  homeLineCycles: number
}

/** A WAN outage overlapping a derived resync instant. */
export interface ResyncOutage {
  id: number
  endedAt: number | null
  durationS: number | null
}

/** One cluster of agreeing `ts − showtime_start_s × 1000` instants. */
export interface ResyncCluster {
  /** The derived instant the line entered showtime. */
  upAt: number
  samples: number
  spreadMs: number
  outage: ResyncOutage | null
  /** Link coverage around `upAt`, not over the whole request window — see `carrierResyncDated`. */
  linkState: LinkState
}

export interface PathStallTarget {
  target: string
  medMs: number
  maxMs: number
}

/** A cycle where every target's worst RTT blew out together with zero packet loss. */
export interface PathStall {
  ts: number
  targetCount: number
  /** The *smallest* max/med ratio across the cycle's targets — so every target cleared it. */
  minRatio: number
  maxLossPct: number
  /** Seconds of link sampling behind this cycle. null = no sampler, i.e. unknown. */
  linkWatchS: number | null
  perTarget: PathStallTarget[]
}

export interface AnchorReply {
  target: string
  received: number
  medMs: number | null
  sent: number
}

/** A gateway outage the same cycle's WAN anchors contradict. */
export interface GatewayOutageContradiction {
  outageId: number
  ts: number
  /** Null when the cycle carried no gateway probe row at all — unknown, not zero. */
  gatewaySent: number | null
  /** Null when the cycle carried no gateway probe row at all — unknown, not zero. */
  gatewayReceived: number | null
  wanAliveCount: number
  wanMedMs: number | null
  anchors: AnchorReply[]
  /** Three-state, straight from `probe_cycle`. Only `1` licenses this verdict. */
  onHomeLine: number | null
  gatewayAddr: string | null
  /** The preceding cycle's gateway. A change here is a gateway replacement, not a contradiction. */
  previousGatewayAddr: string | null
}

export interface SymmetricLossExampleTarget {
  target: string
  lossPct: number
  medMs: number | null
}

/** Cycles that lost packets equally on the LAN gateway and on every WAN anchor. */
export interface SymmetricLoss {
  cycles: number
  firstTs: number
  lastTs: number
  wanTargetCount: number
  /** Worst per-target median across those cycles — the "medians stayed sane" number, measured. */
  worstMedMs: number | null
  exampleTs: number | null
  exampleTargets: SymmetricLossExampleTarget[]
  /** Cumulative NIC counter movement across the window. null = not on record, never 0. */
  ifIerrsDelta: number | null
  ifOerrsDelta: number | null
  ifCollDelta: number | null
}

/** Carrier-side poll coverage of the window, plus why the poller is off when it is. */
export interface RouterCoverage {
  enabled: boolean
  disabledReason: string | null
  polls: number
  expectedPolls: number
  /** Largest gap between consecutive polls. null = fewer than two polls, so no gap exists. */
  worstGapMs: number | null
  lastPollTs: number | null
  pollIntervalS: number
}

/**
 * Everything the nine rules read. Every field is explicitly nullable where the
 * measurement can be absent; a rule that needs a null term returns nothing.
 */
export interface VerdictInput {
  /** A field, not `Date.now()`, so an age-dependent conclusion is deterministic in a test. */
  now: number
  from: number
  to: number
  probeCycleSeconds: number
  /** Link sampler coverage over the whole request window. */
  linkState: LinkState
  /** MAX(probe_sample.ts) over the whole record — collector liveness is a now-question. */
  lastProbeTs: number | null
  coverage: RangeSummary
  router: RouterCoverage
  throughput: ThroughputCandidate[]
  linkVsSync: LinkVsSync
  resyncClusters: ResyncCluster[]
  pathStalls: PathStall[]
  gatewayOutages: GatewayOutageContradiction[]
  symmetricLoss: SymmetricLoss | null
  /** `link_change` events of any source in the window — what could have explained a link change. */
  linkChangeEvents: number
}

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'warn', 'info', 'ok']

/**
 * One step down the ladder, never past `info`. `ok` asserts the line is fine,
 * and a verdict downgraded precisely because the evidence for its cause is
 * missing has not earned that claim — the downgrade must not be able to turn a
 * withheld attribution into a clean bill of health.
 */
function downgrade(severity: Severity): Severity {
  const floor = SEVERITY_ORDER.indexOf('info')
  const index = SEVERITY_ORDER.indexOf(severity)
  if (index < 0 || index >= floor) return severity
  return SEVERITY_ORDER[index + 1] ?? severity
}

/** `2026-07-30 12:09:05 UTC` — instants are always stated in UTC, never in a local guess. */
function utc(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** An evidence row. `null` prints as the word `unknown` — never as 0, and never as a guess. */
function ev(label: string, value: string | number | null): Evidence {
  return { label, value: value === null ? 'unknown' : String(value) }
}

/**
 * The only way to build a `Verdict`. Refuses an empty evidence list at the
 * construction site rather than letting an uncited sentence reach a dashboard,
 * where it is indistinguishable from a measured one.
 */
function verdict(v: Verdict): Verdict {
  if (v.evidence.length === 0) throw new Error(`verdict "${v.id}" has no evidence — a conclusion that cannot cite its numbers must not exist`)
  return v
}

/**
 * Whether the host link is known not to have moved across the window.
 *
 * Both halves are required: coverage below the bar means a transition could
 * have hidden in the unsampled part, and a recorded transition means one
 * demonstrably happened. `watchedS === null` fails, because no sampler ran.
 */
export function linkCertain(link: LinkState): boolean {
  if (link.watchedS === null || link.windowS <= 0) return false
  return link.watchedS / link.windowS >= VERDICT_THRESHOLDS.linkCoverageMinShare && link.transitions === 0
}

/**
 * Share of the window the sampler actually watched.
 *
 * `watchedS === null` is 0 here and that is not a fabrication: null means no
 * cycle reported any sampling, so zero seconds of link sampling are on record,
 * which is exactly what the sentence built from this number says.
 */
function linkCoveragePct(link: LinkState): number {
  if (link.windowS <= 0) return 0
  return Math.min(100, (100 * (link.watchedS ?? 0)) / link.windowS)
}

/** Why an attribution over this window is not defensible, or null when it is. */
function linkUncertainty(link: LinkState): string | null {
  if (linkCertain(link)) return null
  if (link.transitions > 0) return `${link.transitions} host link transitions were recorded in this window, so no attribution over it is defensible.`
  return `The host link sampler covered ${round1(linkCoveragePct(link))}% of this window, so a link transition inside it cannot be ruled out.`
}

/**
 * The link gate, applied to an already-built verdict: downgrade one step and
 * name what is missing. The other half — dropping the cause clause from the
 * sentence — happens where the sentence is assembled, because only the rule
 * knows which clause is the cause.
 */
function applyLinkGate(v: Verdict, link: LinkState): Verdict {
  const uncertainty = linkUncertainty(link)
  if (uncertainty === null) return v
  return { ...v, severity: downgrade(v.severity), uncertainty }
}

/**
 * Collector liveness. The outage detector only advances when a cycle arrives,
 * so a dead collector produces no outage rows and every dashboard reads green —
 * silence has to be louder than an outage, not quieter.
 */
export function collectorSilent(input: VerdictInput): Verdict | null {
  const { lastProbeTs, now, probeCycleSeconds } = input

  // An empty database is not a collector that died. Saying so would invent a
  // failure for a service that was never started.
  if (lastProbeTs === null) {
    return verdict({
      id: 'no_data',
      severity: 'warn',
      conclusion: 'No probe cycle has ever been ingested. Nothing in this record describes the line — an empty record is not an uptime record.',
      evidence: [ev('Probe cycles on record', 0)],
      action: 'Check the launchd collector: `make collector-logs`.',
      uncertainty: null,
    })
  }

  const ageS = Math.round((now - lastProbeTs) / 1000)
  if (ageS <= probeCycleSeconds * VERDICT_THRESHOLDS.collectorSilentWarnCycles) return null

  return verdict({
    id: 'collector_silent',
    severity: ageS > probeCycleSeconds * VERDICT_THRESHOLDS.collectorSilentCriticalCycles ? 'critical' : 'warn',
    conclusion:
      `No probe cycle has been ingested for ${ageS} s. The line's state is unknown, not healthy — the outage detector only advances ` +
      'when a cycle arrives, so an absent collector produces no outage row and reads as green.',
    evidence: [ev('Last probe cycle', utc(lastProbeTs)), ev('Age', `${ageS} s`), ev('Probe cadence', `${probeCycleSeconds} s`)],
    action: 'Check the launchd collector: `make collector-logs`.',
    uncertainty: null,
  })
}

/**
 * A speed test that moved more traffic than the recorded link could carry.
 *
 * The comparison is against the range MAXIMUM link speed, not the nearest
 * vantage reading: a nearest-neighbour lookup returns null exactly for the
 * tests that predate the vantage record, which is how this stayed unknowable
 * through four investigations. A maximum can only under-fire.
 */
export function throughputExceedsLink(input: VerdictInput): Verdict[] {
  return input.throughput
    .filter((t) => t.vantageCycles > 0 && t.maxLinkMbit > 0 && t.wireMbps > t.maxLinkMbit * VERDICT_THRESHOLDS.throughputExceedsLinkFactor)
    .map((t) => {
      const ceilingMbps = round1(t.maxLinkMbit * VERDICT_THRESHOLDS.ethernetPayloadShare)
      // Only claimed when it is true: a link_change in the window is a candidate
      // explanation, and asserting none exists while one does is the fabrication
      // this rule is meant to catch, only pointing the other way.
      const uncovered = input.linkChangeEvents === 0 ? ', and no link_change event covers it' : ''
      return verdict({
        id: 'throughput_exceeds_link',
        severity: 'critical',
        conclusion:
          `Speed test #${t.speedTestId} at ${utc(t.ts)} moved ${t.bytesDown} bytes in ${round1(t.durationS)} s — ${round1(t.wireMbps)} Mbps ` +
          'of traffic averaged over the entire run, including ramp-up and the upload phase. The fastest link speed recorded anywhere in ' +
          `this range is ${t.maxLinkMbit} Mbit. The link was faster than the record says while that test ran${uncovered}.`,
        evidence: [
          ev('Speed test', `#${t.speedTestId}`),
          ev('Ran at', utc(t.ts)),
          ev('Bytes down', t.bytesDown),
          ev('Duration', `${round1(t.durationS)} s`),
          ev('Averaged wire rate', `${round1(t.wireMbps)} Mbps`),
          ev('Fastest link on record in range', `${t.maxLinkMbit} Mbit`),
          ev('Application-layer ceiling of that link', `${ceilingMbps} Mbps`),
          ev('Cycles reporting a link speed', t.vantageCycles),
          ev('link_change events in range', input.linkChangeEvents),
        ],
        action:
          'The vantage record has a hole. Check probe_cycle coverage around that timestamp — the collector recorded no link speed there, ' +
          'so the link change went unrecorded.',
        uncertainty: null,
      })
    })
}

/**
 * The host's Ethernet link, not the line, is the cap.
 *
 * Four guards, every one load-bearing: any missing term refuses the verdict, a
 * link that renegotiated inside the range has no single honest denominator, a
 * range not entirely on the home line is measuring something else, and a stale
 * sync reading does not describe now. The `on_home_line` test is
 * `homeLineCycles === vantageCycles` on a non-zero count, which fails closed on
 * both 0 and null.
 */
export function linkBelowCarrierSync(input: VerdictInput): Verdict | null {
  const s = input.linkVsSync
  const { linkMbit, downSyncKbps, downloadMbps, syncObservedAt } = s
  if (linkMbit === null || downSyncKbps === null || downloadMbps === null || syncObservedAt === null) return null
  if (s.distinctLinkMbits > 1) return null
  if (s.vantageCycles === 0 || s.homeLineCycles !== s.vantageCycles) return null

  // Present-tense claim about what caps the line right now, so its staleness is
  // measured against `now` rather than the window's end.
  const syncAgeMs = input.now - syncObservedAt
  if (syncAgeMs < 0 || syncAgeMs > VERDICT_THRESHOLDS.syncReadingMaxAgeMs) return null
  if (linkMbit * 1000 >= downSyncKbps * VERDICT_THRESHOLDS.linkBelowSyncFactor) return null

  const syncAgeMin = Math.round(syncAgeMs / 60_000)
  const downSyncMbit = round1(downSyncKbps / 1000)
  const linkPct = round1((100 * linkMbit * 1000) / downSyncKbps)
  const effPct = round1((100 * downloadMbps) / linkMbit)
  const duplexClause = s.linkDuplex === null ? '' : ` ${s.linkDuplex} duplex`
  // Appended only when the NIC demonstrably supports more than it negotiated. A
  // null ceiling must never become an implied 1000 — that would invent a cable
  // fault out of an unread field.
  const nicCanDoMore = s.linkMaxMbit !== null && s.linkMaxMbit > linkMbit
  const maxClause = nicCanDoMore ? ` The NIC advertises ${s.linkMaxMbit} Mbit as supported, so this is the cable or the switch port, not the hardware.` : ''

  const action = nicCanDoMore
    ? 'Swap the Ethernet cable, then the router LAN port, and record each attempt with POST /api/interventions so the recovery is attributable.'
    : s.linkMaxMbit === null
      ? `Run \`ifconfig -m ${s.pathIf ?? '<default-route interface>'}\` to see whether the NIC supports more than it negotiated.`
      : `The NIC advertises no media faster than the ${linkMbit} Mbit it negotiated, so this is the hardware — a faster adapter, not a cable swap.`

  return verdict({
    id: 'link_below_carrier_sync',
    severity: 'critical',
    conclusion:
      `The host's Ethernet link is the cap, not the line. The carrier syncs at ${downSyncMbit} Mbit down (read ${syncAgeMin} min ago); ` +
      `the link negotiated ${linkMbit} Mbit${duplexClause} — ${linkPct}% of it. The last speed test read ${round1(downloadMbps)} Mbps, ` +
      `which is ${effPct}% of the link.${maxClause}`,
    evidence: [
      ev('Carrier sync down', `${downSyncKbps} kbps`),
      ev('Sync read at', utc(syncObservedAt)),
      ev('Sync reading age', `${syncAgeMin} min`),
      ev('Negotiated link', `${linkMbit} Mbit`),
      ev('Link media', s.linkMedia),
      ev('Link duplex', s.linkDuplex),
      ev('NIC supported maximum', s.linkMaxMbit === null ? null : `${s.linkMaxMbit} Mbit`),
      ev('Last download', `${round1(downloadMbps)} Mbps`),
      ev('Link vs sync', `${linkPct}%`),
      ev('Download vs link', `${effPct}%`),
      ev('Cycles reporting a link speed', s.vantageCycles),
    ],
    action,
    // Never "the router port is the cap": autonegotiation produces one mutually
    // agreed outcome and no stored field says which end forced it.
    uncertainty: null,
  })
}

/**
 * How much of the window was measured at all. "24 h, 0 min downtime" over a
 * range the collector was absent for is the most expensive lie this service can
 * tell, and this is the verdict that refuses to let it stand alone.
 */
export function probeCoverageLow(input: VerdictInput): Verdict | null {
  const c = input.coverage

  // Unknown, never 0. A range shorter than one probe cycle expects less than a
  // whole cycle, and calling that "0% measured" claims a fully measured window
  // was unmeasured — the same lie inverted.
  if (c.coveragePct === null) {
    return verdict({
      id: 'coverage_unknown',
      severity: 'info',
      conclusion:
        `Coverage for this window is unknown: it is shorter than one probe cycle, so there is no share of it to report. ` +
        `${c.recordedCycles} cycles were recorded inside it.`,
      evidence: [ev('Recorded cycles', c.recordedCycles), ev('Expected cycles', c.expectedCycles), ev('Coverage', 'unknown')],
      action: null,
      uncertainty: 'A window shorter than one probe cycle cannot be scored for coverage.',
    })
  }

  const cycleMs = Math.max(1, Math.round(input.probeCycleSeconds * 1000))
  // Installing the collector mid-window is not a coverage fault, so the severity
  // is driven by the share measured *since the record starts* when that is
  // later than `from`. The window figure is still reported — it is what every
  // range chart is drawn over.
  const startedLate = c.firstTs !== null && c.firstTs > input.from
  const expectedSince = startedLate && c.firstTs !== null ? Math.round((input.to - c.firstTs) / cycleMs) : 0
  const sincePct = expectedSince > 0 ? Math.min(100, (100 * c.recordedCycles) / expectedSince) : null
  const effectivePct = sincePct ?? c.coveragePct
  if (effectivePct >= VERDICT_THRESHOLDS.coverageWarnPct) return null

  const sinceClause =
    sincePct !== null && c.firstTs !== null
      ? ` The record starts at ${utc(c.firstTs)}; measured from there it is ${round1(sincePct)}% — ${c.recordedCycles} of ${expectedSince} cycles.`
      : ''

  return verdict({
    id: 'probe_coverage_low',
    severity: effectivePct < VERDICT_THRESHOLDS.coverageCriticalPct ? 'critical' : 'warn',
    conclusion:
      `This window is ${round1(c.coveragePct)}% measured — ${c.recordedCycles} of ${c.expectedCycles} cycles.${sinceClause} ` +
      'Downtime, availability and every latency figure for this range describe only the measured part.',
    evidence: [
      ev('Recorded cycles', c.recordedCycles),
      ev('Expected cycles', c.expectedCycles),
      ev('Coverage', `${round1(c.coveragePct)}%`),
      ev('First cycle', c.firstTs === null ? null : utc(c.firstTs)),
      ev('Last cycle', c.lastTs === null ? null : utc(c.lastTs)),
      ev('Degraded cycles', c.degradedCycles),
      ev('On home line', c.onHomeLine),
      ev('Cycles with no vantage', c.unknownHomeLineCycles),
    ],
    action: "Check the collector's log for spool events and restarts: `make collector-logs`.",
    uncertainty: null,
  })
}

/**
 * The carrier-side counterpart of `probeCoverageLow`. Deliberately states no
 * cause: the gap distribution is suggestive, but "the router is dropping the
 * poller's session" is a diagnosis this data cannot prove, and a confident
 * wrong cause is worse than a bare number.
 */
export function routerCoverageLow(input: VerdictInput): Verdict | null {
  const r = input.router

  // 0% coverage from a poller that is switched off is correct configuration,
  // not a fault, and must never be reported as one.
  if (!r.enabled) {
    return verdict({
      id: 'router_disabled',
      severity: 'info',
      conclusion:
        'The router poller is off, so this window holds no carrier-side measurement. Sync rate, noise margin and showtime are unknown ' +
        'here, not unchanged.',
      evidence: [ev('Poller', 'disabled'), ev('Reason', r.disabledReason)],
      action: null,
      uncertainty: null,
    })
  }

  if (r.polls === 0) {
    return verdict({
      id: 'router_no_data',
      severity: 'warn',
      conclusion:
        'The router poller is enabled but stored no line sample in this window, so there is no carrier-side measurement of it. Sync rate, ' +
        'noise margin and showtime are unknown here, not unchanged.',
      evidence: [
        ev('Polls stored', 0),
        ev('Polls due', r.expectedPolls),
        ev('Poll interval', `${r.pollIntervalS} s`),
        ev('Last poll on record', r.lastPollTs === null ? null : utc(r.lastPollTs)),
      ],
      action: 'Check the router poller: `make logs | grep router`.',
      uncertainty: null,
    })
  }

  if (r.expectedPolls <= 0) return null
  const pct = Math.min(100, (100 * r.polls) / r.expectedPolls)
  if (pct >= VERDICT_THRESHOLDS.coverageWarnPct) return null

  // Fewer than two polls leaves no interval to measure, so the gap is unknown
  // rather than 0 and the clause is dropped instead of filled in.
  const gapClause = r.worstGapMs === null ? '' : `, worst gap ${round1(r.worstGapMs / 60_000)} min`

  return verdict({
    id: 'router_coverage_low',
    severity: pct < VERDICT_THRESHOLDS.coverageCriticalPct ? 'critical' : 'warn',
    conclusion:
      `Carrier-side coverage for this window is ${round1(pct)}% — ${r.polls} of ${r.expectedPolls} due polls${gapClause}. ` +
      'Sync rate, noise margin and showtime between those points are not measured.',
    evidence: [
      ev('Polls stored', r.polls),
      ev('Polls due', r.expectedPolls),
      ev('Coverage', `${round1(pct)}%`),
      ev('Worst gap', r.worstGapMs === null ? null : `${round1(r.worstGapMs / 60_000)} min`),
      ev('Poll interval', `${r.pollIntervalS} s`),
      ev('Last poll', r.lastPollTs === null ? null : utc(r.lastPollTs)),
    ],
    action: "Check the router poller's session handling: `make logs | grep router`.",
    uncertainty: null,
  })
}

/**
 * Dates the last carrier resync to the second, retroactively.
 *
 * `ts − showtime_start_s × 1000` is an absolute instant carried forward by a
 * counter, so several polls hours apart agree on it and it dates an event that
 * happened before polling started. The consecutive-poll resync detector can
 * only say "somewhere in the last poll interval".
 *
 * Gated, and this is the rule the gate was written for: a router reboot
 * produces both a resync and a host-side link-down, so an outage ending seconds
 * after the derived instant is attributable to the line ONLY when the link is
 * known not to have moved around it. The gate runs over ±2 min of `upAt`, not
 * over the request window, because that is the interval the attribution rests on.
 */
export function carrierResyncDated(input: VerdictInput): Verdict[] {
  return input.resyncClusters
    .filter((cluster) => cluster.samples >= VERDICT_THRESHOLDS.resyncMinSamples && cluster.spreadMs <= VERDICT_THRESHOLDS.resyncMaxSpreadMs)
    .map((cluster) => {
      const certain = linkCertain(cluster.linkState)
      const outage = cluster.outage
      // Both terms required: a null `ended_at` (ongoing) has no delta to state
      // and a null `duration_s` has no length, and neither may be filled in.
      const attributable = certain && outage !== null && outage.endedAt !== null && outage.durationS !== null
      const deltaS = outage !== null && outage.endedAt !== null ? Math.round((outage.endedAt - cluster.upAt) / 1000) : null
      const attributionClause =
        attributable && outage !== null ? ` Outage #${outage.id} (${outage.durationS} s) ended ${deltaS} s after it, so that outage was the line.` : ''

      return applyLinkGate(
        verdict({
          id: 'carrier_resync_dated',
          severity: 'info',
          conclusion: `The line entered showtime at ${utc(cluster.upAt)}. ${cluster.samples} router polls agree to within ${round1(cluster.spreadMs / 1000)} s.${attributionClause}`,
          evidence: [
            ev('Derived showtime start', utc(cluster.upAt)),
            ev('Agreeing polls', cluster.samples),
            ev('Agreement spread', `${round1(cluster.spreadMs / 1000)} s`),
            ev('Overlapping WAN outage', outage === null ? 'none' : `#${outage.id}`),
            ev('That outage lasted', outage === null ? 'none' : outage.durationS === null ? null : `${outage.durationS} s`),
            ev('Outage ended after showtime by', deltaS === null ? 'none' : `${deltaS} s`),
            ev('Link sampler coverage around it', `${round1(linkCoveragePct(cluster.linkState))}%`),
            ev('Link transitions around it', cluster.linkState.transitions),
          ],
          action: attributable || certain ? null : 'Enable the link sampler so the next resync can be separated from a host-side link event.',
          uncertainty: null,
        }),
        cluster.linkState,
      )
    })
}

/**
 * Every target stalling together inside one cycle, with no packet loss at all.
 *
 * This is the zero-loss, normal-median case every median-based rule is blind
 * to: the cycle's medians look healthy and only the per-target maxima blow out,
 * together. Requiring ALL targets is what makes it a path event rather than a
 * target event — a single-packet outlier on one target produces a large ratio
 * routinely.
 *
 * It never claims to have detected a link flap. Of the three cycles it fires on
 * in the current record two sit beside a logged link-down and one does not; the
 * rule states what it measured and leaves the cause to the link sampler.
 */
export function subCyclePathStall(input: VerdictInput): Verdict[] {
  return input.pathStalls
    .filter((stall) => stall.maxLossPct === 0 && stall.minRatio >= VERDICT_THRESHOLDS.pathStallMinRatio)
    .map((stall) => {
      const sampled = stall.linkWatchS !== null
      const action = !sampled
        ? 'The link sampler was not running here — enable it so the next one is attributed.'
        : input.linkState.transitions === 0
          ? 'No link transition longer than the 1 s sampling resolution was observed; check host load at that instant.'
          : 'A host link transition was recorded in this window — check `GET /api/events` for the `link_change` nearest this instant.'

      return verdict({
        id: 'sub_cycle_path_stall',
        severity: 'info',
        conclusion:
          `All ${stall.targetCount} targets stalled together inside the cycle at ${utc(stall.ts)}: every one shows a worst RTT at least ` +
          `${round1(stall.minRatio)}× its own median, with zero packet loss. Something on the shared path — the host, its NIC, or the LAN — ` +
          'paused for part of that cycle. Which one is not measurable from this data.',
        evidence: [
          ev('Cycle', utc(stall.ts)),
          ev('Targets', stall.targetCount),
          ev('Smallest max/median ratio', `${round1(stall.minRatio)}×`),
          ev('Medians', stall.perTarget.map((t) => `${t.target} ${round1(t.medMs)} ms`).join(', ')),
          ev('Worst round trips', stall.perTarget.map((t) => `${t.target} ${round1(t.maxMs)} ms`).join(', ')),
          ev('Worst loss in the cycle', `${stall.maxLossPct}%`),
          ev('Link sampling behind this cycle', stall.linkWatchS === null ? null : `${stall.linkWatchS} s`),
        ],
        action,
        uncertainty: sampled ? null : 'The link sampler did not back this cycle, so a link transition inside it cannot be ruled out.',
      })
    })
}

/**
 * A gateway outage the same cycle contradicts: the gateway answered none of its
 * own echoes while the WAN anchors answered normally, and WAN traffic transits
 * the gateway.
 *
 * Two structural guards come before the contradiction. A cycle not on the home
 * line genuinely reaches the WAN without this gateway (a cellular or Wi-Fi
 * failover), which is the one case where the contradiction is not one — and
 * `on_home_line` null is unknown, so it fails closed. A gateway *replacement*
 * mid-range looks identical, so an unchanged `gateway_addr` is required and a
 * null one is refused rather than assumed unchanged.
 *
 * Gated: what this data cannot say is *why* the gateway stopped answering. The
 * plausible causal reading (ICMP deprioritised under a burst) is deliberately
 * absent from the sentence — a link-down seconds away explains it equally well.
 */
export function gatewayOutageUncorroborated(input: VerdictInput): Verdict[] {
  return input.gatewayOutages
    .filter(
      (o) =>
        o.onHomeLine === 1 &&
        o.gatewayAddr !== null &&
        o.previousGatewayAddr !== null &&
        o.gatewayAddr === o.previousGatewayAddr &&
        // Both `=== 0` and `!== null`: an unprobed gateway is unknown, and "returned 0 of 0
        // replies" would state that unknown as a measured contradiction.
        o.gatewayReceived === 0 &&
        o.gatewaySent !== null &&
        o.wanAliveCount >= VERDICT_THRESHOLDS.gatewayOutageMinWanAlive,
    )
    .flatMap((o) => {
      const gatewaySent = o.gatewaySent
      // Unreachable given the filter above; the narrowing is what stops a future edit to that
      // filter from silently reintroducing the "0 of null" sentence.
      if (gatewaySent === null) return []
      const medClause = o.wanMedMs === null ? '' : ` at ${round1(o.wanMedMs)} ms median`
      return applyLinkGate(
        verdict({
          id: 'gateway_outage_uncorroborated',
          severity: 'warn',
          conclusion:
            `Gateway outage #${o.outageId} at ${utc(o.ts)} is not corroborated: the gateway returned 0 of ${gatewaySent} replies while ` +
            `${o.wanAliveCount} WAN anchors each answered in the same cycle${medClause}. Traffic reached the WAN, so it transited the ` +
            'gateway. Why the gateway stopped answering its own echoes is not measurable from this data.',
          evidence: [
            ev('Outage', `#${o.outageId}`),
            ev('Cycle', utc(o.ts)),
            ev('Gateway replies', `${o.gatewayReceived} of ${gatewaySent}`),
            ev('WAN anchors answering', o.wanAliveCount),
            ev('Anchor replies', o.anchors.map((a) => `${a.target} ${a.received}/${a.sent}`).join(', ')),
            ev('Anchor medians', o.anchors.map((a) => `${a.target} ${a.medMs === null ? 'unknown' : `${round1(a.medMs)} ms`}`).join(', ')),
            ev('On home line', o.onHomeLine),
            ev('Link transitions in window', input.linkState.transitions),
          ],
          action:
            'Do not exclude this from downtime totals until the link record for that instant is known. OutageDetector.evaluateScope opens a ' +
            'gateway outage on the gateway result alone with no cross-check, so this shape will recur.',
          uncertainty: null,
        }),
        input.linkState,
      )
    })
}

/**
 * Loss that hit the LAN gateway and every WAN anchor equally in the same cycle.
 *
 * Loss to a device on the local LAN and to several unrelated networks at once
 * is not the line. The wording is the whole guard: it says "the host or the
 * LAN", never "nothing is wrong" — a dying NIC or a saturated switch port
 * produces exactly this shape. The NIC counter deltas are cited as a
 * measurement, not as proof: those counters read 0 across logged link-downs on
 * this host too, so a zero establishes only that the NIC reported no errors.
 */
export function symmetricLossNotLine(input: VerdictInput): Verdict | null {
  const s = input.symmetricLoss
  if (s === null || s.cycles === 0) return null

  const medianClause = s.worstMedMs === null ? '' : `, with medians topping out at ${round1(s.worstMedMs)} ms`
  const deltasKnown = s.ifIerrsDelta !== null && s.ifOerrsDelta !== null && s.ifCollDelta !== null
  const nicClause = deltasKnown
    ? ` The NIC error counters moved by ${s.ifIerrsDelta}/${s.ifOerrsDelta}/${s.ifCollDelta} across that window.`
    : ' The NIC error counters are not on record across that window, so they neither corroborate nor rule anything out.'

  const example =
    s.exampleTs === null
      ? []
      : [
          ev('Worked example', utc(s.exampleTs)),
          ev('Its loss', s.exampleTargets.map((t) => `${t.target} ${t.lossPct}%`).join(', ')),
          ev('Its medians', s.exampleTargets.map((t) => `${t.target} ${t.medMs === null ? 'unknown' : `${round1(t.medMs)} ms`}`).join(', ')),
        ]

  return applyLinkGate(
    verdict({
      id: 'symmetric_loss_not_line',
      severity: 'info',
      conclusion:
        `${s.cycles} loss cycles in this range lost packets equally on the LAN gateway and on all ${s.wanTargetCount} WAN anchors at once ` +
        `(${utc(s.firstTs)} to ${utc(s.lastTs)}). Loss to a device on your own LAN and to ${s.wanTargetCount} unrelated networks in the same ` +
        `cycle${medianClause}, is not the line — it is the host or the LAN.${nicClause}`,
      evidence: [
        ev('Cycles', s.cycles),
        ev('First', utc(s.firstTs)),
        ev('Last', utc(s.lastTs)),
        ev('WAN anchors', s.wanTargetCount),
        ev('Worst median across them', s.worstMedMs === null ? null : `${round1(s.worstMedMs)} ms`),
        ...example,
        ev('NIC input errors moved by', s.ifIerrsDelta),
        ev('NIC output errors moved by', s.ifOerrsDelta),
        ev('NIC collisions moved by', s.ifCollDelta),
      ],
      action: 'Not an ISP matter. Compare against host load at those instants.',
      uncertainty: null,
    }),
    input.linkState,
  )
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warn: 1, info: 2, ok: 3 }

/**
 * Every rule, ordered by severity and then by id. `Array.prototype.sort` is
 * stable, so several instances of the same rule keep the order the rule emitted
 * them in — chronological for the per-row rules.
 */
export function deriveVerdicts(input: VerdictInput): Verdict[] {
  const verdicts: Verdict[] = [
    collectorSilent(input),
    ...throughputExceedsLink(input),
    linkBelowCarrierSync(input),
    probeCoverageLow(input),
    routerCoverageLow(input),
    ...carrierResyncDated(input),
    ...subCyclePathStall(input),
    ...gatewayOutageUncorroborated(input),
    symmetricLossNotLine(input),
  ].filter((v): v is Verdict => v !== null)

  return verdicts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id))
}

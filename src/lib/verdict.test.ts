import { describe, expect, test } from 'bun:test'
import type { RangeSummary } from '../db/range-summary.js'
import {
  carrierResyncDated,
  collectorSilent,
  deriveVerdicts,
  gatewayOutageUncorroborated,
  linkBelowCarrierSync,
  linkCertain,
  probeCoverageLow,
  routerCoverageLow,
  subCyclePathStall,
  symmetricLossNotLine,
  throughputExceedsLink,
  type LinkState,
  type VerdictInput,
} from './verdict.js'

/**
 * The verdict layer is pure, so every one of these fixtures is the whole world
 * the rule saw. Three things are asserted for each rule, and the middle one is
 * the point of the file:
 *
 * 1. it fires with the exact sentence, so a template can never drift silently;
 * 2. **it returns nothing when any single term it needs is null** — one test per
 *    nullable input, because a rule that substitutes a plausible value for a
 *    missing measurement is the failure this whole service exists to prevent;
 * 3. the link gate drops the cause clause, sets `uncertainty` and downgrades,
 *    rather than printing a cited, confident, unfounded sentence.
 */

const NOW = Date.UTC(2026, 6, 30, 20, 0, 0)
const FROM = NOW - 24 * 60 * 60 * 1000
const TO = NOW
const WINDOW_S = (TO - FROM) / 1000

/** No sampler ran: the production state until the link sampler ships. */
const NO_LINK_COVERAGE: LinkState = { watchedS: null, windowS: WINDOW_S, transitions: 0 }
/** Full coverage, nothing moved — the only state that licenses an attribution. */
const FULL_LINK_COVERAGE: LinkState = { watchedS: WINDOW_S, windowS: WINDOW_S, transitions: 0 }

const FULL_COVERAGE: RangeSummary = {
  from: FROM,
  to: TO,
  recordedCycles: 2880,
  expectedCycles: 2880,
  coveragePct: 100,
  firstTs: FROM,
  lastTs: TO,
  degradedCycles: 0,
  degradedLossPct: 20,
  onHomeLine: 'all',
  homeLineCycles: 2880,
  offHomeLineCycles: 0,
  unknownHomeLineCycles: 0,
}

function baseInput(overrides: Partial<VerdictInput> = {}): VerdictInput {
  const base: VerdictInput = {
    now: NOW,
    from: FROM,
    to: TO,
    probeCycleSeconds: 30,
    linkState: NO_LINK_COVERAGE,
    lastProbeTs: NOW - 15_000,
    coverage: FULL_COVERAGE,
    router: { enabled: true, disabledReason: null, polls: 288, expectedPolls: 288, worstGapMs: 300_000, lastPollTs: NOW - 60_000, pollIntervalS: 300 },
    throughput: [],
    linkVsSync: {
      linkMbit: null,
      linkMaxMbit: null,
      linkMedia: null,
      linkDuplex: null,
      pathIf: null,
      downSyncKbps: null,
      syncObservedAt: null,
      downloadMbps: null,
      distinctLinkMbits: 0,
      vantageCycles: 0,
      homeLineCycles: 0,
    },
    resyncClusters: [],
    pathStalls: [],
    gatewayOutages: [],
    symmetricLoss: null,
    linkChangeEvents: 0,
  }
  return { ...base, ...overrides }
}

describe('collector_silent', () => {
  test('fires above two probe cycles of silence', () => {
    const v = collectorSilent(baseInput({ lastProbeTs: NOW - 90_000 }))
    expect(v?.id).toBe('collector_silent')
    expect(v?.severity).toBe('warn')
    expect(v?.conclusion).toBe(
      "No probe cycle has been ingested for 90 s. The line's state is unknown, not healthy — the outage detector only advances when a cycle arrives, so an absent collector produces no outage row and reads as green.",
    )
  })

  test('goes critical above ten', () => {
    expect(collectorSilent(baseInput({ lastProbeTs: NOW - 600_000 }))?.severity).toBe('critical')
  })

  test('a single missed cycle is a transient, not a verdict', () => {
    expect(collectorSilent(baseInput({ lastProbeTs: NOW - 45_000 }))).toBeNull()
  })

  test('an empty record is `no_data`, never a collector that died', () => {
    const v = collectorSilent(baseInput({ lastProbeTs: null }))
    expect(v?.id).toBe('no_data')
    expect(v?.conclusion).toContain('has ever been ingested')
  })
})

describe('throughput_exceeds_link', () => {
  const candidate = {
    speedTestId: 4,
    ts: Date.UTC(2026, 6, 30, 13, 4, 0),
    bytesDown: 712_140_000,
    durationS: 24.9,
    wireMbps: 228.8,
    maxLinkMbit: 100,
    vantageCycles: 1200,
  }

  test('fires on both of the real tests that beat the recorded link', () => {
    const verdicts = throughputExceedsLink(baseInput({ throughput: [candidate, { ...candidate, speedTestId: 5, wireMbps: 165.2 }] }))
    expect(verdicts).toHaveLength(2)
    expect(verdicts[0]?.severity).toBe('critical')
    expect(verdicts[0]?.conclusion).toBe(
      'Speed test #4 at 2026-07-30 13:04:00 UTC moved 712140000 bytes in 24.9 s — 228.8 Mbps of traffic averaged over the entire run, including ramp-up and the upload phase. The fastest link speed recorded anywhere in this range is 100 Mbit. The link was faster than the record says while that test ran, and no link_change event covers it.',
    )
    expect(verdicts[1]?.conclusion).toContain('165.2 Mbps')
  })

  test('no link speed recorded in the range means nothing to contradict', () => {
    expect(throughputExceedsLink(baseInput({ throughput: [{ ...candidate, vantageCycles: 0 }] }))).toEqual([])
  })

  test('inside the 1.5× safety margin it stays silent', () => {
    expect(throughputExceedsLink(baseInput({ throughput: [{ ...candidate, wireMbps: 140 }] }))).toEqual([])
  })

  test('a link_change in the range is a candidate explanation, so the claim that none covers it is dropped', () => {
    const [v] = throughputExceedsLink(baseInput({ throughput: [candidate], linkChangeEvents: 2 }))
    expect(v?.conclusion).toContain('while that test ran.')
    expect(v?.conclusion).not.toContain('no link_change event')
  })
})

describe('link_below_carrier_sync', () => {
  const linkVsSync = {
    linkMbit: 100,
    linkMaxMbit: 1000,
    linkMedia: '100baseTX',
    linkDuplex: 'full' as const,
    pathIf: 'en0',
    downSyncKbps: 803_140,
    syncObservedAt: NOW - 10 * 60_000,
    downloadMbps: 93.5,
    distinctLinkMbits: 1,
    vantageCycles: 1200,
    homeLineCycles: 1200,
  }

  test('fires with the sync age and both ratios in the sentence', () => {
    const v = linkBelowCarrierSync(baseInput({ linkVsSync }))
    expect(v?.severity).toBe('critical')
    expect(v?.conclusion).toBe(
      "The host's Ethernet link is the cap, not the line. The carrier syncs at 803.1 Mbit down (read 10 min ago); the link negotiated 100 Mbit full duplex — 12.5% of it. The last speed test read 93.5 Mbps, which is 93.5% of the link. The NIC advertises 1000 Mbit as supported, so this is the cable or the switch port, not the hardware.",
    )
    expect(v?.action).toContain('Swap the Ethernet cable')
  })

  test.each([
    ['a missing link speed', { linkMbit: null }],
    ['a missing carrier sync rate', { downSyncKbps: null }],
    ['a missing sync reading instant', { syncObservedAt: null }],
    ['a missing download figure', { downloadMbps: null }],
  ])('%s refuses the verdict rather than substituting one', (_label, patch) => {
    expect(linkBelowCarrierSync(baseInput({ linkVsSync: { ...linkVsSync, ...patch } }))).toBeNull()
  })

  test('a link that renegotiated inside the range has no honest denominator', () => {
    expect(linkBelowCarrierSync(baseInput({ linkVsSync: { ...linkVsSync, distinctLinkMbits: 2 } }))).toBeNull()
  })

  test('a cycle that never reported a vantage is not counted as the home line', () => {
    // homeLineCycles < vantageCycles is exactly the `on_home_line IS NULL` case:
    // it must fail closed, never read as 1.
    expect(linkBelowCarrierSync(baseInput({ linkVsSync: { ...linkVsSync, homeLineCycles: 1199 } }))).toBeNull()
    expect(linkBelowCarrierSync(baseInput({ linkVsSync: { ...linkVsSync, vantageCycles: 0, homeLineCycles: 0 } }))).toBeNull()
  })

  test('a sync reading older than 30 min no longer describes now', () => {
    expect(linkBelowCarrierSync(baseInput({ linkVsSync: { ...linkVsSync, syncObservedAt: NOW - 31 * 60_000 } }))).toBeNull()
  })

  test('a link above half the sync rate is not the binding constraint', () => {
    expect(linkBelowCarrierSync(baseInput({ linkVsSync: { ...linkVsSync, linkMbit: 1000 } }))).toBeNull()
  })

  test('an unread NIC ceiling never becomes an implied 1000', () => {
    const v = linkBelowCarrierSync(baseInput({ linkVsSync: { ...linkVsSync, linkMaxMbit: null } }))
    expect(v?.conclusion).not.toContain('advertises')
    expect(v?.action).toBe('Run `ifconfig -m en0` to see whether the NIC supports more than it negotiated.')
  })

  test('a NIC already at its ceiling is hardware, not a cable', () => {
    const v = linkBelowCarrierSync(baseInput({ linkVsSync: { ...linkVsSync, linkMaxMbit: 100 } }))
    expect(v?.conclusion).not.toContain('advertises')
    expect(v?.action).toContain('a faster adapter, not a cable swap')
  })
})

describe('probe_coverage_low', () => {
  test('fires critical on a third of a window measured', () => {
    const v = probeCoverageLow(baseInput({ coverage: { ...FULL_COVERAGE, recordedCycles: 979, coveragePct: (100 * 979) / 2880 } }))
    expect(v?.severity).toBe('critical')
    expect(v?.conclusion).toBe(
      'This window is 34% measured — 979 of 2880 cycles. Downtime, availability and every latency figure for this range describe only the measured part.',
    )
  })

  test('warns between the two bars', () => {
    expect(probeCoverageLow(baseInput({ coverage: { ...FULL_COVERAGE, recordedCycles: 2304, coveragePct: 80 } }))?.severity).toBe('warn')
  })

  test('a fully measured window says nothing', () => {
    expect(probeCoverageLow(baseInput())).toBeNull()
  })

  test('coverage that is not expressible is `unknown`, never 0%', () => {
    const v = probeCoverageLow(baseInput({ coverage: { ...FULL_COVERAGE, recordedCycles: 1, expectedCycles: 0, coveragePct: null } }))
    expect(v?.id).toBe('coverage_unknown')
    expect(v?.conclusion).toContain('unknown')
    expect(v?.evidence).toContainEqual({ label: 'Coverage', value: 'unknown' })
  })

  test('a collector installed mid-window is not a coverage fault', () => {
    // 120 cycles over the final hour is complete coverage of the record's own
    // span; scoring it 4% of the day would invent a fault out of an install.
    const firstTs = TO - 60 * 60 * 1000
    const v = probeCoverageLow(baseInput({ coverage: { ...FULL_COVERAGE, recordedCycles: 120, coveragePct: (100 * 120) / 2880, firstTs } }))
    expect(v).toBeNull()
  })

  test('a late start that is still patchy reports both percentages', () => {
    const firstTs = TO - 60 * 60 * 1000
    const v = probeCoverageLow(baseInput({ coverage: { ...FULL_COVERAGE, recordedCycles: 60, coveragePct: (100 * 60) / 2880, firstTs } }))
    expect(v?.conclusion).toBe(
      'This window is 2.1% measured — 60 of 2880 cycles. The record starts at 2026-07-30 19:00:00 UTC; measured from there it is 50% — 60 of 120 cycles. Downtime, availability and every latency figure for this range describe only the measured part.',
    )
    expect(v?.severity).toBe('critical')
  })
})

describe('router_coverage_low', () => {
  const patchy = { enabled: true, disabledReason: null, polls: 20, expectedPolls: 55, worstGapMs: 1_500_000, lastPollTs: NOW - 60_000, pollIntervalS: 300 }

  test('fires with the poll counts and the worst gap, and states no cause', () => {
    const v = routerCoverageLow(baseInput({ router: patchy }))
    expect(v?.severity).toBe('critical')
    expect(v?.conclusion).toBe(
      'Carrier-side coverage for this window is 36.4% — 20 of 55 due polls, worst gap 25 min. Sync rate, noise margin and showtime between those points are not measured.',
    )
    expect(v?.conclusion).not.toContain('session')
  })

  test('a poller that is switched off is configuration, not a coverage fault', () => {
    const v = routerCoverageLow(baseInput({ router: { ...patchy, enabled: false, polls: 0, disabledReason: 'LINEWATCH_ROUTER_POLL=0' } }))
    expect(v?.id).toBe('router_disabled')
    expect(v?.evidence).toContainEqual({ label: 'Reason', value: 'LINEWATCH_ROUTER_POLL=0' })
  })

  test('an enabled poller with nothing stored is not a percentage over an empty set', () => {
    const v = routerCoverageLow(baseInput({ router: { ...patchy, polls: 0 } }))
    expect(v?.id).toBe('router_no_data')
    expect(v?.conclusion).not.toContain('%')
  })

  test('fewer than two polls leaves the gap unknown rather than 0', () => {
    const v = routerCoverageLow(baseInput({ router: { ...patchy, polls: 1, worstGapMs: null } }))
    expect(v?.conclusion).toContain('1 of 55 due polls.')
    expect(v?.evidence).toContainEqual({ label: 'Worst gap', value: 'unknown' })
  })

  test('a well-covered window says nothing', () => {
    expect(routerCoverageLow(baseInput())).toBeNull()
  })
})

describe('carrier_resync_dated', () => {
  const upAt = Date.UTC(2026, 6, 30, 12, 9, 5)
  const cluster = {
    upAt,
    samples: 20,
    spreadMs: 2000,
    outage: { id: 1, endedAt: upAt + 16_000, durationS: 90 },
    linkState: { watchedS: 240, windowS: 240, transitions: 0 },
  }

  test('attributes the outage only when the link is known not to have moved', () => {
    const [v] = carrierResyncDated(baseInput({ resyncClusters: [cluster] }))
    expect(v?.conclusion).toBe(
      'The line entered showtime at 2026-07-30 12:09:05 UTC. 20 router polls agree to within 2 s. Outage #1 (90 s) ended 16 s after it, so that outage was the line.',
    )
    expect(v?.uncertainty).toBeNull()
    expect(v?.action).toBeNull()
  })

  test('without link coverage it states the instant and withholds the attribution', () => {
    const [v] = carrierResyncDated(baseInput({ resyncClusters: [{ ...cluster, linkState: { watchedS: null, windowS: 240, transitions: 0 } }] }))
    expect(v?.conclusion).toBe('The line entered showtime at 2026-07-30 12:09:05 UTC. 20 router polls agree to within 2 s.')
    expect(v?.conclusion).not.toContain('was the line')
    expect(v?.uncertainty).toBe('The host link sampler covered 0% of this window, so a link transition inside it cannot be ruled out.')
    expect(v?.action).toContain('Enable the link sampler')
  })

  test('a recorded link transition kills the attribution outright', () => {
    const [v] = carrierResyncDated(baseInput({ resyncClusters: [{ ...cluster, linkState: { watchedS: 240, windowS: 240, transitions: 2 } }] }))
    expect(v?.conclusion).not.toContain('was the line')
    expect(v?.uncertainty).toBe('2 host link transitions were recorded in this window, so no attribution over it is defensible.')
  })

  test('one poll cannot agree with itself', () => {
    expect(carrierResyncDated(baseInput({ resyncClusters: [{ ...cluster, samples: 1, spreadMs: 0 }] }))).toEqual([])
  })

  test('polls that disagree — a clock step — fall silent rather than firing on a phantom', () => {
    expect(carrierResyncDated(baseInput({ resyncClusters: [{ ...cluster, spreadMs: 40_000 }] }))).toEqual([])
  })

  test.each([
    ['no overlapping outage', { outage: null }],
    ['an ongoing outage with no end instant', { outage: { id: 1, endedAt: null, durationS: null } }],
    ['an outage whose duration was never written', { outage: { id: 1, endedAt: upAt + 16_000, durationS: null } }],
  ])('%s leaves the attribution unstated', (_label, patch) => {
    const [v] = carrierResyncDated(baseInput({ resyncClusters: [{ ...cluster, ...patch }] }))
    expect(v?.conclusion).not.toContain('was the line')
  })
})

describe('sub_cycle_path_stall', () => {
  const stall = {
    ts: Date.UTC(2026, 6, 30, 13, 46, 47),
    targetCount: 4,
    minRatio: 12.3,
    maxLossPct: 0,
    linkWatchS: null,
    perTarget: [
      { target: 'cloudflare', medMs: 4.2, maxMs: 52.6 },
      { target: 'gateway', medMs: 1.2, maxMs: 15.1 },
      { target: 'google', medMs: 12.4, maxMs: 152.7 },
      { target: 'quad9', medMs: 11.1, maxMs: 137 },
    ],
  }

  test('fires on the whole cycle and claims no cause', () => {
    const [v] = subCyclePathStall(baseInput({ pathStalls: [stall] }))
    expect(v?.severity).toBe('info')
    expect(v?.conclusion).toBe(
      'All 4 targets stalled together inside the cycle at 2026-07-30 13:46:47 UTC: every one shows a worst RTT at least 12.3× its own median, with zero packet loss. Something on the shared path — the host, its NIC, or the LAN — paused for part of that cycle. Which one is not measurable from this data.',
    )
    expect(v?.conclusion).not.toContain('link')
  })

  test('an unsampled cycle says so instead of implying the link held', () => {
    const [v] = subCyclePathStall(baseInput({ pathStalls: [stall] }))
    expect(v?.uncertainty).toBe('The link sampler did not back this cycle, so a link transition inside it cannot be ruled out.')
    expect(v?.action).toBe('The link sampler was not running here — enable it so the next one is attributed.')
  })

  test('a sampled cycle with nothing recorded reports the sampling resolution, not stability', () => {
    const [v] = subCyclePathStall(baseInput({ pathStalls: [{ ...stall, linkWatchS: 30 }] }))
    expect(v?.uncertainty).toBeNull()
    expect(v?.action).toBe('No link transition longer than the 1 s sampling resolution was observed; check host load at that instant.')
  })

  test('below the ratio, or with any loss at all, it is another rule’s cycle', () => {
    expect(subCyclePathStall(baseInput({ pathStalls: [{ ...stall, minRatio: 7 }] }))).toEqual([])
    expect(subCyclePathStall(baseInput({ pathStalls: [{ ...stall, maxLossPct: 5 }] }))).toEqual([])
  })
})

describe('gateway_outage_uncorroborated', () => {
  const ts = Date.UTC(2026, 6, 30, 12, 45, 51)
  const contradiction = {
    outageId: 2,
    ts,
    gatewaySent: 20,
    gatewayReceived: 0,
    wanAliveCount: 3,
    wanMedMs: 61.9,
    anchors: [
      { target: 'cloudflare', received: 20, sent: 20, medMs: 61.2 },
      { target: 'google', received: 19, sent: 20, medMs: 62.1 },
      { target: 'quad9', received: 20, sent: 20, medMs: 62.4 },
    ],
    onHomeLine: 1,
    gatewayAddr: '192.168.1.1',
    previousGatewayAddr: '192.168.1.1',
  }

  test('fires, downgraded by the link gate, with no causal claim', () => {
    const [v] = gatewayOutageUncorroborated(baseInput({ gatewayOutages: [contradiction] }))
    expect(v?.severity).toBe('info')
    expect(v?.conclusion).toBe(
      'Gateway outage #2 at 2026-07-30 12:45:51 UTC is not corroborated: the gateway returned 0 of 20 replies while 3 WAN anchors each answered in the same cycle at 61.9 ms median. Traffic reached the WAN, so it transited the gateway. Why the gateway stopped answering its own echoes is not measurable from this data.',
    )
    expect(v?.conclusion).not.toContain('deprioritis')
    expect(v?.uncertainty).toBe('The host link sampler covered 0% of this window, so a link transition inside it cannot be ruled out.')
  })

  test('with full link coverage it keeps its own severity', () => {
    const [v] = gatewayOutageUncorroborated(baseInput({ gatewayOutages: [contradiction], linkState: FULL_LINK_COVERAGE }))
    expect(v?.severity).toBe('warn')
    expect(v?.uncertainty).toBeNull()
  })

  test.each([
    ['a cycle that never reported a vantage', { onHomeLine: null }],
    ['a cycle that was not on the home line', { onHomeLine: 0 }],
    ['an unreported gateway address', { gatewayAddr: null }],
    ['no preceding cycle to compare the gateway against', { previousGatewayAddr: null }],
    ['a gateway replacement mid-range', { previousGatewayAddr: '192.168.2.1' }],
    ['a single anchor answering, which could be answered off-path', { wanAliveCount: 1 }],
  ])('%s suppresses it', (_label, patch) => {
    expect(gatewayOutageUncorroborated(baseInput({ gatewayOutages: [{ ...contradiction, ...patch }] }))).toEqual([])
  })

  test('without anchor medians the sentence drops the figure instead of inventing one', () => {
    const [v] = gatewayOutageUncorroborated(baseInput({ gatewayOutages: [{ ...contradiction, wanMedMs: null }] }))
    expect(v?.conclusion).toContain('answered in the same cycle. Traffic reached the WAN')
  })
})

describe('symmetric_loss_not_line', () => {
  const firstTs = Date.UTC(2026, 6, 30, 12, 41, 21)
  const lastTs = Date.UTC(2026, 6, 30, 14, 12, 51)
  const loss = {
    cycles: 25,
    firstTs,
    lastTs,
    wanTargetCount: 3,
    worstMedMs: 6.2,
    exampleTs: firstTs,
    exampleTargets: [
      { target: 'cloudflare', lossPct: 70, medMs: 4.9 },
      { target: 'gateway', lossPct: 80, medMs: 1.4 },
      { target: 'google', lossPct: 70, medMs: 6.2 },
      { target: 'quad9', lossPct: 70, medMs: 5.8 },
    ],
    ifIerrsDelta: 0,
    ifOerrsDelta: 0,
    ifCollDelta: 0,
  }

  test('says host or LAN, never that nothing is wrong', () => {
    const v = symmetricLossNotLine(baseInput({ symmetricLoss: loss }))
    expect(v?.conclusion).toBe(
      '25 loss cycles in this range lost packets equally on the LAN gateway and on all 3 WAN anchors at once (2026-07-30 12:41:21 UTC to 2026-07-30 14:12:51 UTC). Loss to a device on your own LAN and to 3 unrelated networks in the same cycle, with medians topping out at 6.2 ms, is not the line — it is the host or the LAN. The NIC error counters moved by 0/0/0 across that window.',
    )
    expect(v?.conclusion).not.toContain('nothing is wrong')
    expect(v?.conclusion).not.toContain('probe process')
  })

  test('the link gate applies here too', () => {
    expect(symmetricLossNotLine(baseInput({ symmetricLoss: loss }))?.uncertainty).toBe(
      'The host link sampler covered 0% of this window, so a link transition inside it cannot be ruled out.',
    )
    expect(symmetricLossNotLine(baseInput({ symmetricLoss: loss, linkState: FULL_LINK_COVERAGE }))?.uncertainty).toBeNull()
  })

  test('counters that are not on record are stated as absent, not as zero', () => {
    const v = symmetricLossNotLine(baseInput({ symmetricLoss: { ...loss, ifIerrsDelta: null, ifOerrsDelta: null, ifCollDelta: null } }))
    expect(v?.conclusion).toContain('not on record across that window')
    expect(v?.evidence).toContainEqual({ label: 'NIC input errors moved by', value: 'unknown' })
  })

  test('an unmeasured median drops the clause rather than claiming baseline', () => {
    const v = symmetricLossNotLine(baseInput({ symmetricLoss: { ...loss, worstMedMs: null } }))
    expect(v?.conclusion).toContain('in the same cycle, is not the line')
    expect(v?.conclusion).not.toContain('topping out')
  })

  test.each([
    ['nothing measured', null],
    ['no qualifying cycle', { ...loss, cycles: 0 }],
  ])('%s produces no verdict', (_label, symmetricLoss) => {
    expect(symmetricLossNotLine(baseInput({ symmetricLoss }))).toBeNull()
  })
})

describe('deriveVerdicts', () => {
  const populated = baseInput({
    lastProbeTs: NOW - 600_000,
    coverage: { ...FULL_COVERAGE, recordedCycles: 979, coveragePct: (100 * 979) / 2880 },
    router: { enabled: true, disabledReason: null, polls: 20, expectedPolls: 55, worstGapMs: 1_500_000, lastPollTs: NOW - 60_000, pollIntervalS: 300 },
    throughput: [
      { speedTestId: 4, ts: Date.UTC(2026, 6, 30, 13, 4, 0), bytesDown: 712_140_000, durationS: 24.9, wireMbps: 228.8, maxLinkMbit: 100, vantageCycles: 1200 },
      { speedTestId: 5, ts: Date.UTC(2026, 6, 30, 13, 19, 0), bytesDown: 514_100_000, durationS: 24.9, wireMbps: 165.2, maxLinkMbit: 100, vantageCycles: 1200 },
    ],
    pathStalls: [
      {
        ts: Date.UTC(2026, 6, 30, 13, 46, 47),
        targetCount: 4,
        minRatio: 12.3,
        maxLossPct: 0,
        linkWatchS: null,
        perTarget: [{ target: 'gateway', medMs: 1.2, maxMs: 15.1 }],
      },
    ],
  })

  test('orders by severity, then by id, keeping instances of one rule in emission order', () => {
    const verdicts = deriveVerdicts(populated)
    expect(verdicts.map((v) => v.id)).toEqual([
      'collector_silent',
      'probe_coverage_low',
      'router_coverage_low',
      'throughput_exceeds_link',
      'throughput_exceeds_link',
      'sub_cycle_path_stall',
    ])
    expect(verdicts[3]?.conclusion).toContain('#4')
    expect(verdicts[4]?.conclusion).toContain('#5')
  })

  test('every verdict cites its numbers', () => {
    for (const v of deriveVerdicts(populated)) expect(v.evidence.length).toBeGreaterThan(0)
  })

  test('a healthy, fully measured window produces nothing at all', () => {
    expect(deriveVerdicts(baseInput())).toEqual([])
  })
})

describe('the link gate', () => {
  test.each([
    ['no sampler at all', { watchedS: null, windowS: 100, transitions: 0 }, false],
    ['partial coverage', { watchedS: 80, windowS: 100, transitions: 0 }, false],
    ['full coverage with a recorded transition', { watchedS: 100, windowS: 100, transitions: 1 }, false],
    ['coverage at the bar with nothing recorded', { watchedS: 90, windowS: 100, transitions: 0 }, true],
    ['a zero-length window', { watchedS: 0, windowS: 0, transitions: 0 }, false],
  ])('%s → %p', (_label, link: LinkState, expected) => {
    expect(linkCertain(link)).toBe(expected)
  })
})

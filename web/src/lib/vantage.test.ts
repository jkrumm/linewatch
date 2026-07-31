import { describe, expect, test } from 'bun:test'
import { compareCarrierHost, homeLineChip, linkBucketState } from './vantage'
import { generateStatus } from './mock/generate'
import type { RouterSnapshot, StatusSpeedTest, Vantage, VantageBucket } from './types'

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0)

function vantage(over: Partial<Vantage> = {}): Vantage {
  return {
    ts: NOW - 15_000,
    pathIf: 'en0',
    pathClass: 'ethernet',
    linkMedia: '100baseTX',
    linkMbit: 100,
    linkDuplex: 'full',
    linkMaxMbit: 1000,
    dhcpBoundAt: NOW - 3_600_000,
    gatewayAddr: '192.168.1.1',
    onHomeLine: true,
    ...over,
  }
}

function router(over: { observedAt?: number; stale?: boolean; downSyncKbps?: number | null } = {}): RouterSnapshot {
  const observedAt = over.observedAt ?? NOW - 60_000
  return {
    pollerEnabled: true,
    disabledReason: null,
    configWarning: null,
    collectorHostIp: '192.168.1.100',
    pollIntervalMs: 300_000,
    now: NOW,
    staleAfterMs: 600_000,
    line: {
      observedAt,
      ageMs: NOW - observedAt,
      stale: over.stale ?? false,
      value: {
        id: 1,
        ts: observedAt,
        carrier: 'gfast',
        status: 'Up',
        downSyncKbps: over.downSyncKbps === undefined ? 803_140 : over.downSyncKbps,
        upSyncKbps: 60_000,
        downCurrKbps: null,
        upCurrKbps: null,
        downNoiseMarginDb: null,
        upNoiseMarginDb: null,
        downAttenuationDb: null,
        profile: null,
        showtimeStartS: 1234,
        erroredSecs: null,
        severelyErroredSecs: null,
      },
    },
    wan: null,
    lan: null,
    collectorHost: null,
    ports: null,
  }
}

const SPEED_TEST: StatusSpeedTest = {
  id: 9,
  ts: NOW - 40 * 60_000,
  ok: true,
  downloadMbps: 93.5,
  uploadMbps: 41.2,
  pingMs: 5.2,
  latencyDownMs: null,
  latencyUpMs: null,
  serverName: 'Example Networks',
  error: null,
}

describe('homeLineChip', () => {
  test('null renders as the word unknown, never as a confirmed home line', () => {
    const chip = homeLineChip(null)
    expect(chip.state).toBe('unknown')
    expect(chip.label).toBe('unknown')
    expect(chip.color).toBe('gray')
    // The exact bug this three-state column exists to prevent: unknown borrowing true's rendering.
    expect(chip).not.toEqual(homeLineChip(true))
  })

  test('true and false are distinct and neither reuses the unknown chip', () => {
    expect(homeLineChip(true).state).toBe('home-line')
    expect(homeLineChip(false).state).toBe('other-path')
    expect(homeLineChip(false).label).not.toBe(homeLineChip(null).label)
  })

  test('the mock world reaches the unknown state, so USE_MOCK development meets it', () => {
    // `VANTAGE_UNKNOWN_WINDOW` in the generator: a cycle row was written and nothing in it parsed.
    const inside = Date.now() - 19.5 * 3_600_000
    const status = generateStatus(inside)
    expect(status.vantage?.onHomeLine).toBeNull()
    expect(homeLineChip(status.vantage?.onHomeLine ?? null).label).toBe('unknown')
  })
})

describe('compareCarrierHost', () => {
  test('fresh on both sides: the ratio is computed and the three rates are carried whole', () => {
    const result = compareCarrierHost({
      router: router(),
      vantage: vantage(),
      speedTest: SPEED_TEST,
      now: NOW,
    })
    expect(result.carrier.mbps).toBeCloseTo(803.14, 2)
    expect(result.host.mbps).toBe(100)
    expect(result.throughput.mbps).toBe(93.5)
    expect(result.hostVsCarrierPct).toBeCloseTo(12.45, 2)
    expect(result.refusal).toBeNull()
  })

  test('a stale carrier part refuses the ratio and cites both ages', () => {
    const result = compareCarrierHost({
      router: router({ observedAt: NOW - 25 * 60_000, stale: true }),
      vantage: vantage(),
      speedTest: SPEED_TEST,
      now: NOW,
    })
    expect(result.hostVsCarrierPct).toBeNull()
    expect(result.refusal).toContain('25 min old')
    // Both numbers still reach the panel — refusing the ratio is not refusing the readings.
    expect(result.carrier.mbps).toBeCloseTo(803.14, 2)
    expect(result.host.mbps).toBe(100)
  })

  test('a carrier reading the server still calls current is refused once it is too old to compare', () => {
    // The regression: `stale` is derived from the poll cadence, so moving the router poll from 5 to
    // 10 minutes silently doubled this tolerance from 10 to 20 minutes — a 19-minute-old sync figure
    // would have been divided by a 30-second-old link speed and captioned "the same moment".
    // Comparability is bounded absolutely and does not move when the cadence does.
    const result = compareCarrierHost({
      router: router({ observedAt: NOW - 12 * 60_000, stale: false }),
      vantage: vantage(),
      speedTest: SPEED_TEST,
      now: NOW,
    })
    expect(result.hostVsCarrierPct).toBeNull()
    expect(result.refusal).toContain('12 min old')
    // Still fresh enough at nine minutes, so the bound is a real edge and not a blanket refusal.
    const fresh = compareCarrierHost({
      router: router({ observedAt: NOW - 9 * 60_000, stale: false }),
      vantage: vantage(),
      speedTest: SPEED_TEST,
      now: NOW,
    })
    expect(fresh.refusal).toBeNull()
    expect(fresh.hostVsCarrierPct).toBeCloseTo(12.45, 2)
  })

  test('a host vantage older than two probe cycles refuses the ratio too', () => {
    const result = compareCarrierHost({
      router: router(),
      vantage: vantage({ ts: NOW - 10 * 60_000 }),
      speedTest: SPEED_TEST,
      now: NOW,
    })
    expect(result.host.stale).toBe(true)
    expect(result.hostVsCarrierPct).toBeNull()
  })

  test('an absent reading is refused as absent, not compared as zero', () => {
    const missingLink = compareCarrierHost({
      router: router(),
      vantage: vantage({ linkMbit: null }),
      speedTest: SPEED_TEST,
      now: NOW,
    })
    expect(missingLink.host.mbps).toBeNull()
    expect(missingLink.hostVsCarrierPct).toBeNull()
    expect(missingLink.refusal).toContain('absent')

    const noRouter = compareCarrierHost({ router: null, vantage: vantage(), speedTest: null, now: NOW })
    expect(noRouter.carrier.mbps).toBeNull()
    // No reading means no age to judge — `stale: false` here would read as a fresh null.
    expect(noRouter.carrier.stale).toBeNull()
    expect(noRouter.hostVsCarrierPct).toBeNull()
    // An unread snapshot is a gap in the page, not a statement about the carrier.
    expect(noRouter.refusal).toContain('not been read')
  })

  test('a poll that returned no line row is refused as a carrier gap, not as a page gap', () => {
    const result = compareCarrierHost({
      router: { ...router(), line: null },
      vantage: vantage(),
      speedTest: SPEED_TEST,
      now: NOW,
    })
    expect(result.refusal).toContain('carrier reading')
    expect(result.refusal).not.toContain('not been read')
  })

  test('a failed speed test contributes no throughput number', () => {
    const result = compareCarrierHost({
      router: router(),
      vantage: vantage(),
      speedTest: { ...SPEED_TEST, ok: false, downloadMbps: null, error: 'no server' },
      now: NOW,
    })
    expect(result.throughput.mbps).toBeNull()
    // The hourly cadence has no two-cycle staleness rule; null says so rather than claiming fresh.
    expect(result.throughput.stale).toBeNull()
  })

  test('the measured throughput is typed apart from the two negotiated rates', () => {
    const result = compareCarrierHost({ router: router(), vantage: vantage(), speedTest: SPEED_TEST, now: NOW })
    expect(result.carrier.kind).toBe('negotiated')
    expect(result.host.kind).toBe('negotiated')
    expect(result.throughput.kind).toBe('measured')
  })
})

function bucket(over: Partial<VantageBucket> = {}): VantageBucket {
  return {
    bucket: NOW,
    cycles: 120,
    vantageCycles: 120,
    pathClasses: ['ethernet'],
    linkMbits: [1000],
    pathIfs: ['en0'],
    onHomeLine: 'all',
    homeLineCycles: 120,
    offHomeLineCycles: 0,
    unknownHomeLineCycles: 0,
    ...over,
  }
}

describe('linkBucketState', () => {
  test('two link speeds in one bucket is a transition, never an average', () => {
    const state = linkBucketState(bucket({ linkMbits: [1000, 100] }))
    expect(state).toEqual({ kind: 'transition', mbits: [100, 1000] })
  })

  test('one speed is a value, an absent bucket is unmeasured, and no reported speed is neither', () => {
    expect(linkBucketState(bucket())).toEqual({ kind: 'steady', mbit: 1000 })
    expect(linkBucketState(null)).toEqual({ kind: 'unmeasured' })
    expect(linkBucketState(bucket({ linkMbits: [], vantageCycles: 0 }))).toEqual({
      kind: 'no-vantage',
      cycles: 120,
    })
  })
})

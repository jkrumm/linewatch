import { describe, expect, test } from 'bun:test'
import { createTestDb } from './test-db.js'
import { outage, probeCycle, probeSample } from './schema.js'
import { rangeSummary } from './range-summary.js'

const CYCLE_S = 30
const CYCLE_MS = CYCLE_S * 1000
const HOUR_MS = 60 * 60 * 1000
const T0 = 10 * HOUR_MS

const PARAMS = { probeCycleSeconds: CYCLE_S, degradedLossPct: 20 }

/** One cycle: four targets, all clean except the given per-target loss. */
function cycle(ts: number, lossByTarget: Partial<Record<string, number>> = {}) {
  return ['gateway', 'cloudflare', 'google', 'quad9'].map((target) => {
    const lossPct = lossByTarget[target] ?? 0
    const received = Math.round(20 * (1 - lossPct / 100))
    return {
      ts,
      target,
      addr: '1.1.1.1',
      sent: 20,
      received,
      lossPct,
      minMs: received > 0 ? 4 : null,
      medMs: received > 0 ? 5 : null,
      maxMs: received > 0 ? 6 : null,
      avgMs: received > 0 ? 5 : null,
      jitterMs: null,
      samples: null,
    }
  })
}

function seed(db: ReturnType<typeof createTestDb>, cycles: ReturnType<typeof cycle>[]) {
  db.insert(probeSample)
    .values(cycles.flat())
    .run()
}

describe('rangeSummary — coverage', () => {
  test('an empty range reports zero recorded against a full expectation', () => {
    const db = createTestDb()
    const summary = rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS })

    expect(summary.recordedCycles).toBe(0)
    expect(summary.expectedCycles).toBe(120)
    expect(summary.coveragePct).toBe(0)
    expect(summary.firstTs).toBeNull()
    expect(summary.lastTs).toBeNull()
  })

  test('96 minutes of history inside a 24-hour window reports partial coverage, not perfection', () => {
    const db = createTestDb()
    const cycles = 96 * 2 // 96 minutes at 30 s
    const day = 24 * HOUR_MS
    seed(
      db,
      Array.from({ length: cycles }, (_, i) => cycle(T0 + i * CYCLE_MS)),
    )

    const summary = rangeSummary(db, { ...PARAMS, from: T0 + cycles * CYCLE_MS - day, to: T0 + cycles * CYCLE_MS })
    expect(summary.recordedCycles).toBe(cycles)
    expect(summary.expectedCycles).toBe(2880)
    expect(summary.coveragePct).toBeCloseTo((100 * 192) / 2880, 6)
    // The whole point: an empty outage table over this range says nothing.
    expect(summary.coveragePct).toBeLessThan(7)
  })

  test('four probe rows per cycle count as one cycle, not four', () => {
    const db = createTestDb()
    seed(db, [cycle(T0), cycle(T0 + CYCLE_MS)])

    const summary = rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS })
    expect(summary.recordedCycles).toBe(2)
    expect(summary.firstTs).toBe(T0)
    expect(summary.lastTs).toBe(T0 + CYCLE_MS)
  })

  test('coveragePct is clamped at 100 when cycles arrive faster than the cadence', () => {
    const db = createTestDb()
    seed(
      db,
      Array.from({ length: 10 }, (_, i) => cycle(T0 + i * 1000)),
    )

    const summary = rangeSummary(db, { ...PARAMS, from: T0, to: T0 + 5 * CYCLE_MS })
    expect(summary.coveragePct).toBe(100)
  })
})

describe('rangeSummary — degraded cycles', () => {
  test('the 12:41 case: 80% loss across all four targets with zero outage rows still counts', () => {
    const db = createTestDb()
    seed(db, [cycle(T0, { gateway: 80, cloudflare: 80, google: 80, quad9: 80 })])

    const summary = rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS })
    // Nothing reached zero replies, so the outage state machine wrote nothing.
    expect(db.select().from(outage).all()).toHaveLength(0)
    expect(summary.degradedCycles).toBe(1)
    expect(summary.degradedLossPct).toBe(20)
  })

  test('a single degraded target is enough — the worst target defines the cycle', () => {
    const db = createTestDb()
    seed(db, [cycle(T0, { cloudflare: 50 })])

    expect(rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS }).degradedCycles).toBe(1)
  })

  test('loss below the threshold is not degradation', () => {
    const db = createTestDb()
    seed(db, [cycle(T0, { cloudflare: 5 }), cycle(T0 + CYCLE_MS, { google: 15 })])

    expect(rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS }).degradedCycles).toBe(0)
  })

  test('the threshold is inclusive', () => {
    const db = createTestDb()
    seed(db, [cycle(T0, { cloudflare: 20 })])

    expect(rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS }).degradedCycles).toBe(1)
  })

  test('cycles inside a materialised outage are not double-counted as degradation', () => {
    const db = createTestDb()
    seed(db, [cycle(T0, { gateway: 100, cloudflare: 100, google: 100, quad9: 100 }), cycle(T0 + CYCLE_MS, { cloudflare: 60 })])
    db.insert(outage)
      .values({ scope: 'wan', startedAt: T0, endedAt: T0 + CYCLE_MS / 2, durationS: 15, cycles: 1, evidence: '[]' })
      .run()

    const summary = rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS })
    // The 100%-loss cycle is already in the outage table; only the 60% one is new.
    expect(summary.degradedCycles).toBe(1)
  })

  test('an ongoing outage (ended_at null) still covers its cycles', () => {
    const db = createTestDb()
    seed(db, [cycle(T0, { gateway: 100, cloudflare: 100, google: 100, quad9: 100 })])
    db.insert(outage).values({ scope: 'wan', startedAt: T0, cycles: 1, evidence: '[]' }).run()

    expect(rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS }).degradedCycles).toBe(0)
  })

  test('the threshold is configurable and changes the count', () => {
    const db = createTestDb()
    seed(db, [cycle(T0, { cloudflare: 10 })])

    expect(rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS, degradedLossPct: 5 }).degradedCycles).toBe(1)
    expect(rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS, degradedLossPct: 50 }).degradedCycles).toBe(0)
  })
})

describe('rangeSummary — home line', () => {
  test('no vantage at all reads as unknown, never as the home line', () => {
    const db = createTestDb()
    seed(db, [cycle(T0), cycle(T0 + CYCLE_MS)])

    const summary = rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS })
    expect(summary.onHomeLine).toBe('unknown')
    expect(summary.homeLineCycles).toBe(0)
    expect(summary.unknownHomeLineCycles).toBe(2)
  })

  test('every cycle on the home line reads `all`', () => {
    const db = createTestDb()
    seed(db, [cycle(T0), cycle(T0 + CYCLE_MS)])
    db.insert(probeCycle)
      .values([
        { ts: T0, pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 },
        { ts: T0 + CYCLE_MS, pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 },
      ])
      .run()

    const summary = rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS })
    expect(summary.onHomeLine).toBe('all')
    expect(summary.homeLineCycles).toBe(2)
  })

  test('a cellular failover inside the range makes the range mixed, and the uptime figure suspect', () => {
    const db = createTestDb()
    seed(db, [cycle(T0), cycle(T0 + CYCLE_MS)])
    db.insert(probeCycle)
      .values([
        { ts: T0, pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 },
        { ts: T0 + CYCLE_MS, pathClass: 'cellular', pathIf: 'en11', onHomeLine: 0 },
      ])
      .run()

    const summary = rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS })
    expect(summary.onHomeLine).toBe('mixed')
    expect(summary.homeLineCycles).toBe(1)
    expect(summary.offHomeLineCycles).toBe(1)
  })

  test('cycles recorded without a vantage are not folded into `all`', () => {
    const db = createTestDb()
    seed(db, [cycle(T0), cycle(T0 + CYCLE_MS)])
    db.insert(probeCycle).values([{ ts: T0, pathClass: 'ethernet', onHomeLine: 1 }]).run()

    const summary = rangeSummary(db, { ...PARAMS, from: T0, to: T0 + HOUR_MS })
    expect(summary.onHomeLine).toBe('mixed')
    expect(summary.unknownHomeLineCycles).toBe(1)
  })
})

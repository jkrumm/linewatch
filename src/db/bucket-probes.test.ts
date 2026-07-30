import { describe, expect, test } from 'bun:test'
import { createTestDb } from './test-db.js'
import { probeCycle, probeSample } from './schema.js'
import { bucketProbes, bucketVantage } from './bucket-probes.js'

const BUCKET_S = 3600 // 1 hour, matching the "hourly heatmap" use case
const BUCKET_MS = BUCKET_S * 1000
const HOUR_0 = 10 * BUCKET_MS

function sample(ts: number, target: string, medMs: number | null, lossPct = 0) {
  return {
    ts,
    target,
    addr: '1.1.1.1',
    sent: 20,
    received: medMs === null ? 0 : 20,
    lossPct,
    minMs: medMs,
    medMs,
    maxMs: medMs,
    avgMs: medMs,
    jitterMs: medMs === null ? null : 0,
    samples: null,
  }
}

/**
 * A cycle with the loss fields set independently of the latency fields — the
 * `sample()` helper above ties `received` to `medMs`, which cannot express a
 * partial-loss cycle (some packets back, so a median exists).
 */
function lossyCycle(
  ts: number,
  target: string,
  cycle: { sent: number; received: number; minMs?: number | null; medMs?: number | null; maxMs?: number | null },
) {
  const { sent, received, minMs = null, medMs = null, maxMs = null } = cycle
  return {
    ts,
    target,
    addr: '1.1.1.1',
    sent,
    received,
    lossPct: sent === 0 ? 0 : (100 * (sent - received)) / sent,
    minMs,
    medMs,
    maxMs,
    avgMs: medMs,
    jitterMs: null,
    samples: null,
  }
}

interface VantageFixture {
  pathIf?: string | null
  pathClass?: 'ethernet' | 'wifi' | 'cellular' | 'other' | null
  linkMbit?: number | null
  onHomeLine?: number | null
}

/** A probe_cycle row plus the four probe_sample rows that cycle produced. */
function cycleWithVantage(ts: number, vantage: VantageFixture) {
  return {
    cycle: {
      ts,
      pathIf: vantage.pathIf ?? null,
      pathClass: vantage.pathClass ?? null,
      linkMbit: vantage.linkMbit ?? null,
      onHomeLine: vantage.onHomeLine ?? null,
    },
    samples: ['gateway', 'cloudflare', 'google', 'quad9'].map((target) => sample(ts, target, 10)),
  }
}

function seedCycles(db: ReturnType<typeof createTestDb>, cycles: ReturnType<typeof cycleWithVantage>[]) {
  db.insert(probeSample)
    .values(cycles.flatMap((c) => c.samples))
    .run()
  db.insert(probeCycle)
    .values(cycles.map((c) => c.cycle))
    .run()
}

describe('bucketProbes', () => {
  test('returns nothing for a range with no matching rows', () => {
    const db = createTestDb()
    expect(bucketProbes(db, { from: 0, to: 1000, bucketSeconds: BUCKET_S })).toEqual([])
  })

  test('groups every cycle in the window into one bucket and computes the median-of-medians', () => {
    const db = createTestDb()
    db.insert(probeSample)
      .values([
        sample(HOUR_0 + 0, 'cloudflare', 10),
        sample(HOUR_0 + 30_000, 'cloudflare', 20),
        sample(HOUR_0 + 60_000, 'cloudflare', 30),
      ])
      .run()

    const [bucket] = bucketProbes(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(bucket).toBeDefined()
    expect(bucket?.bucket).toBe(HOUR_0)
    expect(bucket?.target).toBe('cloudflare')
    expect(bucket?.count).toBe(3)
    expect(bucket?.medianMs).toBe(20)
    expect(bucket?.p5Ms).toBe(10)
    expect(bucket?.p95Ms).toBe(30)
    expect(bucket?.maxLossPct).toBe(0)
  })

  test('a 100%-loss cycle (med_ms null) counts toward count/maxLossPct but not the percentile band', () => {
    const db = createTestDb()
    db.insert(probeSample)
      .values([
        sample(HOUR_0 + 0, 'cloudflare', 10, 0),
        sample(HOUR_0 + 30_000, 'cloudflare', 20, 0),
        sample(HOUR_0 + 60_000, 'cloudflare', null, 100),
      ])
      .run()

    const [bucket] = bucketProbes(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(bucket?.count).toBe(3)
    expect(bucket?.maxLossPct).toBe(100)
    // Median-of-medians over the two surviving samples (10, 20) — simple average.
    expect(bucket?.medianMs).toBe(15)
  })

  test('splits rows into separate buckets across a bucket boundary', () => {
    const db = createTestDb()
    db.insert(probeSample)
      .values([sample(HOUR_0 - 1, 'cloudflare', 10), sample(HOUR_0, 'cloudflare', 50)])
      .run()

    const buckets = bucketProbes(db, { from: HOUR_0 - BUCKET_MS, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(buckets).toHaveLength(2)
    expect(buckets[0]?.medianMs).toBe(10)
    expect(buckets[1]?.medianMs).toBe(50)
  })

  test('filters to a single target when requested', () => {
    const db = createTestDb()
    db.insert(probeSample)
      .values([sample(HOUR_0, 'cloudflare', 10), sample(HOUR_0, 'google', 40)])
      .run()

    const buckets = bucketProbes(db, {
      from: HOUR_0,
      to: HOUR_0 + BUCKET_MS,
      bucketSeconds: BUCKET_S,
      target: 'google',
    })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.target).toBe('google')
    expect(buckets[0]?.medianMs).toBe(40)
  })

  test('never returns more rows than bucket×target combinations regardless of row count', () => {
    const db = createTestDb()
    const rows = Array.from({ length: 500 }, (_, i) => sample(HOUR_0 + i * 1000, 'cloudflare', 10 + (i % 5)))
    db.insert(probeSample).values(rows).run()

    const buckets = bucketProbes(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.count).toBe(500)
  })

  test('one partial-loss cycle among many clean ones barely moves lossPct, but maxLossPct is large', () => {
    const db = createTestDb()
    const clean = Array.from({ length: 99 }, (_, i) =>
      lossyCycle(HOUR_0 + i * 1000, 'cloudflare', { sent: 20, received: 20, minMs: 10, medMs: 12, maxMs: 15 }),
    )
    // One cycle loses 15 of 20 packets: 75% for that cycle, 15/2000 overall.
    db.insert(probeSample)
      .values([...clean, lossyCycle(HOUR_0 + 99_000, 'cloudflare', { sent: 20, received: 5, minMs: 10, medMs: 40, maxMs: 90 })])
      .run()

    const [bucket] = bucketProbes(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(bucket?.count).toBe(100)
    expect(bucket?.maxLossPct).toBe(75)
    // 100 * 15 / 2000 — sent-weighted, not the worst cycle.
    expect(bucket?.lossPct).toBeCloseTo(0.75, 6)
    expect(bucket?.lossPct).not.toBeCloseTo(bucket?.maxLossPct ?? 0, 1)
    // Availability read off maxLossPct would claim 25% for an hour that was 99.25% up.
    expect(100 - (bucket?.lossPct ?? 0)).toBeCloseTo(99.25, 6)
    expect(bucket?.downCycles).toBe(0)
  })

  test('a bucket where every cycle is down reports lossPct 100 and downCycles = count', () => {
    const db = createTestDb()
    db.insert(probeSample)
      .values([
        lossyCycle(HOUR_0 + 0, 'cloudflare', { sent: 20, received: 0 }),
        lossyCycle(HOUR_0 + 30_000, 'cloudflare', { sent: 20, received: 0 }),
        lossyCycle(HOUR_0 + 60_000, 'cloudflare', { sent: 20, received: 0 }),
      ])
      .run()

    const [bucket] = bucketProbes(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(bucket?.count).toBe(3)
    expect(bucket?.lossPct).toBe(100)
    expect(bucket?.downCycles).toBe(3)
    expect(bucket?.medianMs).toBeNull()
    expect(bucket?.minMs).toBeNull()
    expect(bucket?.maxMs).toBeNull()
  })

  test('one fully-down cycle among clean ones: downCycles 1, lossPct strictly between 0 and maxLossPct', () => {
    const db = createTestDb()
    db.insert(probeSample)
      .values([
        lossyCycle(HOUR_0 + 0, 'cloudflare', { sent: 20, received: 20, minMs: 8, medMs: 10, maxMs: 12 }),
        lossyCycle(HOUR_0 + 30_000, 'cloudflare', { sent: 20, received: 20, minMs: 8, medMs: 10, maxMs: 12 }),
        lossyCycle(HOUR_0 + 60_000, 'cloudflare', { sent: 20, received: 20, minMs: 8, medMs: 10, maxMs: 12 }),
        lossyCycle(HOUR_0 + 90_000, 'cloudflare', { sent: 20, received: 0 }),
      ])
      .run()

    const [bucket] = bucketProbes(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(bucket?.count).toBe(4)
    expect(bucket?.downCycles).toBe(1)
    expect(bucket?.maxLossPct).toBe(100)
    expect(bucket?.lossPct).toBeCloseTo(25, 6)
    expect(bucket?.lossPct).toBeGreaterThan(0)
    expect(bucket?.lossPct).toBeLessThan(bucket?.maxLossPct ?? 0)
  })

  test('minMs/maxMs are the real round-trip extremes, not the spread of per-cycle medians', () => {
    const db = createTestDb()
    db.insert(probeSample)
      .values([
        lossyCycle(HOUR_0 + 0, 'cloudflare', { sent: 20, received: 20, minMs: 7, medMs: 10, maxMs: 240 }),
        lossyCycle(HOUR_0 + 30_000, 'cloudflare', { sent: 20, received: 20, minMs: 9, medMs: 11, maxMs: 30 }),
        lossyCycle(HOUR_0 + 60_000, 'cloudflare', { sent: 20, received: 20, minMs: 8, medMs: 12, maxMs: 45 }),
      ])
      .run()

    const [bucket] = bucketProbes(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(bucket?.minMs).toBe(7)
    expect(bucket?.maxMs).toBe(240)
    // The median band is far narrower — that is exactly why both are returned.
    expect(bucket?.medianMs).toBe(11)
    expect(bucket?.p5Ms).toBe(10)
    expect(bucket?.p95Ms).toBe(12)
  })

  test('a bucket where no packets were sent yields lossPct 0, not NaN or null', () => {
    const db = createTestDb()
    db.insert(probeSample)
      .values([
        lossyCycle(HOUR_0 + 0, 'cloudflare', { sent: 0, received: 0 }),
        lossyCycle(HOUR_0 + 30_000, 'cloudflare', { sent: 0, received: 0 }),
      ])
      .run()

    const [bucket] = bucketProbes(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(bucket?.lossPct).toBe(0)
    expect(Number.isNaN(bucket?.lossPct)).toBe(false)
    // sent = 0 still means nothing came back, so the cycle counts as down.
    expect(bucket?.downCycles).toBe(2)
    expect(bucket?.count).toBe(2)
  })
})

describe('bucketVantage', () => {
  test('returns nothing for a range with no cycles', () => {
    const db = createTestDb()
    expect(bucketVantage(db, { from: 0, to: 1000, bucketSeconds: BUCKET_S })).toEqual([])
  })

  test('an all-Ethernet bucket on the home line reports one class, one speed, and `all`', () => {
    const db = createTestDb()
    seedCycles(db, [
      cycleWithVantage(HOUR_0 + 0, { pathIf: 'en0', pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 }),
      cycleWithVantage(HOUR_0 + 30_000, { pathIf: 'en0', pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 }),
      cycleWithVantage(HOUR_0 + 60_000, { pathIf: 'en0', pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 }),
    ])

    const [bucket] = bucketVantage(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(bucket?.bucket).toBe(HOUR_0)
    // Four probe_sample rows per cycle must not inflate the cycle count.
    expect(bucket?.cycles).toBe(3)
    expect(bucket?.vantageCycles).toBe(3)
    expect(bucket?.pathClasses).toEqual(['ethernet'])
    expect(bucket?.linkMbits).toEqual([1000])
    expect(bucket?.pathIfs).toEqual(['en0'])
    expect(bucket?.onHomeLine).toBe('all')
    expect(bucket?.homeLineCycles).toBe(3)
    expect(bucket?.unknownHomeLineCycles).toBe(0)
  })

  test('a bucket mixing Ethernet and Wi-Fi is reported as mixed, not flattened to the majority', () => {
    const db = createTestDb()
    seedCycles(db, [
      cycleWithVantage(HOUR_0 + 0, { pathIf: 'en0', pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 }),
      cycleWithVantage(HOUR_0 + 30_000, { pathIf: 'en0', pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 }),
      cycleWithVantage(HOUR_0 + 60_000, { pathIf: 'en0', pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 }),
      cycleWithVantage(HOUR_0 + 90_000, { pathIf: 'en1', pathClass: 'wifi', linkMbit: 866, onHomeLine: 0 }),
    ])

    const [bucket] = bucketVantage(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(bucket?.onHomeLine).toBe('mixed')
    expect(bucket?.pathClasses).toEqual(['ethernet', 'wifi'])
    expect(bucket?.pathIfs).toEqual(['en0', 'en1'])
    expect(bucket?.homeLineCycles).toBe(3)
    expect(bucket?.offHomeLineCycles).toBe(1)
  })

  test('a bucket entirely on cellular reports `none` — it did not measure the home line', () => {
    const db = createTestDb()
    seedCycles(db, [
      cycleWithVantage(HOUR_0 + 0, { pathIf: 'en11', pathClass: 'cellular', linkMbit: 300, onHomeLine: 0 }),
      cycleWithVantage(HOUR_0 + 30_000, { pathIf: 'en10', pathClass: 'cellular', linkMbit: 480, onHomeLine: 0 }),
    ])

    const [bucket] = bucketVantage(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(bucket?.onHomeLine).toBe('none')
    expect(bucket?.pathClasses).toEqual(['cellular'])
    expect(bucket?.linkMbits).toEqual([300, 480])
    expect(bucket?.offHomeLineCycles).toBe(2)
    expect(bucket?.homeLineCycles).toBe(0)
  })

  test('a renegotiation to 100baseTX shows both speeds — a throughput cap, not an outage', () => {
    const db = createTestDb()
    seedCycles(db, [
      cycleWithVantage(HOUR_0 + 0, { pathIf: 'en0', pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 }),
      cycleWithVantage(HOUR_0 + 30_000, { pathIf: 'en0', pathClass: 'ethernet', linkMbit: 100, onHomeLine: 1 }),
    ])

    const [bucket] = bucketVantage(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    // Still the home line — the link just got slower. Both facts are needed.
    expect(bucket?.onHomeLine).toBe('all')
    expect(bucket?.linkMbits).toEqual([100, 1000])
  })

  test('cycles that predate the vantage read as unknown, not as the home line', () => {
    const db = createTestDb()
    db.insert(probeSample)
      .values([sample(HOUR_0 + 0, 'cloudflare', 10), sample(HOUR_0 + 30_000, 'cloudflare', 10)])
      .run()

    const [bucket] = bucketVantage(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(bucket?.cycles).toBe(2)
    expect(bucket?.vantageCycles).toBe(0)
    expect(bucket?.onHomeLine).toBe('unknown')
    expect(bucket?.unknownHomeLineCycles).toBe(2)
    expect(bucket?.pathClasses).toEqual([])
    expect(bucket?.linkMbits).toEqual([])
  })

  test('a partially-reported bucket is mixed, never `all` — unknown cycles are not rounded up', () => {
    const db = createTestDb()
    seedCycles(db, [
      cycleWithVantage(HOUR_0 + 0, { pathIf: 'en0', pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 }),
      // The collector reported the interface but no verdict on this one.
      cycleWithVantage(HOUR_0 + 30_000, { pathIf: 'en0', pathClass: 'ethernet', linkMbit: 1000, onHomeLine: null }),
    ])

    const [bucket] = bucketVantage(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(bucket?.vantageCycles).toBe(2)
    expect(bucket?.homeLineCycles).toBe(1)
    expect(bucket?.unknownHomeLineCycles).toBe(1)
    expect(bucket?.onHomeLine).toBe('mixed')
  })

  test('splits into separate buckets across a boundary and keeps each verdict independent', () => {
    const db = createTestDb()
    seedCycles(db, [
      cycleWithVantage(HOUR_0 - 30_000, { pathIf: 'en0', pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 }),
      cycleWithVantage(HOUR_0 + 30_000, { pathIf: 'en1', pathClass: 'wifi', linkMbit: 866, onHomeLine: 0 }),
    ])

    const buckets = bucketVantage(db, { from: HOUR_0 - BUCKET_MS, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(buckets).toHaveLength(2)
    expect(buckets[0]?.onHomeLine).toBe('all')
    expect(buckets[1]?.onHomeLine).toBe('none')
  })

  test('returns one row per bucket regardless of cycle count', () => {
    const db = createTestDb()
    seedCycles(
      db,
      Array.from({ length: 120 }, (_, i) => cycleWithVantage(HOUR_0 + i * 30_000, { pathIf: 'en0', pathClass: 'ethernet', linkMbit: 1000, onHomeLine: 1 })),
    )

    const buckets = bucketVantage(db, { from: HOUR_0, to: HOUR_0 + BUCKET_MS, bucketSeconds: BUCKET_S })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.cycles).toBe(120)
    expect(buckets[0]?.vantageCycles).toBe(120)
  })
})

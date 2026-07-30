import { describe, expect, test } from 'bun:test'
import { createTestDb } from './test-db.js'
import { probeSample } from './schema.js'
import { bucketProbes } from './bucket-probes.js'

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
})

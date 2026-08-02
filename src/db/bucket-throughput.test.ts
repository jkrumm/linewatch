import { describe, expect, test } from 'bun:test'
import { createTestDb } from './test-db.js'
import { probeCycle } from './schema.js'
import { MAX_INTERVAL_MS, bucketThroughput } from './bucket-throughput.js'

const CYCLE_MS = 30_000
const BUCKET_S = 3600
const BUCKET_MS = BUCKET_S * 1000
const HOUR_0 = 10 * BUCKET_MS

const MB = 1_000_000

interface CycleFixture {
  ts: number
  pathIf?: string | null
  ifIbytes?: number | null
  ifObytes?: number | null
}

function seed(db: ReturnType<typeof createTestDb>, cycles: CycleFixture[]) {
  db.insert(probeCycle)
    .values(
      cycles.map((c) => ({
        ts: c.ts,
        pathIf: c.pathIf === undefined ? 'en0' : c.pathIf,
        ifIbytes: c.ifIbytes === undefined ? null : c.ifIbytes,
        ifObytes: c.ifObytes === undefined ? null : c.ifObytes,
      })),
    )
    .run()
}

/** A run of cycles one probe cycle apart, each moving `perCycleIn`/`perCycleOut` bytes. */
function steady(start: number, count: number, perCycleIn: number, perCycleOut: number, base = 1_000_000_000) {
  return Array.from({ length: count }, (_, i) => ({
    ts: start + i * CYCLE_MS,
    ifIbytes: base + i * perCycleIn,
    ifObytes: base + i * perCycleOut,
  }))
}

function bucketsIn(db: ReturnType<typeof createTestDb>, from: number, to: number) {
  return bucketThroughput(db, { from, to, bucketSeconds: BUCKET_S })
}

describe('bucketThroughput', () => {
  test('an empty window returns no buckets', () => {
    const db = createTestDb()
    expect(bucketsIn(db, 0, 1000)).toEqual([])
  })

  test('differences consecutive counters into per-bucket volume', () => {
    const db = createTestDb()
    seed(db, steady(HOUR_0, 5, 10 * MB, 1 * MB))

    const [bucket] = bucketsIn(db, HOUR_0, HOUR_0 + BUCKET_MS)
    // Five cycles is four intervals.
    expect(bucket).toMatchObject({
      bucket: HOUR_0,
      inBytes: 40 * MB,
      outBytes: 4 * MB,
      spanMs: 4 * CYCLE_MS,
      intervals: 4,
      skipped: 0,
    })
  })

  /**
   * `spanMs` is the only correct denominator for a rate, and it is what makes a
   * partially measured bucket honest: bytes over the bucket *width* would report
   * a fraction of the true rate for every bucket the collector did not fully cover.
   */
  test('spanMs is the measured time, not the bucket width', () => {
    const db = createTestDb()
    seed(db, steady(HOUR_0, 3, 10 * MB, 0))

    const [bucket] = bucketsIn(db, HOUR_0, HOUR_0 + BUCKET_MS)
    expect(bucket?.spanMs).toBe(2 * CYCLE_MS)
    expect(bucket?.spanMs).toBeLessThan(BUCKET_MS)
  })

  /**
   * The load-bearing refusal. A reboot resets the counters to zero, and treating
   * the negative delta as traffic would report a nonsense volume — while treating
   * it as zero would report an idle line across a reboot that may well have been
   * busy. Neither. The interval is refused and the bucket says so.
   */
  test('a counter that went backwards is skipped, not counted as zero or as negative', () => {
    const db = createTestDb()
    seed(db, [
      { ts: HOUR_0, ifIbytes: 900 * MB, ifObytes: 900 * MB },
      { ts: HOUR_0 + CYCLE_MS, ifIbytes: 5 * MB, ifObytes: 1 * MB },
      { ts: HOUR_0 + 2 * CYCLE_MS, ifIbytes: 15 * MB, ifObytes: 3 * MB },
    ])

    const [bucket] = bucketsIn(db, HOUR_0, HOUR_0 + BUCKET_MS)
    // Only the post-reboot interval counts: 10 MB in, 2 MB out.
    expect(bucket).toMatchObject({ inBytes: 10 * MB, outBytes: 2 * MB, intervals: 1, skipped: 1 })
    expect(bucket!.inBytes).toBeGreaterThan(0)
  })

  /** The counters are per interface, so a delta across a failover subtracts one
   * NIC's lifetime from another's. It is meaningless whichever sign it has. */
  test('an interval spanning an interface change is skipped', () => {
    const db = createTestDb()
    seed(db, [
      { ts: HOUR_0, pathIf: 'en0', ifIbytes: 100 * MB, ifObytes: 10 * MB },
      { ts: HOUR_0 + CYCLE_MS, pathIf: 'en1', ifIbytes: 900 * MB, ifObytes: 90 * MB },
      { ts: HOUR_0 + 2 * CYCLE_MS, pathIf: 'en1', ifIbytes: 910 * MB, ifObytes: 91 * MB },
    ])

    const [bucket] = bucketsIn(db, HOUR_0, HOUR_0 + BUCKET_MS)
    expect(bucket).toMatchObject({ inBytes: 10 * MB, outBytes: 1 * MB, intervals: 1, skipped: 1 })
  })

  /**
   * The volume across a long gap is accurate; *when it moved* is not, and the
   * bucket boundary would place all of it at the far end. A collector restarted
   * after three hours would otherwise draw a spike of three hours' traffic at the
   * instant it came back.
   */
  test('an interval longer than MAX_INTERVAL_MS is skipped rather than spiked into one bucket', () => {
    const db = createTestDb()
    const afterGap = HOUR_0 + MAX_INTERVAL_MS + CYCLE_MS
    seed(db, [
      { ts: HOUR_0, ifIbytes: 100 * MB, ifObytes: 10 * MB },
      { ts: afterGap, ifIbytes: 5_000 * MB, ifObytes: 500 * MB },
    ])

    const [bucket] = bucketsIn(db, HOUR_0, HOUR_0 + BUCKET_MS)
    expect(bucket).toMatchObject({ inBytes: 0, outBytes: 0, spanMs: 0, intervals: 0, skipped: 1 })
  })

  test('an interval exactly at MAX_INTERVAL_MS is still accepted', () => {
    const db = createTestDb()
    seed(db, [
      { ts: HOUR_0, ifIbytes: 100 * MB, ifObytes: 10 * MB },
      { ts: HOUR_0 + MAX_INTERVAL_MS, ifIbytes: 140 * MB, ifObytes: 14 * MB },
    ])

    expect(bucketsIn(db, HOUR_0, HOUR_0 + BUCKET_MS)[0]).toMatchObject({ inBytes: 40 * MB, intervals: 1, skipped: 0 })
  })

  /** A cycle that reported no counters is unknown — not a zero endpoint. Both the
   * interval into it and the interval out of it are unusable. */
  test('a cycle with null counters breaks the chain on both sides', () => {
    const db = createTestDb()
    seed(db, [
      { ts: HOUR_0, ifIbytes: 100 * MB, ifObytes: 10 * MB },
      { ts: HOUR_0 + CYCLE_MS, ifIbytes: null, ifObytes: null },
      { ts: HOUR_0 + 2 * CYCLE_MS, ifIbytes: 130 * MB, ifObytes: 13 * MB },
    ])

    const [bucket] = bucketsIn(db, HOUR_0, HOUR_0 + BUCKET_MS)
    expect(bucket).toMatchObject({ inBytes: 0, outBytes: 0, intervals: 0, skipped: 2 })
  })

  /**
   * Without the lookback the first cycle of every window has nothing to
   * difference against, so the opening bucket reads empty — an artifact of where
   * the reader put the window edge, indistinguishable from an idle line.
   */
  test('the interval across the window edge is recovered from the preceding cycle', () => {
    const db = createTestDb()
    seed(db, [
      { ts: HOUR_0 - CYCLE_MS, ifIbytes: 100 * MB, ifObytes: 10 * MB },
      { ts: HOUR_0, ifIbytes: 110 * MB, ifObytes: 11 * MB },
      { ts: HOUR_0 + CYCLE_MS, ifIbytes: 120 * MB, ifObytes: 12 * MB },
    ])

    const [bucket] = bucketsIn(db, HOUR_0, HOUR_0 + BUCKET_MS)
    expect(bucket).toMatchObject({ inBytes: 20 * MB, intervals: 2, skipped: 0 })
  })

  test('splits across bucket boundaries by the interval end', () => {
    const db = createTestDb()
    seed(db, [
      { ts: HOUR_0 + BUCKET_MS - 2 * CYCLE_MS, ifIbytes: 95 * MB, ifObytes: 9 * MB },
      { ts: HOUR_0 + BUCKET_MS - CYCLE_MS, ifIbytes: 100 * MB, ifObytes: 10 * MB },
      { ts: HOUR_0 + BUCKET_MS, ifIbytes: 110 * MB, ifObytes: 11 * MB },
      { ts: HOUR_0 + BUCKET_MS + CYCLE_MS, ifIbytes: 130 * MB, ifObytes: 13 * MB },
    ])

    const buckets = bucketsIn(db, HOUR_0, HOUR_0 + 2 * BUCKET_MS)
    expect(buckets.map((b) => b.bucket)).toEqual([HOUR_0, HOUR_0 + BUCKET_MS])
    expect(buckets[0]).toMatchObject({ inBytes: 5 * MB, intervals: 1 })
    // The interval *ending* exactly on the boundary belongs to the later bucket.
    expect(buckets[1]).toMatchObject({ inBytes: 30 * MB, intervals: 2 })
  })

  /**
   * The window's left edge is not a defect. A row with no predecessor within the
   * lookback — the oldest cycle on record, or the first after a long gap — is the
   * absence of an interval, not a refused one, and counting it in `skipped` would
   * mark every window as incomplete forever.
   */
  test('the first cycle on record is not counted as a skipped interval', () => {
    const db = createTestDb()
    seed(db, steady(HOUR_0, 3, 10 * MB, 1 * MB))

    expect(bucketsIn(db, HOUR_0, HOUR_0 + BUCKET_MS)[0]).toMatchObject({ intervals: 2, skipped: 0 })
  })

  /** A quiet line is a real measurement and must survive as one: zero bytes over
   * a fully measured interval is not the same as a refused interval. */
  test('a genuinely idle interval is counted, with zero bytes and a real span', () => {
    const db = createTestDb()
    seed(db, steady(HOUR_0, 3, 0, 0))

    expect(bucketsIn(db, HOUR_0, HOUR_0 + BUCKET_MS)[0]).toMatchObject({
      inBytes: 0,
      outBytes: 0,
      spanMs: 2 * CYCLE_MS,
      intervals: 2,
      skipped: 0,
    })
  })
})

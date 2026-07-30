import { describe, expect, it } from 'bun:test'
import { createTestDb } from '../../db/test-db.js'
import { routerIntfSample, routerLineSample } from '../../db/schema.js'
import {
  bucketRouterLine,
  bucketRouterThroughput,
  DEFAULT_WINDOW_MS,
  isRangeError,
  MAX_BUCKETS,
  resolveRange,
} from './range.js'

const POLL_MS = 5 * 60 * 1000
const HOUR_S = 3600
const DAY_MS = 24 * 60 * 60 * 1000
/** Hour-aligned, so a bucket boundary lands where the arithmetic in these tests expects it. */
const START = 1_699_999_200_000

type Db = ReturnType<typeof createTestDb>

/** 30 days of 5-minute line polls: 8640 rows, the volume the old `LIMIT` truncated. */
function seedLine(db: Db, options: { start: number; count: number; showtimeResetAt?: number }) {
  for (let i = 0; i < options.count; i += 1) {
    const ts = options.start + i * POLL_MS
    const resetHere = options.showtimeResetAt !== undefined && i === options.showtimeResetAt
    db.insert(routerLineSample)
      .values({
        ts,
        carrier: 'gfast',
        status: 'Up',
        downSyncKbps: 803140,
        upSyncKbps: 225452,
        downCurrKbps: 804707,
        upCurrKbps: 226413,
        downNoiseMarginDb: 6.1,
        upNoiseMarginDb: 5.6,
        downAttenuationDb: 8.5,
        profile: '106a',
        // Seconds since showtime, climbing with each poll; a reset drops it back
        // to nearly zero, which is what a resync looks like in the record.
        showtimeStartS: resetHere ? 12 : 3589 + i * 300,
        erroredSecs: 0,
        severelyErroredSecs: 0,
      })
      .run()
  }
}

function seedIntf(
  db: Db,
  rows: Array<{ ts: number; name: string; role: 'wan' | 'lan'; rxKbps: number; txKbps: number; bytesRx: number; bytesTx: number }>,
) {
  for (const row of rows) {
    db.insert(routerIntfSample)
      .values({
        ts: row.ts,
        name: row.name,
        stack: row.role === 'wan' ? 4 : 1,
        role: row.role,
        rxKbps: row.rxKbps,
        txKbps: row.txKbps,
        bytesRx: row.bytesRx,
        bytesTx: row.bytesTx,
      })
      .run()
  }
}

describe('bucketRouterLine', () => {
  it('covers the whole range asked for — the truncation this replaced dropped 23 of 30 days', () => {
    const db = createTestDb()
    const count = 8640
    seedLine(db, { start: START, count })

    const to = START + (count - 1) * POLL_MS
    const buckets = bucketRouterLine(db, { from: START, to, bucketSeconds: HOUR_S })

    // Every seeded row is accounted for. The previous implementation selected
    // raw rows under a `LIMIT`, so a 30-day request answered with the newest
    // ~6.9 days and said nothing about the rest.
    const totalSamples = buckets.reduce((sum, bucket) => sum + bucket.samples, 0)
    expect(totalSamples).toBe(count)
    expect(buckets).toHaveLength(720)

    // Oldest bucket first, and it really is the oldest data — not a window that
    // silently starts three weeks late.
    expect(buckets[0]!.firstTs).toBe(START)
    expect(buckets.at(-1)!.lastTs).toBe(to)
    expect(buckets[0]!.samples).toBe(12)
  })

  it('keeps the worst reading beside the average, because the average is what hides a dip', () => {
    const db = createTestDb()
    seedLine(db, { start: START, count: 12 })
    // One poll inside the same hour where the line dropped to a lower profile.
    db.insert(routerLineSample)
      .values({
        ts: START + 12 * POLL_MS - 1,
        carrier: 'gfast',
        status: 'Down',
        downSyncKbps: 100_000,
        upSyncKbps: 30_000,
        downNoiseMarginDb: 2.1,
        upNoiseMarginDb: 2.0,
        profile: '106a',
        showtimeStartS: 30,
      })
      .run()

    const [bucket] = bucketRouterLine(db, { from: START, to: START + 12 * POLL_MS, bucketSeconds: HOUR_S })
    expect(bucket!.samples).toBe(13)
    expect(bucket!.downSyncKbpsMin).toBe(100_000)
    expect(bucket!.downSyncKbpsMax).toBe(803140)
    expect(bucket!.downNoiseMarginDbMin).toBe(2.1)
    // Both statuses, never flattened to the majority.
    expect(bucket!.statuses).toEqual(['Down', 'Up'])
    expect(bucket!.upSamples).toBe(12)
  })

  it('counts a resync where showtime went backwards, and never at the first row of the range', () => {
    const db = createTestDb()
    seedLine(db, { start: START, count: 24, showtimeResetAt: 15 })

    const buckets = bucketRouterLine(db, { from: START, to: START + 24 * POLL_MS, bucketSeconds: HOUR_S })
    const resyncs = buckets.reduce((sum, bucket) => sum + bucket.resyncs, 0)
    expect(resyncs).toBe(1)
    // Row 15 sits in the second hour (rows 12–23).
    expect(buckets[1]!.resyncs).toBe(1)
    expect(buckets[0]!.resyncs).toBe(0)
  })

  it('returns nothing rather than a fabricated zero row for a range with no polls', () => {
    const db = createTestDb()
    expect(bucketRouterLine(db, { from: 0, to: DAY_MS, bucketSeconds: HOUR_S })).toEqual([])
  })
})

describe('bucketRouterThroughput', () => {
  it('sums real traffic from consecutive counter deltas, per role', () => {
    const db = createTestDb()
    seedIntf(db, [
      { ts: START, name: 'ppp0', role: 'wan', rxKbps: 400, txKbps: 1800, bytesRx: 1_000_000, bytesTx: 2_000_000 },
      { ts: START, name: 'br0', role: 'lan', rxKbps: 1800, txKbps: 400, bytesRx: 5_000_000, bytesTx: 9_000_000 },
      { ts: START + POLL_MS, name: 'ppp0', role: 'wan', rxKbps: 800, txKbps: 100, bytesRx: 1_500_000, bytesTx: 2_100_000 },
      { ts: START + POLL_MS, name: 'br0', role: 'lan', rxKbps: 100, txKbps: 800, bytesRx: 5_100_000, bytesTx: 9_500_000 },
    ])

    const buckets = bucketRouterThroughput(db, { from: START, to: START + POLL_MS, bucketSeconds: HOUR_S })
    expect(buckets).toHaveLength(2)

    const wan = buckets.find((bucket) => bucket.role === 'wan')!
    expect(wan.names).toEqual(['ppp0'])
    expect(wan.samples).toBe(2)
    expect(wan.bytesRxDelta).toBe(500_000)
    expect(wan.bytesTxDelta).toBe(100_000)
    expect(wan.rxKbpsMax).toBe(800)
    expect(wan.rxKbpsAvg).toBe(600)

    const lan = buckets.find((bucket) => bucket.role === 'lan')!
    expect(lan.bytesRxDelta).toBe(100_000)
  })

  it('drops a backwards counter to zero instead of inventing traffic after a reboot', () => {
    const db = createTestDb()
    seedIntf(db, [
      { ts: START, name: 'ppp0', role: 'wan', rxKbps: 400, txKbps: 100, bytesRx: 9_000_000, bytesTx: 9_000_000 },
      // Router rebooted: counters restart near zero.
      { ts: START + POLL_MS, name: 'ppp0', role: 'wan', rxKbps: 400, txKbps: 100, bytesRx: 4_000, bytesTx: 1_000 },
      { ts: START + 2 * POLL_MS, name: 'ppp0', role: 'wan', rxKbps: 400, txKbps: 100, bytesRx: 60_000, bytesTx: 5_000 },
    ])

    const [bucket] = bucketRouterThroughput(db, { from: START, to: START + 2 * POLL_MS, bucketSeconds: HOUR_S })
    // The reset interval contributes 0, the interval after it contributes 56000.
    // Under-reporting one interval is honest; a negative or a 9 MB spike is not.
    expect(bucket!.bytesRxDelta).toBe(56_000)
    expect(bucket!.bytesTxDelta).toBe(4_000)
  })

  it('filters by role in SQL', () => {
    const db = createTestDb()
    seedIntf(db, [
      { ts: START, name: 'ppp0', role: 'wan', rxKbps: 1, txKbps: 1, bytesRx: 1, bytesTx: 1 },
      { ts: START, name: 'br0', role: 'lan', rxKbps: 2, txKbps: 2, bytesRx: 2, bytesTx: 2 },
    ])
    const buckets = bucketRouterThroughput(db, { from: START, to: START + 1, bucketSeconds: HOUR_S, role: 'wan' })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.role).toBe('wan')
  })

  it('covers a 30-day range without truncating', () => {
    const db = createTestDb()
    const count = 8640
    const rows = []
    for (let i = 0; i < count; i += 1) {
      rows.push({
        ts: START + i * POLL_MS,
        name: 'ppp0',
        role: 'wan' as const,
        rxKbps: 100,
        txKbps: 100,
        bytesRx: 1_000 * i,
        bytesTx: 500 * i,
      })
    }
    seedIntf(db, rows)

    const buckets = bucketRouterThroughput(db, { from: START, to: START + (count - 1) * POLL_MS, bucketSeconds: HOUR_S })
    expect(buckets.reduce((sum, bucket) => sum + bucket.samples, 0)).toBe(count)
    expect(buckets[0]!.firstTs).toBe(START)
  })
})

describe('resolveRange', () => {
  it('defaults to the last 24 hours', () => {
    const range = resolveRange({ bucketSeconds: HOUR_S, now: START })
    expect(isRangeError(range)).toBe(false)
    expect(range).toMatchObject({ from: START - DEFAULT_WINDOW_MS, to: START, bucketSeconds: HOUR_S })
  })

  it('refuses a range too fine for its bucket instead of answering a prefix of it', () => {
    // 365 days at 1-second buckets: ~31.5M buckets.
    const range = resolveRange({ from: START - 365 * DAY_MS, to: START, bucketSeconds: 1 })
    expect(isRangeError(range)).toBe(true)
    if (!isRangeError(range)) throw new Error('unreachable')
    expect(range.error).toBe('range_too_fine')
    expect(range.buckets).toBeGreaterThan(MAX_BUCKETS)
    expect(range.message).toContain('widen')
  })

  it('accepts a month of five-minute buckets — the honest ceiling is generous', () => {
    expect(isRangeError(resolveRange({ from: START - 30 * DAY_MS, to: START, bucketSeconds: 300 }))).toBe(false)
  })

  it('rejects a reversed range', () => {
    const range = resolveRange({ from: 2_000, to: 1_000, bucketSeconds: HOUR_S })
    expect(isRangeError(range)).toBe(true)
    if (!isRangeError(range)) throw new Error('unreachable')
    expect(range.error).toBe('invalid_range')
    expect(range.buckets).toBeNull()
  })
})

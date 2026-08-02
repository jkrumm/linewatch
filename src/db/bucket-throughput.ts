import { sql } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import type * as schema from './schema.js'

/**
 * How long a gap between two consecutive cycles may be before the bytes across
 * it stop being attributable to a moment in time.
 *
 * The counters are cumulative, so the difference between two cycles four hours
 * apart is a perfectly accurate *volume* — and a completely fictional *rate*,
 * and worse, a rate the bucket boundary would place entirely at the far end. A
 * collector restarted after a three-hour outage would draw a single spike of
 * three hours' traffic at the instant it came back.
 *
 * So an over-long interval is refused, and the bucket says so (`skipped`)
 * rather than quietly absorbing it. The window total then *understates* what
 * moved, which is the direction this codebase always errs in: a number that
 * admits it is missing something beats one that invents where it went.
 *
 * Four probe cycles (2 min). One or two missed cycles is a slow ping run or a
 * redeploy and the bytes across it are still fairly placed; beyond that it is a
 * gap, not a cadence.
 */
export const MAX_INTERVAL_MS = 4 * 30_000

/**
 * How far before `from` to reach for a predecessor row.
 *
 * Without it the first interval inside every window is lost — the first cycle
 * has nothing to difference against — so a 1 h window at 1-minute buckets would
 * open with an empty bucket that looks like an outage and is really an artifact
 * of where the reader put the window edge. One `MAX_INTERVAL_MS` is exactly
 * enough: any predecessor older than that would be refused anyway.
 */
const LOOKBACK_MS = MAX_INTERVAL_MS

export interface ThroughputBucket {
  /** Bucket-start timestamp, unix ms — same convention as `bucketProbes`. */
  bucket: number
  /** Bytes received/sent over the accepted intervals in this bucket. */
  inBytes: number
  outBytes: number
  /**
   * Milliseconds of measured time those bytes cover — the denominator for a
   * rate. **Not** the bucket's own length: a bucket with one accepted interval
   * out of twenty covers 30 s of a 10-minute slot, and dividing its bytes by the
   * slot would report a twentieth of the real rate.
   */
  spanMs: number
  /** Accepted intervals, and intervals refused for any of the three reasons below. */
  intervals: number
  skipped: number
}

interface ThroughputRow {
  bucket: number
  in_bytes: number
  out_bytes: number
  span_ms: number
  intervals: number
  skipped: number
}

export interface BucketThroughputParams {
  from: number
  to: number
  bucketSeconds: number
}

/**
 * Per-bucket byte volume, differenced from `probe_cycle`'s cumulative interface
 * counters.
 *
 * This is the only throughput history this host can produce without a second
 * always-on sampler: `netstat -I <if> -b` is already read every probe cycle for
 * its error counters, and `Ibytes`/`Obytes` sit in the same row. The resolution
 * is therefore the 30 s probe cycle — a smoothed rate, not the 1 Hz spikes a
 * menu-bar meter shows. That is the right trade for a *history*: nothing here is
 * trying to catch a burst, it is trying to answer "how much did this line move
 * last week, and when".
 *
 * **Three ways an interval is refused, and none of them is a zero.** All three
 * are counted in `skipped`, so a bucket can always say it is incomplete:
 *
 * 1. **The interface changed.** The counters are per interface, so a delta
 *    across an `en0 → en1` failover subtracts one NIC's lifetime from another's
 *    and is meaningless — usually hugely negative, occasionally plausible.
 * 2. **The counter went backwards.** That is a reboot (they reset to zero) or a
 *    fresh interface, never negative traffic.
 * 3. **The gap was too long** — see `MAX_INTERVAL_MS`.
 *
 * A refused interval contributes no bytes and no span, so the *rate* derived
 * from what is left stays honest and only the total is short. The alternative —
 * carrying the delta anyway — puts hours of traffic on one bucket, which is the
 * "absent measurement rendered as a present one" this project exists to refuse.
 *
 * Bucketed in SQL, like every other range route here: `probe_cycle` grows at the
 * same ~1M rows/year as the samples and no read path may return raw rows.
 */
export function bucketThroughput(
  db: BunSQLiteDatabase<typeof schema>,
  params: BucketThroughputParams,
): ThroughputBucket[] {
  const bucketMs = Math.max(1, Math.round(params.bucketSeconds * 1000))

  const rows = db.all<ThroughputRow>(sql`
    WITH windowed AS (
      SELECT
        ts,
        path_if,
        if_ibytes,
        if_obytes,
        LAG(ts) OVER (ORDER BY ts) AS prev_ts,
        LAG(path_if) OVER (ORDER BY ts) AS prev_if,
        LAG(if_ibytes) OVER (ORDER BY ts) AS prev_in,
        LAG(if_obytes) OVER (ORDER BY ts) AS prev_out
      FROM probe_cycle
      -- Reaches back past the window edge so the first interval inside it has a
      -- predecessor; the interval is still bucketed by its own end timestamp,
      -- and the ts filter below drops anything genuinely outside.
      WHERE ts >= ${params.from - LOOKBACK_MS} AND ts <= ${params.to}
    ),
    intervals AS (
      SELECT
        (ts / ${bucketMs}) * ${bucketMs} AS bucket,
        ts - prev_ts AS dt_ms,
        if_ibytes - prev_in AS d_in,
        if_obytes - prev_out AS d_out,
        CASE
          -- Both counters and both interfaces must be present and equal. A null
          -- on either side is a cycle that did not report, which is unknown —
          -- it is neither zero traffic nor a usable endpoint.
          WHEN path_if IS NULL OR prev_if IS NULL OR path_if <> prev_if THEN 0
          WHEN if_ibytes IS NULL OR prev_in IS NULL OR if_obytes IS NULL OR prev_out IS NULL THEN 0
          WHEN if_ibytes < prev_in OR if_obytes < prev_out THEN 0
          WHEN ts - prev_ts <= 0 OR ts - prev_ts > ${MAX_INTERVAL_MS} THEN 0
          ELSE 1
        END AS usable
      FROM windowed
      -- A row with no predecessor at all is not a refused interval, it is the
      -- absence of one — the oldest cycle in the record, or the first after a
      -- gap longer than the lookback. Counting it as skipped would report every
      -- window as incomplete at its left edge forever. A predecessor that exists
      -- but is too far back is a different fact and *is* counted, below.
      WHERE ts >= ${params.from} AND prev_ts IS NOT NULL
    )
    SELECT
      bucket,
      COALESCE(SUM(CASE WHEN usable = 1 THEN d_in END), 0) AS in_bytes,
      COALESCE(SUM(CASE WHEN usable = 1 THEN d_out END), 0) AS out_bytes,
      COALESCE(SUM(CASE WHEN usable = 1 THEN dt_ms END), 0) AS span_ms,
      SUM(usable) AS intervals,
      SUM(1 - usable) AS skipped
    FROM intervals
    GROUP BY bucket
    ORDER BY bucket
  `)

  return rows.map((row) => ({
    bucket: row.bucket,
    inBytes: row.in_bytes,
    outBytes: row.out_bytes,
    spanMs: row.span_ms,
    intervals: row.intervals,
    skipped: row.skipped,
  }))
}

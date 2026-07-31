import { sql, type SQL } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import type * as schema from '../../db/schema.js'

/**
 * Server-side bucketing for the two router range routes.
 *
 * The rule is the same one `GET /api/probes` follows and for the same reason:
 * these tables grow without bound (288 line rows and 576 interface rows a day,
 * ~315k rows a year between them), so a range route must aggregate in SQL and
 * return one row per bucket. The version this replaces selected raw rows under
 * a `LIMIT`, which meant a 30-day request silently answered with the newest
 * ~6.9 days and no indication that the rest existed — a truncation that reads
 * as "the line was fine before that" rather than as missing data.
 *
 * Nothing here caps the result behind the caller's back. A range too fine for
 * its bucket width is rejected by the route with the number it would have
 * produced, so the caller widens the bucket deliberately.
 */

export interface RouterBucketParams {
  from: number
  to: number
  /** Bucket width in seconds — grouping key is `floor(ts / (bucketSeconds*1000))`. */
  bucketSeconds: number
}

/** Default range when the caller gives neither `from` nor `to`. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * A hard ceiling on buckets per response, checked *before* the query runs. A
 * request finer than this is refused with the count it would have produced,
 * rather than answered with a silent prefix of it — the failure the raw-row
 * `LIMIT` this replaced produced every time someone asked for a month.
 */
export const MAX_BUCKETS = 20_000

export interface RangeError {
  error: 'invalid_range' | 'range_too_fine'
  message: string
  from: number
  to: number
  bucketSeconds: number
  /** How many buckets the request asked for, when that is what made it invalid. */
  buckets: number | null
  maxBuckets: number
}

/**
 * Turns a range query into `RouterBucketParams`, or into the reason it cannot be
 * one. Both failures are for the caller to see: clamping the range or widening
 * the bucket on its behalf answers a question that was not asked and looks
 * exactly like a complete answer.
 */
export function resolveRange(query: {
  from?: number | undefined
  to?: number | undefined
  bucketSeconds: number
  now?: number
}): RouterBucketParams | RangeError {
  const to = query.to ?? query.now ?? Date.now()
  const from = query.from ?? to - DEFAULT_WINDOW_MS
  const { bucketSeconds } = query

  if (from > to) {
    return {
      error: 'invalid_range',
      message: `from (${from}) is after to (${to})`,
      from,
      to,
      bucketSeconds,
      buckets: null,
      maxBuckets: MAX_BUCKETS,
    }
  }

  const buckets = Math.ceil((to - from) / (bucketSeconds * 1000))
  if (buckets > MAX_BUCKETS) {
    return {
      error: 'range_too_fine',
      message: `${buckets} buckets requested (max ${MAX_BUCKETS}) — widen \`bucket\` or shorten the range`,
      from,
      to,
      bucketSeconds,
      buckets,
      maxBuckets: MAX_BUCKETS,
    }
  }

  return { from, to, bucketSeconds }
}

export function isRangeError(value: RouterBucketParams | RangeError): value is RangeError {
  return 'error' in value
}

export interface RouterLineBucket {
  bucket: number
  samples: number
  firstTs: number
  lastTs: number
  /**
   * Distinct non-null `status` values in the bucket, sorted. More than one means
   * the line changed state inside it — never flattened to a majority.
   */
  statuses: string[]
  /** …of which this many read `Up` (`DEV2_FAST_LINE`, the one truthful status field). */
  upSamples: number
  carriers: string[]
  profiles: string[]
  /** Negotiated sync rate: `min` is the worst the line agreed to inside the bucket. */
  downSyncKbpsMin: number | null
  downSyncKbpsAvg: number | null
  downSyncKbpsMax: number | null
  upSyncKbpsMin: number | null
  upSyncKbpsAvg: number | null
  upSyncKbpsMax: number | null
  downCurrKbpsAvg: number | null
  upCurrKbpsAvg: number | null
  /** Noise margin in real dB. `min` is the early-warning number; the average hides it. */
  downNoiseMarginDbMin: number | null
  downNoiseMarginDbAvg: number | null
  upNoiseMarginDbMin: number | null
  upNoiseMarginDbAvg: number | null
  downAttenuationDbAvg: number | null
  /**
   * Polls whose `showtime_start_s` was lower than the previous poll's — i.e. the
   * line restarted inside this bucket. The first poll of the whole range has no
   * predecessor and can never count as a resync.
   */
  resyncs: number
  erroredSecsMax: number | null
  severelyErroredSecsMax: number | null
}

export interface RouterThroughputBucket {
  bucket: number
  role: 'wan' | 'lan' | 'other' | null
  samples: number
  firstTs: number
  lastTs: number
  /** Interface names seen under this role in the bucket, sorted. */
  names: string[]
  /**
   * Instantaneous rates as the router reports them: each sample is its own ~30s
   * average taken at poll time, so `avg` is the mean of one spot check per poll,
   * not the mean of the bucket. `bytesRxDelta` is the number that covers the
   * whole bucket.
   */
  rxKbpsAvg: number | null
  rxKbpsMax: number | null
  txKbpsAvg: number | null
  txKbpsMax: number | null
  /**
   * Bytes actually moved inside the bucket, summed from consecutive counter
   * deltas per interface. A counter that went *backwards* (router reboot)
   * contributes 0 rather than a negative or an absurd positive, so a reboot
   * under-reports that one interval instead of poisoning the series. The first
   * poll of the range has no predecessor and contributes 0 for the same reason.
   */
  bytesRxDelta: number
  bytesTxDelta: number
}

interface LineRow {
  bucket: number
  samples: number
  first_ts: number
  last_ts: number
  statuses: string | null
  up_samples: number
  carriers: string | null
  profiles: string | null
  down_sync_min: number | null
  down_sync_avg: number | null
  down_sync_max: number | null
  up_sync_min: number | null
  up_sync_avg: number | null
  up_sync_max: number | null
  down_curr_avg: number | null
  up_curr_avg: number | null
  down_margin_min: number | null
  down_margin_avg: number | null
  up_margin_min: number | null
  up_margin_avg: number | null
  down_atten_avg: number | null
  resyncs: number
  errored_secs_max: number | null
  severely_errored_secs_max: number | null
}

interface ThroughputRow {
  bucket: number
  role: string | null
  samples: number
  first_ts: number
  last_ts: number
  names: string | null
  rx_avg: number | null
  rx_max: number | null
  tx_avg: number | null
  tx_max: number | null
  bytes_rx_delta: number
  bytes_tx_delta: number
}

/** Splits a `group_concat(DISTINCT …)` result. Empty/absent means every value was NULL. */
function splitDistinct(value: string | null): string[] {
  if (!value) return []
  return value
    .split(',')
    .filter((part) => part.length > 0)
    .sort()
}

/** Averages of integer kbps columns are reported as integers: a tenth of a kbps is noise. */
function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value)
}

/** dB is reported to one decimal — the resolution the router itself has (tenths). */
function tenthOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10
}

function bucketMsOf(bucketSeconds: number): number {
  return Math.max(1, Math.round(bucketSeconds * 1000))
}

function isRole(value: string | null): value is 'wan' | 'lan' | 'other' {
  return value === 'wan' || value === 'lan' || value === 'other'
}

/**
 * Carrier line history, one row per bucket. Sync rate and noise margin keep a
 * `min` alongside the average because the average is what hides a single poll's
 * drop to a lower profile, and that drop is the whole reason the column exists.
 */
export function bucketRouterLine(db: BunSQLiteDatabase<typeof schema>, params: RouterBucketParams): RouterLineBucket[] {
  const bucketMs = bucketMsOf(params.bucketSeconds)

  const rows = db.all<LineRow>(sql`
    WITH filtered AS (
      SELECT
        (ts / ${bucketMs}) * ${bucketMs} AS bucket,
        ts,
        status,
        carrier,
        profile,
        down_sync_kbps,
        up_sync_kbps,
        down_curr_kbps,
        up_curr_kbps,
        down_noise_margin_db,
        up_noise_margin_db,
        down_attenuation_db,
        showtime_start_s,
        errored_secs,
        severely_errored_secs,
        LAG(showtime_start_s) OVER (ORDER BY ts) AS prev_showtime
      FROM router_line_sample
      WHERE ts >= ${params.from} AND ts <= ${params.to}
    )
    SELECT
      bucket,
      COUNT(*) AS samples,
      MIN(ts) AS first_ts,
      MAX(ts) AS last_ts,
      group_concat(DISTINCT status) AS statuses,
      SUM(CASE WHEN status = 'Up' THEN 1 ELSE 0 END) AS up_samples,
      group_concat(DISTINCT carrier) AS carriers,
      group_concat(DISTINCT profile) AS profiles,
      MIN(down_sync_kbps) AS down_sync_min,
      AVG(down_sync_kbps) AS down_sync_avg,
      MAX(down_sync_kbps) AS down_sync_max,
      MIN(up_sync_kbps) AS up_sync_min,
      AVG(up_sync_kbps) AS up_sync_avg,
      MAX(up_sync_kbps) AS up_sync_max,
      AVG(down_curr_kbps) AS down_curr_avg,
      AVG(up_curr_kbps) AS up_curr_avg,
      MIN(down_noise_margin_db) AS down_margin_min,
      AVG(down_noise_margin_db) AS down_margin_avg,
      MIN(up_noise_margin_db) AS up_margin_min,
      AVG(up_noise_margin_db) AS up_margin_avg,
      AVG(down_attenuation_db) AS down_atten_avg,
      SUM(
        CASE
          WHEN prev_showtime IS NOT NULL AND showtime_start_s IS NOT NULL AND showtime_start_s < prev_showtime
          THEN 1 ELSE 0
        END
      ) AS resyncs,
      MAX(errored_secs) AS errored_secs_max,
      MAX(severely_errored_secs) AS severely_errored_secs_max
    FROM filtered
    GROUP BY bucket
    ORDER BY bucket
  `)

  return rows.map((row) => ({
    bucket: row.bucket,
    samples: row.samples,
    firstTs: row.first_ts,
    lastTs: row.last_ts,
    statuses: splitDistinct(row.statuses),
    upSamples: row.up_samples,
    carriers: splitDistinct(row.carriers),
    profiles: splitDistinct(row.profiles),
    downSyncKbpsMin: row.down_sync_min,
    downSyncKbpsAvg: roundOrNull(row.down_sync_avg),
    downSyncKbpsMax: row.down_sync_max,
    upSyncKbpsMin: row.up_sync_min,
    upSyncKbpsAvg: roundOrNull(row.up_sync_avg),
    upSyncKbpsMax: row.up_sync_max,
    downCurrKbpsAvg: roundOrNull(row.down_curr_avg),
    upCurrKbpsAvg: roundOrNull(row.up_curr_avg),
    downNoiseMarginDbMin: tenthOrNull(row.down_margin_min),
    downNoiseMarginDbAvg: tenthOrNull(row.down_margin_avg),
    upNoiseMarginDbMin: tenthOrNull(row.up_margin_min),
    upNoiseMarginDbAvg: tenthOrNull(row.up_margin_avg),
    downAttenuationDbAvg: tenthOrNull(row.down_atten_avg),
    resyncs: row.resyncs,
    erroredSecsMax: row.errored_secs_max,
    severelyErroredSecsMax: row.severely_errored_secs_max,
  }))
}

/**
 * Per-interface throughput history, one row per bucket per role. Grouped by
 * `role` rather than by `name` because the role is the stable identity — a
 * PPPoE session that comes back as `ppp1` is still the WAN — while the names
 * that made up the group are reported alongside so a rename stays visible.
 */
export function bucketRouterThroughput(
  db: BunSQLiteDatabase<typeof schema>,
  params: RouterBucketParams & { role?: 'wan' | 'lan' | 'other' },
): RouterThroughputBucket[] {
  const bucketMs = bucketMsOf(params.bucketSeconds)
  const roleFilter: SQL = params.role === undefined ? sql`` : sql`AND role = ${params.role}`

  const rows = db.all<ThroughputRow>(sql`
    WITH filtered AS (
      SELECT
        (ts / ${bucketMs}) * ${bucketMs} AS bucket,
        ts,
        name,
        role,
        rx_kbps,
        tx_kbps,
        bytes_rx,
        bytes_tx,
        -- Per interface: the counters belong to the device, so a delta taken
        -- across two different interfaces would be meaningless.
        LAG(bytes_rx) OVER (PARTITION BY name ORDER BY ts) AS prev_bytes_rx,
        LAG(bytes_tx) OVER (PARTITION BY name ORDER BY ts) AS prev_bytes_tx
      FROM router_intf_sample
      WHERE ts >= ${params.from} AND ts <= ${params.to} ${roleFilter}
    )
    SELECT
      bucket,
      role,
      COUNT(*) AS samples,
      MIN(ts) AS first_ts,
      MAX(ts) AS last_ts,
      group_concat(DISTINCT name) AS names,
      AVG(rx_kbps) AS rx_avg,
      MAX(rx_kbps) AS rx_max,
      AVG(tx_kbps) AS tx_avg,
      MAX(tx_kbps) AS tx_max,
      SUM(CASE WHEN prev_bytes_rx IS NOT NULL AND bytes_rx >= prev_bytes_rx THEN bytes_rx - prev_bytes_rx ELSE 0 END) AS bytes_rx_delta,
      SUM(CASE WHEN prev_bytes_tx IS NOT NULL AND bytes_tx >= prev_bytes_tx THEN bytes_tx - prev_bytes_tx ELSE 0 END) AS bytes_tx_delta
    FROM filtered
    GROUP BY bucket, role
    ORDER BY bucket, role
  `)

  return rows.map((row) => ({
    bucket: row.bucket,
    role: isRole(row.role) ? row.role : null,
    samples: row.samples,
    firstTs: row.first_ts,
    lastTs: row.last_ts,
    names: splitDistinct(row.names),
    rxKbpsAvg: roundOrNull(row.rx_avg),
    rxKbpsMax: row.rx_max,
    txKbpsAvg: roundOrNull(row.tx_avg),
    txKbpsMax: row.tx_max,
    bytesRxDelta: row.bytes_rx_delta,
    bytesTxDelta: row.bytes_tx_delta,
  }))
}

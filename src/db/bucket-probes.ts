import { sql } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import type * as schema from './schema.js'

export interface ProbeBucket {
  bucket: number
  target: string
  /** Median of the per-cycle medians — the SmokePing centre line. */
  medianMs: number | null
  /** p5/p95 *of the per-cycle medians*: how the typical RTT drifted between cycles. */
  p5Ms: number | null
  p95Ms: number | null
  /** True smoke-band floor/ceiling: the extremes of the actual round trips. */
  minMs: number | null
  maxMs: number | null
  /** The worst single cycle in the bucket — a spike detector, not availability. */
  maxLossPct: number
  /** Sent-weighted aggregate loss over the whole bucket: `100 - lossPct` is availability. */
  lossPct: number
  /** Cycles where nothing came back at all — separates one bad cycle from a dead line. */
  downCycles: number
  count: number
}

export interface BucketProbesParams {
  from: number
  to: number
  target?: string
  /** Bucket width in seconds — grouping key is `floor(ts / (bucketSeconds*1000))`. */
  bucketSeconds: number
}

/**
 * `all`     — every cycle recorded in the bucket reported `on_home_line = 1`.
 * `none`    — every cycle reported 0: this bucket did not measure the home line.
 * `unknown` — no cycle reported it at all (a collector predating the vantage).
 * `mixed`   — anything else, including 1s alongside unreported cycles. Never a
 *   lie: only `all` claims the whole bucket, so a UI that paints `all` green and
 *   anything else hatched cannot accidentally present a failover as the home line.
 */
export type HomeLineVerdict = 'all' | 'none' | 'mixed' | 'unknown'

export interface VantageBucket {
  bucket: number
  /** Distinct cycle timestamps that produced probe samples in this bucket. */
  cycles: number
  /** …of which this many recorded a vantage at all. */
  vantageCycles: number
  /** Distinct non-null `path_class` values seen, sorted. More than one = the path changed mid-bucket. */
  pathClasses: string[]
  /** Distinct non-null `link_mbit` values seen, ascending. More than one = the NIC renegotiated. */
  linkMbits: number[]
  /** Distinct non-null `path_if` values seen, sorted. */
  pathIfs: string[]
  onHomeLine: HomeLineVerdict
  homeLineCycles: number
  offHomeLineCycles: number
  /** Cycles in the bucket with no `on_home_line` value — unknown, not "fine". */
  unknownHomeLineCycles: number
}

interface BucketRow {
  bucket: number
  target: string
  median_ms: number | null
  p5_ms: number | null
  p95_ms: number | null
  min_ms: number | null
  max_ms: number | null
  max_loss_pct: number
  agg_loss_pct: number
  down_cycles: number
  count: number
}

/**
 * Server-side bucketing for `GET /api/probes` (docs/DESIGN.md API table): one
 * row per bucket×target — never raw probe_sample rows. SQLite has no
 * MEDIAN/PERCENTILE_CONT aggregate, so the median-of-medians and p5/p95 band
 * are computed with the standard SQL window-function trick (ROW_NUMBER +
 * COUNT over each bucket, then pick the rank(s) that land on the target
 * percentile) — one pass over the matching rows, one row out per bucket.
 *
 * Two loss numbers come back on purpose. `max_loss_pct` is the worst single
 * cycle; using it as availability makes one 5%-loss cycle in a 300-cycle hour
 * read as "95% available" and one 75%-loss cycle read as "25%". `agg_loss_pct`
 * is the sent-weighted aggregate — the honest headline. Likewise MIN(min_ms)/
 * MAX(max_ms) give the real spread of round trips; p5/p95 over `med_ms` only
 * ever describe how the *median* moved (docs/DESIGN.md, "stored as median +
 * spread + loss fraction, so a graph shows jitter as a band").
 */
export function bucketProbes(db: BunSQLiteDatabase<typeof schema>, params: BucketProbesParams): ProbeBucket[] {
  const bucketMs = Math.max(1, Math.round(params.bucketSeconds * 1000))
  const targetFilter = params.target ? sql`AND target = ${params.target}` : sql``

  const rows = db.all<BucketRow>(sql`
    WITH filtered AS (
      SELECT
        (ts / ${bucketMs}) * ${bucketMs} AS bucket,
        target,
        med_ms,
        min_ms,
        max_ms,
        sent,
        received,
        loss_pct
      FROM probe_sample
      WHERE ts >= ${params.from} AND ts <= ${params.to} ${targetFilter}
    ),
    agg AS (
      SELECT
        bucket,
        target,
        MAX(loss_pct) AS max_loss_pct,
        -- SUM(sent) = 0 can only happen if every cycle recorded zero packets;
        -- that is "no evidence", which reads as 0% loss, not NULL/NaN.
        CASE WHEN SUM(sent) > 0 THEN 100.0 * SUM(sent - received) / SUM(sent) ELSE 0.0 END AS agg_loss_pct,
        SUM(CASE WHEN received = 0 THEN 1 ELSE 0 END) AS down_cycles,
        MIN(min_ms) AS min_ms,
        MAX(max_ms) AS max_ms,
        COUNT(*) AS count
      FROM filtered
      GROUP BY bucket, target
    ),
    ranked AS (
      SELECT
        bucket,
        target,
        med_ms,
        ROW_NUMBER() OVER (PARTITION BY bucket, target ORDER BY med_ms) AS rn,
        COUNT(*) OVER (PARTITION BY bucket, target) AS n
      FROM filtered
      WHERE med_ms IS NOT NULL
    ),
    pct AS (
      SELECT
        bucket,
        target,
        AVG(med_ms) FILTER (WHERE rn IN ((n + 1) / 2, (n + 2) / 2)) AS median_ms,
        AVG(med_ms) FILTER (WHERE rn = MAX(1, CAST(ROUND(0.05 * n) AS INTEGER))) AS p5_ms,
        AVG(med_ms) FILTER (WHERE rn = MAX(1, CAST(ROUND(0.95 * n) AS INTEGER))) AS p95_ms
      FROM ranked
      GROUP BY bucket, target
    )
    SELECT
      agg.bucket AS bucket,
      agg.target AS target,
      agg.max_loss_pct AS max_loss_pct,
      agg.agg_loss_pct AS agg_loss_pct,
      agg.down_cycles AS down_cycles,
      agg.min_ms AS min_ms,
      agg.max_ms AS max_ms,
      agg.count AS count,
      pct.median_ms AS median_ms,
      pct.p5_ms AS p5_ms,
      pct.p95_ms AS p95_ms
    FROM agg
    LEFT JOIN pct ON pct.bucket = agg.bucket AND pct.target = agg.target
    ORDER BY agg.bucket, agg.target
  `)

  return rows.map((row) => ({
    bucket: row.bucket,
    target: row.target,
    medianMs: row.median_ms,
    p5Ms: row.p5_ms,
    p95Ms: row.p95_ms,
    minMs: row.min_ms,
    maxMs: row.max_ms,
    maxLossPct: row.max_loss_pct,
    lossPct: row.agg_loss_pct,
    downCycles: row.down_cycles,
    count: row.count,
  }))
}

interface VantageRow {
  bucket: number
  cycles: number
  vantage_cycles: number
  path_classes: string | null
  link_mbits: string | null
  path_ifs: string | null
  home_cycles: number
  off_cycles: number
}

/** Splits a `group_concat(DISTINCT …)` result. Empty/absent means every value was NULL. */
function splitDistinct(value: string | null): string[] {
  if (!value) return []
  return value
    .split(',')
    .filter((part) => part.length > 0)
    .sort()
}

/**
 * Collapse the per-window counts into one verdict. `all` is the only value that
 * claims the whole window, and it requires every recorded cycle — not every
 * *reporting* cycle — to have said 1, so unreported cycles can never be
 * rounded up into "this was the home line".
 */
export function homeLineVerdict(cycles: number, home: number, off: number): HomeLineVerdict {
  if (home === 0 && off === 0) return 'unknown'
  if (home === cycles) return 'all'
  if (off === cycles) return 'none'
  return 'mixed'
}

/**
 * The vantage side of `GET /api/probes`: what each bucket was measured
 * *through*. Returned as its own per-bucket series rather than folded into
 * `bucketProbes`, because the vantage is a property of the cycle and would
 * otherwise be repeated once per target (and a join on `ts` would multiply
 * every aggregate by the target count).
 *
 * Bucketed in SQL like everything else here — one row out per bucket, never raw
 * rows. `probe_sample` drives the cycle count, not `probe_cycle`, so a bucket
 * whose cycles predate the vantage is reported as `cycles > 0,
 * unknownHomeLineCycles = cycles` rather than silently disappearing.
 */
export function bucketVantage(db: BunSQLiteDatabase<typeof schema>, params: BucketProbesParams): VantageBucket[] {
  const bucketMs = Math.max(1, Math.round(params.bucketSeconds * 1000))

  const rows = db.all<VantageRow>(sql`
    WITH cycles AS (
      SELECT (ts / ${bucketMs}) * ${bucketMs} AS bucket, COUNT(DISTINCT ts) AS cycles
      FROM probe_sample
      WHERE ts >= ${params.from} AND ts <= ${params.to}
      GROUP BY bucket
    ),
    vantage AS (
      SELECT
        (ts / ${bucketMs}) * ${bucketMs} AS bucket,
        COUNT(*) AS vantage_cycles,
        -- group_concat(DISTINCT x) skips NULLs, which is exactly right: an
        -- unreported class is not a class the cycle was ever on.
        group_concat(DISTINCT path_class) AS path_classes,
        group_concat(DISTINCT link_mbit) AS link_mbits,
        group_concat(DISTINCT path_if) AS path_ifs,
        SUM(CASE WHEN on_home_line = 1 THEN 1 ELSE 0 END) AS home_cycles,
        SUM(CASE WHEN on_home_line = 0 THEN 1 ELSE 0 END) AS off_cycles
      FROM probe_cycle
      WHERE ts >= ${params.from} AND ts <= ${params.to}
      GROUP BY bucket
    )
    SELECT
      cycles.bucket AS bucket,
      cycles.cycles AS cycles,
      COALESCE(vantage.vantage_cycles, 0) AS vantage_cycles,
      vantage.path_classes AS path_classes,
      vantage.link_mbits AS link_mbits,
      vantage.path_ifs AS path_ifs,
      COALESCE(vantage.home_cycles, 0) AS home_cycles,
      COALESCE(vantage.off_cycles, 0) AS off_cycles
    FROM cycles
    LEFT JOIN vantage ON vantage.bucket = cycles.bucket
    ORDER BY cycles.bucket
  `)

  return rows.map((row) => ({
    bucket: row.bucket,
    cycles: row.cycles,
    vantageCycles: row.vantage_cycles,
    pathClasses: splitDistinct(row.path_classes),
    linkMbits: splitDistinct(row.link_mbits)
      .map(Number)
      .sort((a, b) => a - b),
    pathIfs: splitDistinct(row.path_ifs),
    onHomeLine: homeLineVerdict(row.cycles, row.home_cycles, row.off_cycles),
    homeLineCycles: row.home_cycles,
    offHomeLineCycles: row.off_cycles,
    unknownHomeLineCycles: row.cycles - row.home_cycles - row.off_cycles,
  }))
}

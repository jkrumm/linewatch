import { sql } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import type * as schema from './schema.js'

export interface ProbeBucket {
  bucket: number
  target: string
  medianMs: number | null
  p5Ms: number | null
  p95Ms: number | null
  maxLossPct: number
  count: number
}

export interface BucketProbesParams {
  from: number
  to: number
  target?: string
  /** Bucket width in seconds — grouping key is `floor(ts / (bucketSeconds*1000))`. */
  bucketSeconds: number
}

interface BucketRow {
  bucket: number
  target: string
  median_ms: number | null
  p5_ms: number | null
  p95_ms: number | null
  max_loss_pct: number
  count: number
}

/**
 * Server-side bucketing for `GET /api/probes` (docs/DESIGN.md API table): one
 * row per bucket×target — never raw probe_sample rows. SQLite has no
 * MEDIAN/PERCENTILE_CONT aggregate, so the median-of-medians and p5/p95 band
 * are computed with the standard SQL window-function trick (ROW_NUMBER +
 * COUNT over each bucket, then pick the rank(s) that land on the target
 * percentile) — one pass over the matching rows, one row out per bucket.
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
        loss_pct
      FROM probe_sample
      WHERE ts >= ${params.from} AND ts <= ${params.to} ${targetFilter}
    ),
    agg AS (
      SELECT bucket, target, MAX(loss_pct) AS max_loss_pct, COUNT(*) AS count
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
    maxLossPct: row.max_loss_pct,
    count: row.count,
  }))
}

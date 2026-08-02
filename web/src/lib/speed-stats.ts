import type { SpeedTest } from './types'

/**
 * A percentile of a sample, by linear interpolation between order statistics (the R-7 / Excel
 * `PERCENTILE.INC` definition), and `null` for an empty sample.
 *
 * Interpolating rather than nearest-rank because these samples are small — a 24 h window holds a
 * couple of dozen speed-test runs — and nearest-rank on a sample of 20 moves p95 in visible steps
 * as runs arrive, which reads as the line changing when only the arithmetic did.
 *
 * `null` for an empty sample, never 0. A window with no successful run measured no throughput, and
 * a zero would be a measurement of a very slow line.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]!
  const rank = (sorted.length - 1) * p
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower)
}

/** What the Speed section reports over the selected range. */
export interface SpeedWindowStats {
  download: { p50: number | null; p95: number | null }
  upload: { p50: number | null; p95: number | null }
  /** Successful runs the percentiles were taken over. */
  runs: number
  /** Runs that failed outright — no throughput to include, but not nothing to report. */
  failed: number
}

/**
 * The Speed section's percentiles, computed over the runs inside the page's own range.
 *
 * Replaces `GET /api/speedtests/summary`, and the reason is the range control. That route takes
 * **whole days** anchored to the server's own clock, so the 1 h range asked it for a day and the
 * 7 d range asked it for seven — four cards on a page whose every other number obeyed the
 * selector, silently answering for a different window and labelled with a `· 7d` suffix that
 * admitted it. A range selector that scopes most of a page is worse than one that scopes none of
 * it, because the reader has to remember which blocks are exceptions.
 *
 * `lib/kpi.ts`'s `windowDownloadMedian` made this same argument first, for the same route, and
 * this is the rest of it. `p50` here and that function's median are the same statistic over the
 * same rows; the KPI card and this section can no longer disagree.
 *
 * Failed runs are excluded from the percentiles and counted separately. A run that errored carries
 * no throughput — including it as 0 would report a line that ran slowly rather than a test that
 * did not complete — but a window where half the runs failed is not the same window as one where
 * none did, and the count is the only place that fact survives.
 */
export function speedWindowStats(tests: readonly SpeedTest[]): SpeedWindowStats {
  const ok = tests.filter((t) => t.ok)
  const down = ok.map((t) => t.downloadMbps).filter((v): v is number => v !== null)
  const up = ok.map((t) => t.uploadMbps).filter((v): v is number => v !== null)

  return {
    download: { p50: percentile(down, 0.5), p95: percentile(down, 0.95) },
    upload: { p50: percentile(up, 0.5), p95: percentile(up, 0.95) },
    runs: ok.length,
    failed: tests.length - ok.length,
  }
}

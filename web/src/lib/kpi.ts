import { median } from './aggregate'
import type { LatencyComparePoint } from './aggregate'
import type { WindowDowntime } from './downtime'

/**
 * A sparkline's data, or `null` when the window has a hole in it.
 *
 * `LineSparkline`/`BarSparkline` take `number[]` — they have no null state and no axis. So a
 * missing bucket can only be dropped or zero-filled, and both are wrong in the specific way this
 * codebase exists to avoid: dropping one silently compresses the x-axis so the trend spans a
 * different stretch of time than the card claims, and zero-filling a loss or down-cycle series
 * paints an unmeasured window as a clean one.
 *
 * So a series with any hole gets no sparkline at all. The number above it is still true — it is an
 * aggregate over the measured part — but the *shape* is withheld, because a shape cannot carry the
 * caveat that the number's own coverage verdict does. With a healthy collector there are no holes
 * and every card draws one; when there are, the verdict band says why in words.
 */
export function denseSparkline(values: readonly (number | null)[]): number[] | null {
  if (values.length === 0) return null
  const dense: number[] = []
  for (const value of values) {
    if (value === null) return null
    dense.push(value)
  }
  return dense
}

/** The window's headline latency: the median of the per-bucket WAN medians that exist. */
export function windowWanMedian(points: readonly LatencyComparePoint[]): number | null {
  return median(points.map((p) => p.wanMs)).value
}

/**
 * The worst aggregate loss any single bucket saw, and `null` when no bucket was measured.
 *
 * A maximum rather than a window-wide loss rate, because a window-wide rate cannot be computed
 * exactly from what the range route returns: `lossPct` is already an aggregate per bucket, and
 * combining buckets correctly needs each one's packet count, which is not in the response.
 * Weighting by cycle count instead would be exact only if every cycle sent the same number of
 * packets — true today, but an assumption this module has no way to check and no business baking
 * in. The maximum needs no such assumption and answers a question the reader actually has: how bad
 * did it get.
 *
 * `null` and `0` are different answers and are kept apart: nothing measured, versus measured and
 * clean.
 */
export function worstBucketLoss(points: readonly LatencyComparePoint[]): number | null {
  const measured = points.filter((p) => p.gatewayMs !== null || p.wanAnchors > 0)
  if (measured.length === 0) return null
  return measured.reduce((worst, p) => Math.max(worst, p.worstLossPct), 0)
}

/**
 * A per-bucket duration as a **noun phrase** — "5 minutes", not "5-min" — matching `RANGE_BUCKET`
 * in `lib/range.ts`, one entry per bucket size that route currently produces.
 *
 * `worstBucketLoss` is a max over buckets, and a bucket's duration changes with the selected range
 * (`rangeToBucket`), so the worst names a different-sized stretch per range: a 24h window's
 * 5-minute worst can be smaller than a 30-day window's 4-hour worst, and both are true. Unlabelled,
 * that reads as a bug. Labelled with its own duration, it reads as what it is — two different
 * measurements of two different-length stretches.
 *
 * Noun phrase rather than the adjectival form this used to return, because the word "bucket" is
 * gone from the card that reads it. "Worst 5-min bucket loss" made the reader decode the SQL
 * aggregation before they could learn that five minutes of pings went missing; "Worst 5 minutes"
 * over a value of "100.0% lost" says the same thing to someone who has never heard of a bucket.
 * Plurals are baked into the table rather than derived, so "1 hour" and "4 hours" both read right.
 *
 * Falls back to the raw second count for a size this table doesn't carry, rather than rounding to
 * the nearest known label and silently naming a duration that was never measured.
 */
const BUCKET_LABELS: Record<number, string> = {
  60: '1 minute',
  300: '5 minutes',
  3_600: '1 hour',
  14_400: '4 hours',
  86_400: '1 day',
}

export function bucketLabel(seconds: number): string {
  return BUCKET_LABELS[seconds] ?? `${seconds}s`
}

/** The median download of the successful runs in a window, and `null` when there were none.
 *
 * Computed here rather than read from `GET /api/speedtests/summary`, whose `days` parameter is
 * anchored to the server's own `now` and only takes whole days — so on the 1 h range it answered
 * for a day while every other card answered for an hour, and it could not answer for the preceding
 * window at all. The rows are already fetched for the chart, the median is the same statistic the
 * server's `p50` is, and computing both sides of the comparison the same way is the only way the
 * comparison means anything. Failed runs carry no throughput and are skipped, never counted as 0.
 */
export function windowDownloadMedian(tests: readonly { downloadMbps: number | null }[]): number | null {
  return median(tests.map((t) => t.downloadMbps)).value
}

/**
 * The fraction of a window's buckets that measured anything at all, 0–1.
 *
 * The gate on every comparison below. A window is only comparable with its predecessor if both
 * were actually watched: a preceding 24 h in which the collector was down for 20 of them reports
 * near-zero downtime, and a delta drawn against it announces that today got dramatically worse
 * when what actually happened is that yesterday went unmeasured. That is this project's central
 * failure mode wearing a green badge.
 */
export function measuredFraction(points: readonly LatencyComparePoint[]): number {
  if (points.length === 0) return 0
  const measured = points.filter((p) => p.gatewayMs !== null || p.wanAnchors > 0).length
  return measured / points.length
}

/**
 * How much of both windows must be measured before a delta between them is shown.
 *
 * 90%, not 100%: a single missed cycle at a bucket boundary is routine and suppressing every
 * comparison over it would mean never showing one. Below this the figures are still exact over
 * what was measured — they are just not measuring comparable amounts of time, so the *difference*
 * between them is not a fact about the line.
 */
export const COMPARABLE_COVERAGE = 0.9

/** A window-over-window change, ready to hand to `StatCard`'s delta slot. */
export interface Comparison {
  /**
   * The change signed by **goodness**, not by arithmetic — `DeltaBadge` paints a positive value
   * green with a ▲ and a negative one red with a ▼, which is right for throughput and exactly
   * backwards for downtime, loss and latency. So the tone carries the judgment and `label` carries
   * the true arithmetic sign; the two only agree on `up-is-good` metrics.
   */
  tone: number
  /** The real change with its real sign and unit — `+8 min`, `−1.2 ms`. */
  label: string
}

/** Whether more of a thing is better. There is no third option and no default: a metric whose
 * direction the caller has not thought about must not get a coloured badge. */
export type MetricDirection = 'up-is-good' | 'up-is-bad'

/**
 * A comparison between this window and the one before it, or `null` when there isn't one to make.
 *
 * `null` — rendered as no badge at all — for every case where a number would mislead: either side
 * absent (nothing measured, or no speed test ran), or either side's coverage under
 * `COMPARABLE_COVERAGE`. Never 0, which reads as "unchanged" and is a claim.
 *
 * The glyph is suppressed by the caller (`withGlyph={false}`) because `DeltaBadge` derives ▲/▼ from
 * `tone`, and on an `up-is-bad` metric that would point down while the label reads `+8 min`.
 */
export function compareWindows(opts: {
  current: number | null
  previous: number | null
  direction: MetricDirection
  /** Formats a magnitude — always non-negative; the sign is prefixed here. */
  format: (magnitude: number) => string
  currentCoverage: number
  previousCoverage: number
}): Comparison | null {
  const { current, previous, direction, format, currentCoverage, previousCoverage } = opts
  if (current === null || previous === null) return null
  if (currentCoverage < COMPARABLE_COVERAGE || previousCoverage < COMPARABLE_COVERAGE) return null

  const change = current - previous
  if (change === 0) return { tone: 0, label: 'no change' }

  const sign = change > 0 ? '+' : '−'
  return {
    tone: direction === 'up-is-good' ? change : -change,
    label: `${sign}${format(Math.abs(change))}`,
  }
}

/** The two tints a KPI card can carry — anything else stays the neutral default weight. */
export type ThresholdTint = 'bad' | 'warn' | undefined

/**
 * Packet-loss severity bands for the worst-bucket-loss card's tint. This repo has no measured
 * figure of its own for "how much loss matters", so these are conservative, commonly-cited
 * connectivity thresholds rather than a value pulled from this line's history:
 *  - above 1%, interactive traffic (voice, video call audio, real-time gaming) starts audibly
 *    degrading — the usual cited "noticeable" threshold.
 *  - above 5%, most interactive use becomes unusable — a "severe" threshold.
 * A `null` reading (nothing measured) is never tinted: absence is not a good reading or a bad one.
 */
export const WORST_LOSS_WARN_PCT = 1
export const WORST_LOSS_BAD_PCT = 5

export function worstLossTint(worstLossPct: number | null): ThresholdTint {
  if (worstLossPct === null) return undefined
  if (worstLossPct > WORST_LOSS_BAD_PCT) return 'bad'
  if (worstLossPct > WORST_LOSS_WARN_PCT) return 'warn'
  return undefined
}

/**
 * Tint for the downtime card. Any downtime at all is a bad reading for this KPI — the value
 * already renders in minutes, so a further "how many minutes counts" threshold on top would hide a
 * real outage behind a number small enough to look calm. An outage that is still open tints bad
 * even if it has accrued under a second: "still open" is itself the bad fact, not the seconds so
 * far.
 */
export function downtimeTint(downtime: WindowDowntime): ThresholdTint {
  return downtime.seconds > 0 || downtime.openCount > 0 ? 'bad' : undefined
}

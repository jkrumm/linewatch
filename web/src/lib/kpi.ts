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

/**
 * The tints a KPI card can carry — anything else stays the neutral default weight.
 *
 * `'good'` is a POSITIVE ASSERTION, not the absence of a problem: basalt-ui 1.8.0's
 * `StatCardTone` draws a rail for it exactly as it does for `'warn'`/`'bad'`, so returning it
 * claims "this was measured and it earned a clean verdict" — never "nothing to report" (that stays
 * `undefined`; see `StatCardTone`'s own docblock). Most tint functions in this module never return
 * it: `worstLossTint` and `worstBucketLoss`'s `null` already mean "nothing measured" rather than
 * "measured and clean", so there is nothing for `worstLossTint` to assert. Only `downtimeTint`
 * earns it, and only behind a coverage gate — see its docblock for why a defined zero is not, on
 * its own, enough evidence.
 */
export type ThresholdTint = 'good' | 'bad' | 'warn' | undefined

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
 * How much recorded downtime makes a window a bad reading rather than a marked one.
 *
 * Two thresholds, either of which is sufficient — but `DOWNTIME_BAD_SECONDS` used to be 300 (five
 * minutes), and that number is the bug this pair now exists to not repeat: **unscaled**, it was the
 * binding (smaller, so first-to-fire) constraint on every range this dashboard offers except the
 * shortest one, because `windowSeconds × DOWNTIME_BAD_FRACTION` only exceeds 300 s once the window
 * itself exceeds `300 / 0.005` = 60 000 s — under 17 hours. `24h`, `7d`, `30d` and `all` are all
 * longer than that, so on every one of them the "relative" half of this pair never got to do its
 * job: five minutes of cumulative downtime — one missed cycle a week, every week, for a year, the
 * exact "everything is good" line a reader reported — read as 99.988% on `30d` and 99.999% on
 * `all`, and both painted the card `bad`, the same verdict as a `24h` window that dropped for five
 * straight minutes. A five-minute absolute floor is not a floor at all once the window is longer
 * than about a day; it is the whole rule, and the fraction rule existed on paper only.
 *
 * `DOWNTIME_BAD_SECONDS` is now **3 600** (one hour) and reads as a different claim: not "longer
 * than a single blip" but "a substantial outage, full stop, regardless of how long the window is."
 * The crossover with the fraction rule sits at `3 600 / 0.005` = 720 000 s ≈ 8.3 days — below that,
 * `DOWNTIME_BAD_FRACTION` is the tighter (and therefore binding) test, exactly as the relative
 * threshold's own rationale below describes; above it, on `30d` and `all`, the absolute hour is
 * binding instead, but it now only fires for an outage that is itself substantial:
 *
 * | range | fraction crosses at | absolute crosses at | binding rule |
 * |-|-|-|-|
 * | 1h (3 600 s) | 18 s | 3 600 s | fraction |
 * | 24h (86 400 s) | 7.2 min | 1 h | fraction |
 * | 7d (604 800 s) | 50.4 min | 1 h | fraction |
 * | 30d (2 592 000 s) | 3.6 h | 1 h | **absolute** |
 * | all (31 536 000 s, 365d) | 43.8 h | 1 h | **absolute** |
 *
 * So the one-cycle-a-week line — a few minutes a year — stays `warn` on every range now, and the
 * case the old absolute number was originally written to catch (four hours of outage inside a
 * 365-day window, 0.05% and invisible to the fraction rule) still reads `bad`: 14 400 s clears the
 * 3 600 s floor even though it is nowhere near the 0.5% fraction bar. Neither number is measured
 * from this line's own history — this repo has no such figure yet. They are the same kind of
 * ordinary consumer-line reference point `WORST_LOSS_WARN_PCT` is, chosen so a genuinely dropped
 * call (an hour, not a cycle) is bad on any range and a rounding-error blip never is, and they stay
 * named constants so replacing either with a measured value later is one edit.
 *
 * `DOWNTIME_BAD_FRACTION` is relative: 0.5% of the window is availability worse than 99.5%
 * sustained across it. On a 24-hour window a single 60-second blip is 0.07% and lands on `warn` —
 * marked, because a drop is worth knowing about, but not the same reading as an hour offline. On a
 * 1-hour window that same blip is 1.7% and crosses, which is right: at the 1h range the question
 * being asked is "is it working right now", and it went away inside the hour.
 */
export const DOWNTIME_BAD_SECONDS = 3_600
export const DOWNTIME_BAD_FRACTION = 0.005

/**
 * Tint for the downtime card.
 *
 * Four states, where there used to be three. basalt-ui 1.8.0 added `'good'` to `StatCardTone`, and
 * a downtime figure of exactly zero looked at first like the obvious place to spend it — until a
 * second look at where `WindowDowntime` comes from: `windowDowntime` sums `outage` rows, and an
 * `outage` row only ever exists because `services/outage-detector.ts` opened one off an INGESTED
 * probe cycle (see the repo `CLAUDE.md`'s "Outages are materialised on write" note). A collector that
 * ingested nothing for the whole window opens no outage either, and `windowDowntime` returns the
 * identical `{ seconds: 0, openCount: 0 }` a genuinely clean window does. Coalescing that to
 * `'good'` would be this project's founding failure mode wearing a badge instead of a banner — the
 * same reason `GET /api/status`'s own `up` field cannot drive the Uptime Kuma heartbeat (see
 * `linewatch/CLAUDE.md`'s "Alerting is a missed heartbeat" section) is why a defined zero cannot
 * drive a green rail on its own.
 *
 * So `'good'` is gated on `coverage` — the share of the window, 0–1, that was actually measured —
 * and NOT on whether `seconds` is merely defined. Callers already compute this for
 * `compareWindows`'s own gate (`measuredFraction` in this file, or the ingestion-cycle-based
 * `RangeSummary.coveragePct / 100` if the caller has it — the latter is the tighter signal, since
 * it counts probe CYCLES rather than display buckets, one hop closer to the same ingestion event
 * that has to happen before an outage row can open at all). This function reuses
 * `COMPARABLE_COVERAGE` as the bar rather than inventing a second number: both ask the identical
 * question — "was this window watched enough to trust a positive claim drawn from it" — for a
 * different positive claim (a delta there, "nothing happened" here), and a second, independently
 * tuned threshold for the same question would drift from this one on the next pass with no data to
 * justify the difference.
 *
 * The gate applies ONLY to the zero-and-clean path, deliberately. `openCount > 0` and any nonzero
 * `downtime.seconds` are both derived from an outage row that DID open — real, ingested evidence,
 * true at any coverage level. Suppressing a `'bad'`/`'warn'` reading because the rest of the window
 * beyond the detected outage went unmeasured would hide a fact this dashboard actually has; only
 * the read of "nothing was detected" needs to ask whether anyone was looking.
 *
 * An open outage is `bad` regardless of seconds accrued or coverage: "still open" is itself the bad
 * fact, and the figure beside it is a floor that is out of date as it renders.
 */
export function downtimeTint(downtime: WindowDowntime, windowSeconds: number, coverage: number): ThresholdTint {
  if (downtime.openCount > 0) return 'bad'
  if (downtime.seconds > 0) {
    if (downtime.seconds >= DOWNTIME_BAD_SECONDS) return 'bad'
    // Guarded rather than divided blindly: a zero or negative span would make every fraction Infinity
    // or NaN, and NaN >= x is false — so a malformed window would silently downgrade a real outage to
    // `warn`. It falls through to `warn` explicitly instead, which is the reading the seconds alone
    // support.
    if (windowSeconds > 0 && downtime.seconds / windowSeconds >= DOWNTIME_BAD_FRACTION) return 'bad'
    return 'warn'
  }
  // Nothing detected. Earned green only if enough of the window was actually watched to trust that
  // "nothing detected" means "nothing happened" rather than "nobody looked" — see the docblock above.
  return coverage >= COMPARABLE_COVERAGE ? 'good' : undefined
}

/** How a pooled bucket combines its members. There is no default: pooling a worst-case series by
 * median and a typical-case series by maximum are both wrong, in opposite directions, and neither
 * has a caller who would notice. */
export type PoolMode = 'max' | 'median'

/**
 * Fold a dense series down to at most `cap` points, so a sparkline is drawn at the resolution it is
 * displayed at rather than under it.
 *
 * `BarSparkline` takes `number[]` with no width awareness: at 288 points in 173px it computes a
 * 0.60px step, floors every bar to 1px, and the bars overlap by 40% — the loss series renders as a
 * uniform grey block in which a single 100%-loss bucket is invisible. `LineSparkline` at the same
 * pitch is a curve through sub-pixel-spaced points, which is noise wearing the shape of a trend.
 *
 * **`mode` is not a formatting choice.** The loss series pools by MAXIMUM, because a worst-bucket
 * figure averaged away is exactly the fabrication `worstBucketLoss` was written to refuse — the
 * headline number on that card is a max over buckets, and a sparkline under it that smoothed the
 * spike out would contradict the number it sits below. The rtt and download series pool by MEDIAN,
 * because they are typical-case readings and a max would draw an envelope, not a trend.
 *
 * Pooling runs AFTER `denseSparkline`'s all-or-nothing hole gate and never as a way to fill a hole:
 * the input is already known to have no nulls. A pooled series must not change the card's headline
 * number, which comes from a different code path over the unpooled points.
 *
 * Buckets are contiguous and near-equal in size (`ceil(n / cap)` with the remainder in the last
 * bucket) rather than exactly equal, so the x-axis stays monotone in time and no member is dropped.
 */
export function poolTo(values: readonly number[], cap: number, mode: PoolMode): number[] {
  if (cap <= 0) return []
  if (values.length <= cap) return [...values]

  const size = Math.ceil(values.length / cap)
  const pooled: number[] = []
  for (let i = 0; i < values.length; i += size) {
    const chunk = values.slice(i, i + size)
    if (chunk.length === 0) continue
    pooled.push(mode === 'max' ? Math.max(...chunk) : medianOf(chunk))
  }
  return pooled
}

/** The plain median of a non-empty numeric chunk. `lib/aggregate.ts`'s `median` takes nullables and
 * returns a `{ value }` envelope, which is the right shape for a measurement that may be absent and
 * the wrong shape here — every member of a pooled chunk exists by construction. */
function medianOf(chunk: readonly number[]): number {
  const sorted = [...chunk].toSorted((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

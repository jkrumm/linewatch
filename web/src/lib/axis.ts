import type { ProbeBucketSeconds } from './types'

/**
 * The time label for one bucket on a chart's x-axis.
 *
 * `basalt-ui`'s `fmtAxisDate` renders every category as `DD.MM` — it matches the date out of an
 * ISO string and drops the time entirely. On a 24 h window at 5-minute buckets that produces an
 * axis reading `31.07 31.07 31.07 …` a dozen times: an axis that costs its full height and tells
 * the reader nothing about where they are in the window.
 *
 * **This is a formatter, not a key.** The bucketed charts' x is the bucket's start as a `Date` (the
 * instant) and `formatX` renders it at draw time; the label is never a domain value, because two
 * unrelated jobs on one string (identity and rendering) is what forced the old seconds-tiebreak
 * and UTC-offset-suffix machinery. The instant is also what puts every chart on the page cursor.
 *
 * Resolution still varies with the bucket size, but now for legibility rather than collision:
 *
 * - Buckets of a day or more get `DD.MM.YY`. **The year is not decoration.** The `all` range spans
 *   365 days, so a window opened on 1 August runs to 1 August, and an axis printing a bare `01.08`
 *   at both ends names the same day for two readings twelve months apart. It no longer drops one
 *   of them — the domain values differ — but a reader cannot tell them apart without it.
 * - Anything finer gets `DD.MM HH:MM`. Not `HH:MM` alone: a window is not guaranteed to sit inside
 *   one calendar day, and a 24 h window at 5-minute buckets genuinely contains the same clock time
 *   twice. No year needed — no sub-day bucket size produces a window long enough to wrap one, the
 *   coarsest being 4-hourly over 30 days.
 *
 * **Local wall clock, matching `fmtClock`/`fmtDateTime`** — an axis tick and the tooltip that opens
 * over it must not be read against two different clocks, and the reader's own is the one both now
 * use. This was UTC, along with everything else on the page, which made every correlation between
 * a column and a remembered moment an offset calculation done in the reader's head.
 *
 * **The shape stays fixed rather than following the host locale, and that is not an oversight.**
 * A locale-shaped label is of no predictable width, and basalt thins ticks by measured label
 * width, so handing this to `Intl` would make the axis density vary by machine. The zone is what a
 * reader needs from a tick.
 * The punctuation is not.
 */
export function bucketAxisLabel(ts: number, bucketSeconds: ProbeBucketSeconds): string {
  const d = new Date(ts)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  if (bucketSeconds >= 86_400)
    return `${dd}.${mm}.${String(d.getFullYear() % 100).padStart(2, '0')}`
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}.${mm} ${hh}:${mi}`
}

/**
 * `formatX` for a bucketed chart whose x is the bucket's start as a `Date`.
 *
 * A pure function of the instant, deliberately — the alternative is a `Map<key, label>` built
 * alongside the points, which is one more structure to keep in step with a fold, a densify and a
 * re-render. It runs once per drawn tick (order of ten), not once per bucket.
 *
 * Every bucketed chart passes this, so a change to how a time reads on one axis is a change to all
 * of them. That was previously true only by four copies of the same call agreeing.
 */
export function bucketTickFormat(bucketSeconds: ProbeBucketSeconds): (x: Date) => string {
  return (x) => bucketAxisLabel(x.getTime(), bucketSeconds)
}

/**
 * `formatX` for a series drawn one point per event rather than one per bucket (the speed runs).
 *
 * The x is the run's instant as a `Date`, which in 2.x is a proportional time scale: runs sit where
 * they happened, so they line up under the bucketed charts above and the shared cursor lands on the
 * same screen x everywhere. (1.x keyed these on an ISO string over a `scalePoint`, which spaced N
 * runs evenly whatever the gap and could not line up; the two functions that split key from label
 * are gone with it.) Uniqueness rests on two runs never sharing a millisecond — structural, not
 * lucky: `POST /api/speedtests/run` is rate-limited to one run per `speedtestMinIntervalS` and a
 * run takes tens of seconds.
 */
export function runTickFormat(x: Date): string {
  return bucketAxisLabel(x.getTime(), 60)
}

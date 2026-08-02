import type { ProbeBucketSeconds } from './types'

/**
 * Horizontal room one `bucketAxisLabel` needs, in px, including breathing space.
 *
 * `DD.MM HH:MM` measures ~72px at the 11px axis font, and basalt's own `smartTicks` spaces ticks by
 * `VX.minPxPerTick`, which is 55 — sized for the bare `DD.MM` its formatter used to produce. Left at
 * 55 the richer label overlaps its neighbour at every single tick, which is measurably worse than
 * the repeated-date axis it replaced. This is that constant, corrected for the label actually drawn.
 */
export const AXIS_LABEL_PX = 96

/**
 * Which of a chart's category values get a tick, given the axis width.
 *
 * The values are DOMAIN values, not labels — on the four bucketed charts that is the bucket's ISO
 * start, which `AxisBottomDate` renders through `bucketTickFormat`. `minPxPerTick` still measures
 * the *drawn* label, which is why it stays `AXIS_LABEL_PX` and not the width of an ISO string:
 * spacing is a question about what the reader sees, not about what the scale holds.
 *
 * Deliberately not `smartTicks`: that helper appends the final value unconditionally, so the last
 * two ticks land wherever the step happens to leave them — on a 24 h window that printed
 * `01.08 15:10` and `01.08 15:20` on top of each other at the right edge. Here the final value is
 * included only when it clears the previous tick by a full label width, because a legible axis that
 * omits its last gridline is strictly better than one whose last two labels are unreadable.
 *
 * Evenly spaced from the start otherwise, so the ticks stay on round-ish positions rather than
 * drifting to fit the end.
 */
export function axisTickValues<T>(values: readonly T[], widthPx: number, minPxPerTick = AXIS_LABEL_PX): T[] {
  if (values.length === 0) return []
  const maxTicks = Math.max(2, Math.floor(widthPx / minPxPerTick))
  if (values.length <= maxTicks) return [...values]

  const step = Math.ceil(values.length / maxTicks)
  const picked: T[] = []
  for (let i = 0; i < values.length; i += step) picked.push(values[i]!)

  // The last value is worth a tick only if it does not crowd the one before it. `step` positions
  // are `step * (widthPx / values.length)` px apart, so the remainder decides.
  const pxPerValue = widthPx / values.length
  const lastIndex = values.length - 1
  const lastPickedIndex = (picked.length - 1) * step
  if ((lastIndex - lastPickedIndex) * pxPerValue >= minPxPerTick) picked.push(values[lastIndex]!)

  return picked
}

/**
 * A tick count for `MultiLine`'s `numTicksX` whose final label will not crowd its neighbour.
 *
 * `MultiLine` picks ticks with basalt's `smartTicksEvery(values, count)`: every `ceil(n / count)`-th
 * value, **plus the last one unconditionally**. When the step does not land on the final index that
 * appended tick sits a partial step from its neighbour — measured on a 24 h window, `01.08 14:05`
 * and `01.08 15:20` printed on top of each other at the right edge. `numTicksX` is the only lever
 * the kind exposes.
 *
 * The test is in **pixels, not divisibility**. Requiring the step to divide the axis evenly sounds
 * tidier but frequently has no solution at all — at 100 values no count from 2 to 11 divides 99 —
 * and it answers the wrong question anyway: a final gap of 9 steps where the others are 10 is
 * perfectly legible, while one of 1 is not. So this accepts the densest count whose final gap still
 * clears a label width, and only then falls back.
 *
 * The fallback is `maxTicks`: a single crowded label at the right edge is a better outcome than an
 * axis thinned to three ticks to avoid it.
 */
export function fitTickCount(
  valueCount: number,
  maxTicks: number,
  widthPx: number,
  minPxPerTick = AXIS_LABEL_PX,
): number {
  const ceiling = Math.max(2, maxTicks)
  if (valueCount <= ceiling) return ceiling

  const pxPerValue = widthPx / valueCount
  for (let count = ceiling; count >= 2; count--) {
    const step = Math.ceil(valueCount / count)
    // `% step === 0` means the step already lands on the final index, so the append is a no-op and
    // the final gap is a full step.
    const finalGap = (valueCount - 1) % step === 0 ? step : (valueCount - 1) % step
    if (finalGap * pxPerValue >= minPxPerTick) return count
  }
  return ceiling
}

/**
 * The time label for one bucket on a chart's x-axis, in UTC.
 *
 * `basalt-ui`'s `fmtAxisDate` renders every category as `DD.MM` — it matches the date out of an
 * ISO string and drops the time entirely. On a 24 h window at 5-minute buckets that produces an
 * axis reading `31.07 31.07 31.07 …` a dozen times: an axis that costs its full height and tells
 * the reader nothing about where they are in the window.
 *
 * **This is a formatter now, not a key.** basalt-ui 1.9.0 gave `AxisBottomDate` a `tickFormat`, so
 * the four charts that compose the axis directly (both strips, the throughput bars, the latency
 * band) keep the bucket's ISO start as their scale domain and pass this in to render it. Before
 * that there was no supported exit — `fmtAxisDate` returns a non-ISO string unchanged, so a
 * *pre-formatted* label was the only thing that reached the axis, which forced the label to double
 * as the scale's domain value and, through it, as the cross-chart hover key and the fold index's
 * key. Three unrelated jobs on one string. `tickFormat` separates them: identity is the ISO start,
 * rendering is this function, and neither constrains the other.
 *
 * `MultiLine` still forwards no `tickFormat` (it calls `AxisBottomDate` with `scale` and
 * `tickValues` only), so the two run-series charts on that kind — `speed-chart`,
 * `bufferbloat-chart` — must still pre-format via `runAxisLabels`, where the label genuinely is
 * the domain value and uniqueness genuinely is load-bearing. See that function.
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
 * `AXIS_LABEL_PX` above is a measured width that the tick spacing, the strips' plot insets and
 * `fitTickCount` all read; a locale-shaped label is of no predictable width, so handing this to
 * `Intl` would silently invalidate every one of them. The zone is what a reader needs from a tick.
 * The punctuation is not.
 */
export function bucketAxisLabel(ts: number, bucketSeconds: ProbeBucketSeconds): string {
  const d = new Date(ts)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  if (bucketSeconds >= 86_400) return `${dd}.${mm}.${String(d.getFullYear() % 100).padStart(2, '0')}`
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}.${mm} ${hh}:${mi}`
}

/**
 * `AxisBottomDate`'s `tickFormat` for a bucketed chart whose scale domain is the bucket's ISO
 * start.
 *
 * A pure function of the domain value, deliberately — the alternative is a `Map<key, label>` built
 * alongside the points, which is one more structure to keep in step with a fold, a densify and a
 * re-render. `Date.parse` on the ISO string `densifyBuckets` emitted is exact, and it runs once
 * per drawn tick (order of ten), not once per bucket.
 *
 * All four bucketed charts pass this, so a change to how a time reads on one axis is a change to
 * all of them. That was previously true only by four copies of the same call agreeing.
 */
export function bucketTickFormat(bucketSeconds: ProbeBucketSeconds): (key: string) => string {
  return (key) => bucketAxisLabel(Date.parse(key), bucketSeconds)
}

/**
 * Axis labels for a series drawn one point per event rather than one per bucket.
 *
 * **Still pre-formatted, and still a scale key — this is the case `tickFormat` did not reach.**
 * `MultiLine` calls `AxisBottomDate` with `scale` and `tickValues` and forwards no format, so for
 * the two charts built on that kind the string returned from `getX` is the domain value, the hover
 * key and the visible tooltip header at once. Everything below therefore still holds here, exactly
 * as it stopped holding for the bucketed charts.
 *
 * The bucketed charts get uniqueness for free: `bucketAxisLabel` is injective over a grid whose
 * step is at least a minute. A speed-test series has no grid — the runs land wherever the cron
 * fired, two can share a minute after a manual run, and the label doubles as the categorical
 * scale's key. Two points sharing a key collapse onto one x position and one of them stops being
 * drawn, which is a measurement silently dropped.
 *
 * So collisions are broken by appending a seconds field to *every* label in a colliding group,
 * rather than only to the later ones. Disambiguating just the duplicate would put `01.08 14:03`
 * and `01.08 14:03:41` side by side on one axis, and a reader comparing them would take the
 * difference in precision for a difference in the measurement.
 *
 * **Seconds are no longer the last resort, because the labels are local now.** On the autumn
 * DST fall-back the local wall clock repeats a whole hour, so two runs 3600 s apart agree on the
 * date, the hour, the minute AND the second — and a seconds-only tiebreak hands them one identical
 * key, which is the silently-dropped measurement this whole function exists to prevent. It just
 * moved from "twice in a minute" to "once a year". A second pass appends the UTC offset to any
 * group still colliding, which is precisely the fact that distinguishes them; it costs one suffix
 * on one hour a year and nothing at all on the other 8759.
 *
 * Order is preserved and the output is index-aligned with the input, because the caller zips it
 * back onto the runs it came from.
 */
export function runAxisLabels(timestamps: readonly number[]): string[] {
  const minuteLabel = (ts: number) => bucketAxisLabel(ts, 60)
  const withSeconds = (ts: number) => `${minuteLabel(ts)}:${String(new Date(ts).getSeconds()).padStart(2, '0')}`

  const toMinute = timestamps.map(minuteLabel)
  const minuteCounts = tally(toMinute)
  // Every member of a colliding group gets the seconds, not only the later one — see above.
  const withTiebreak = timestamps.map((ts, i) => ((minuteCounts.get(toMinute[i]!) ?? 0) <= 1 ? toMinute[i]! : withSeconds(ts)))

  const secondCounts = tally(withTiebreak)
  return withTiebreak.map((label, i) =>
    (secondCounts.get(label) ?? 0) <= 1 ? label : `${label} ${utcOffsetLabel(timestamps[i]!)}`,
  )
}

function tally(labels: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  return counts
}

/** `UTC+02` / `UTC-05` — the offset the instant is being read through, for the one case where two
 * instants share a local wall clock. Whole hours only would be wrong for the zones that run on a
 * :30 or :45 offset, so the minutes are kept when there are any. */
function utcOffsetLabel(ts: number): string {
  // `getTimezoneOffset` is minutes to ADD to local to reach UTC, i.e. positive west of Greenwich —
  // the opposite sign to how an offset is written.
  const minutes = -new Date(ts).getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = abs % 60
  return mm === 0 ? `UTC${sign}${hh}` : `UTC${sign}${hh}:${String(mm).padStart(2, '0')}`
}

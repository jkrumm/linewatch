import type { ProbeBucketSeconds } from './types'

/**
 * The time label for one bucket on a chart's x-axis, in UTC.
 *
 * `basalt-ui`'s `fmtAxisDate` renders every category as `DD.MM` — it matches the date out of an
 * ISO string and drops the time entirely. On a 24 h window at 5-minute buckets that produces an
 * axis reading `31.07 31.07 31.07 …` a dozen times: an axis that costs its full height and tells
 * the reader nothing about where they are in the window.
 *
 * `AxisBottomDate` accepts a `tickFormat` override, so a chart composing it directly can just pass
 * one. `MultiLine` does not forward it — it calls `AxisBottomDate` with no format — so a chart
 * built on that kind can only reach the axis through the category string it returns from `getX`.
 * `fmtAxisDate` returns any non-ISO-shaped string unchanged, so a pre-formatted label passes
 * straight through. That is the mechanism this function exists to feed, and it is why the label
 * must be display-ready rather than a timestamp.
 *
 * **The label doubles as the band scale's key, so it has to stay unique per bucket.** Two buckets
 * sharing a label collapse onto one x position and one of them stops being drawn — a measurement
 * silently dropped, which is the failure this codebase is built to refuse. Uniqueness is decided by
 * the bucket size:
 *
 * - Buckets of a day or more get `DD.MM.YY`. **The year is not decoration.** The `all` range spans
 *   365 days, so a window opened on 1 August runs to 1 August: first and last bucket produce an
 *   identical `DD.MM`, collide as scale keys, and one of the year's two endpoints stops being
 *   drawn. This was live — the year-long axis printed `01.08` twice, stacked at the same x.
 * - Anything finer gets `DD.MM HH:MM`. Not `HH:MM` alone: a window is not guaranteed to sit inside
 *   one calendar day, and a 24 h window at 5-minute buckets genuinely contains the same clock time
 *   twice. No year needed — no sub-day bucket size produces a window long enough to wrap one, the
 *   coarsest being 4-hourly over 30 days.
 *
 * UTC, matching `fmtClock`/`fmtDateTime` and the verdict layer, so nothing on the page is rendered
 * against a different clock from anything else.
 */
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

export function bucketAxisLabel(ts: number, bucketSeconds: ProbeBucketSeconds): string {
  const d = new Date(ts)
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  if (bucketSeconds >= 86_400) return `${dd}.${mm}.${String(d.getUTCFullYear() % 100).padStart(2, '0')}`
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  return `${dd}.${mm} ${hh}:${mi}`
}

/**
 * Axis labels for a series drawn one point per event rather than one per bucket.
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
 * Order is preserved and the output is index-aligned with the input, because the caller zips it
 * back onto the runs it came from.
 */
export function runAxisLabels(timestamps: readonly number[]): string[] {
  const minuteLabel = (ts: number) => bucketAxisLabel(ts, 60)
  const counts = new Map<string, number>()
  for (const ts of timestamps) {
    const label = minuteLabel(ts)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return timestamps.map((ts) => {
    const label = minuteLabel(ts)
    if ((counts.get(label) ?? 0) <= 1) return label
    return `${label}:${String(new Date(ts).getUTCSeconds()).padStart(2, '0')}`
  })
}

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
 * A tick count for `xTicks` whose final label will not crowd its neighbour.
 *
 * `CartesianChart` (and every kind that composes it) picks ticks with basalt's
 * `smartTicksEvery(values, count)` when `xTicks` is set: every `ceil(n / count)`-th value, **plus
 * the last one unconditionally**. When the step does not land on the final index that appended tick
 * sits a partial step from its neighbour — measured on a 24 h window, `01.08 14:05` and
 * `01.08 15:20` printed on top of each other at the right edge. A COUNT is the only lever those
 * charts expose, which is why `speed-chart`, `bufferbloat-chart` and `latency-band-chart` measure
 * their own container: a count that keeps labels apart can only be derived from a width. The three
 * charts that compose `AxisBottomDate` themselves pass tick VALUES (`axisTickValues`) instead.
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
 * The time label for one bucket on a chart's x-axis.
 *
 * `basalt-ui`'s `fmtAxisDate` renders every category as `DD.MM` — it matches the date out of an
 * ISO string and drops the time entirely. On a 24 h window at 5-minute buckets that produces an
 * axis reading `31.07 31.07 31.07 …` a dozen times: an axis that costs its full height and tells
 * the reader nothing about where they are in the window.
 *
 * **This is a formatter now, not a key.** The four bucketed charts keep the bucket's ISO start as
 * their scale domain and pass this in to render it — the latency band through
 * `CartesianChart`'s `formatX`, both strips and the throughput bars through `AxisBottomDate`'s
 * `tickFormat`, which they still compose themselves. Before either existed there was no supported
 * exit: `fmtAxisDate` returns a non-ISO string unchanged, so a *pre-formatted* label was the only
 * thing that reached the axis, which forced the label to double as the scale's domain value and,
 * through it, as the cross-chart hover key. Two unrelated jobs on one string. Separating them also
 * bought the cursor: `useChartCursor` resolves a sibling's key by PARSING it, so an ISO domain is
 * what lets a folded strip track the unfolded latency band with no key map in between.
 *
 * The two run-series charts reach it the same way: `MultiLine` gained `formatX` in 1.17.0, so
 * `runTickFormat` renders their axis and `runAxisKey` is their identity. Nothing on this page
 * formats through its domain value any more.
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
 * Scale key and axis label for a series drawn one point per event rather than one per bucket.
 *
 * **Two functions, because they are two jobs — which is the whole point.** `runAxisKey` produces
 * the categorical scale's domain value and `runTickFormat` renders it. For most of this file's
 * history they were one string: `MultiLine` forwarded no `formatX`, so the only thing that reached
 * the axis was the value `getX` returned, and the visible label was therefore also the identity.
 * That forced a whole apparatus — a seconds tiebreak appended to every member of a colliding
 * minute, then a UTC-offset suffix for the autumn fall-back hour where two runs 3600 s apart agree
 * on date, hour, minute AND second — to keep a *display* string unique, because two points sharing
 * a domain value collapse onto one x position and one of them stops being drawn. `formatX` on the
 * kinds (basalt-ui 1.17.0) ended that, and the apparatus went with it.
 *
 * The key is `ts:id`, not the timestamp alone. `id` is the row's primary key, so uniqueness is a
 * fact rather than an argument about how unlikely two runs sharing a millisecond are; the `ts`
 * prefix is what lets the label be a pure function of the key, with no `Map` to keep in step with
 * a re-sort. The pair is deliberately NOT parseable as a date or a number: these two charts sit in
 * their own `ChartCursorScope` because their x-axis is runs rather than clock time, and a key that
 * resolves against nothing is the honest shape for that.
 */
export function runAxisKey(ts: number, id: number): string {
  return `${ts}:${id}`
}

/** `MultiLine`'s `formatX` for a run series — the reading half of `runAxisKey`. */
export function runTickFormat(key: string): string {
  return bucketAxisLabel(Number(key.slice(0, key.indexOf(':'))), 60)
}


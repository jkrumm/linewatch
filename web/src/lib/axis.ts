import type { ProbeBucketSeconds } from './types'

/**
 * Horizontal room one `bucketAxisLabel` needs, in px, including breathing space.
 *
 * `DD.MM HH:MM` measures ~72px at the 11px axis font, and basalt's own `smartTicks` spaces ticks by
 * `VX.minPxPerTick`, which is 55 — sized for the bare `DD.MM` its formatter used to produce. Left at
 * 55 the richer label overlaps its neighbour at every single tick, which is measurably worse than
 * the repeated-date axis it replaced. This is that constant, corrected for the label actually drawn,
 * and it is now `axisTickValues`'s default alone: the strips' plot insets are the framework's
 * measured gutters as of 1.23.0, and nothing derives a tick COUNT from a width any more.
 */
export const AXIS_LABEL_PX = 96

/**
 * Which of a chart's category values get a tick, given the axis width.
 *
 * **Every chart on this page passes this, and passes it the same way**: as `xTickValues`, the seam
 * basalt-ui 1.23.0 added to `CartesianChart`, `MultiLine` and both band kinds. Its shape is that
 * seam's shape — `(keys, plotWidth) => keys` — so it is handed straight to the prop rather than
 * wrapped, and the width is the chart's OWN resolved plot rect rather than an estimate.
 *
 * The values are DOMAIN values, not labels — on the bucketed charts that is the bucket's ISO start,
 * rendered through `bucketTickFormat`. `minPxPerTick` still measures the *drawn* label, which is
 * why it stays `AXIS_LABEL_PX` and not the width of an ISO string: spacing is a question about what
 * the reader sees, not about what the scale holds.
 *
 * Deliberately not `smartTicks`, and not a tick COUNT either: both append the final value
 * unconditionally, so the last two ticks land wherever the step happens to leave them — on a 24 h
 * window that printed `01.08 15:10` and `01.08 15:20` on top of each other at the right edge, at
 * every count rather than at an unlucky one. Here the final value is included only when it clears
 * the previous tick by a full label width, because a legible axis that omits its last gridline is
 * strictly better than one whose last two labels are unreadable.
 *
 * Evenly spaced from the start otherwise, so the ticks stay on round-ish positions rather than
 * drifting to fit the end.
 */
export function axisTickValues<T>(
  values: readonly T[],
  widthPx: number,
  minPxPerTick = AXIS_LABEL_PX,
): T[] {
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
 * The time label for one bucket on a chart's x-axis.
 *
 * `basalt-ui`'s `fmtAxisDate` renders every category as `DD.MM` — it matches the date out of an
 * ISO string and drops the time entirely. On a 24 h window at 5-minute buckets that produces an
 * axis reading `31.07 31.07 31.07 …` a dozen times: an axis that costs its full height and tells
 * the reader nothing about where they are in the window.
 *
 * **This is a formatter now, not a key.** The four bucketed charts keep the bucket's ISO start as
 * their scale domain and pass this in to render it — all four through `formatX`, on
 * `CartesianChart` and on the two band kinds alike, since none of them composes its own axis any
 * more. Before that seam existed there was no supported
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
 * `AXIS_LABEL_PX` above is a measured width that `axisTickValues` reads on every chart on the
 * page; a locale-shaped label is of no predictable width, so handing this to `Intl` would silently
 * invalidate it. The zone is what a reader needs from a tick.
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
 * `formatX` for a bucketed chart whose scale domain is the bucket's ISO start.
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
 * **Two functions, because they are two jobs.** `runAxisKey` produces the categorical scale's
 * domain value and `runTickFormat` renders it. For most of this file's history they were one
 * string: the kinds forwarded no `formatX`, so the only thing that reached the axis was the value
 * `getX` returned, and the visible label was therefore also the identity. That forced a whole
 * apparatus — a seconds tiebreak appended to every member of a colliding minute, then a UTC-offset
 * suffix for the autumn fall-back hour where two runs 3600 s apart agree on date, hour, minute AND
 * second — to keep a *display* string unique, because two points sharing a domain value collapse
 * onto one x position and one of them stops being drawn. `formatX` (basalt-ui 1.17.0) ended that.
 *
 * **The key is the run's instant, and that is what puts these charts on the page cursor.**
 * `useChartCursor` resolves a sibling's broadcast key by PARSING it, so an ISO instant is the only
 * shape that can correspond to a bucketed chart's domain at all. Hovering a latency spike now
 * marks the speed run nearest it, and hovering a run marks the bucket it landed in. It used to be
 * `ts:id` — deliberately unparseable, to keep two axes that did not correspond from being lined
 * up — and `ChartCursorScope` isolated the section on top of that.
 *
 * **What that trades, stated once so nobody re-derives it from the symptom:** uniqueness now rests
 * on two runs never sharing a millisecond, where the row id made it a fact. That is structural
 * rather than lucky — `POST /api/speedtests/run` is rate-limited to one run per
 * `speedtestMinIntervalS` (5 min) measured against the newest stored row, and a run takes tens of
 * seconds — but it is an argument, not a primary key, and it is the reason this comment exists.
 *
 * **These charts still do not line up horizontally with the ones above them, and cannot.** Every
 * cartesian x scale in basalt-ui is a `scalePoint` over the domain's own keys, so 24 runs are 24
 * evenly spaced positions whatever the real gap between them; the bucketed charts only look
 * proportional because their domain IS a regular grid. The cursor therefore resolves the right
 * RUN at the wrong screen x. Proportional time placement needs a linear x scale the framework does
 * not have.
 */
export function runAxisKey(ts: number): string {
  return new Date(ts).toISOString()
}

/** `MultiLine`'s `formatX` for a run series — the reading half of `runAxisKey`. */
export function runTickFormat(key: string): string {
  return bucketAxisLabel(Date.parse(key), 60)
}

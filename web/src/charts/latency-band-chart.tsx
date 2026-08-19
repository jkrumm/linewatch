import { useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { Area } from '@visx/shape'
import {
  CartesianChart,
  type ChartSeries,
  Group,
  LinePath,
  type PlotContext,
  TooltipRow,
  VX,
  alpha,
  curveMonotoneX,
  fmtTooltipDate,
  useChartSize,
} from 'basalt-ui/charts'
import { useInViewport } from './use-in-viewport'
import type {
  HomeLineVerdict,
  Outage,
  ProbeBucket,
  ProbeBucketSeconds,
  VantageBucket,
} from '../lib/types'
import { densifyBuckets } from '../lib/densify'
import { AXIS_LABEL_PX, bucketTickFormat, fitTickCount } from '../lib/axis'
import { PROBE_CYCLE_MS } from '../lib/range'
import { fmtClock, fmtDuration, fmtMs, fmtPct } from '../lib/format'
import { HatchPattern, hatchFill } from './hatch'

/** One position on the time axis. `bucket === null` is a bucket the range route returned no row
 * for: unmeasured, which the chart must draw as its own state rather than as a gap the curve
 * smooths over. `vantage` is the parallel per-bucket record of what those cycles measured
 * *through* — null when the bucket held no cycles at all. `overlayMs` is the second, band-less
 * median: always present on the point (null when there is no `overlay` prop, or the overlay's own
 * bucket at this slot has none), so the drawing code never has to ask the point "does an overlay
 * exist" separately from "what is its value here". */
export type Point = {
  /**
   * `densifyBuckets`' own ISO-8601 bucket start: the x-scale's domain value and the key this chart
   * broadcasts to the shared cursor. One instant, one identity, shared verbatim with the strips.
   *
   * **It is no longer also what the tooltip header renders.** For one release it was a LOCAL ISO
   * stamp with the offset written out, because `TooltipHeader` regexed `YYYY-MM-DD` out of the key
   * and rebuilt a local `Date` from it — so a UTC key named a different calendar day than the
   * axis, the badge and every sibling on the page for every bucket after 22:00 local. That is
   * `tooltip.formatHeader` in 1.17.0, and rendering is now the only thing formatting does.
   *
   * It used to carry a pre-formatted `label` alongside, because `AxisBottomDate` accepted no
   * `tickFormat` and rendered the domain through `fmtAxisDate`, which reduces an ISO string to
   * `DD.MM` — a 24 h window drew `01.08` a dozen times across the bottom of the page's primary
   * latency chart. A pre-formatted label passed through untouched and was the only way to reach
   * the axis, which is what forced the *display* string to also be the *identity*. `tickFormat`
   * ended that in 1.9.0 and `CartesianChart`'s `formatX` is the higher-level form of it now; see
   * `lib/axis.ts`. The ISO key also earns its keep at the cursor: `useChartCursor` resolves a
   * sibling's broadcast key by parsing it, so an ISO domain is what lets the folded strips below
   * track this chart's 288 unfolded buckets with no index in between.
   */
  key: string
  /** The bucket's own start, unix ms — the tooltip header's date and the outage-overlay's x-map
   * both read this rather than re-deriving it from `key`. */
  bucketStart: number
  bucket: ProbeBucket | null
  vantage: VantageBucket | null
  overlayMs: number | null
}

/** Restatements of the four `HomeLineVerdict` values, not judgements about them. Only `all`
 * claims the whole bucket; the other three each mean the bucket's latency describes something
 * other than (or not provably) this line. */
/**
 * The router overlay's colour, at module scope on purpose.
 *
 * The legend entry is built in `LatencyBandChart` and the `LinePath` is drawn in the plot component
 * below it — two functions, and while this was two separate literals the mark kept `VX.line`
 * through two changes to the legend, so the swatch named a colour the line did not have. One
 * binding is the only thing that makes them impossible to drift.
 */
const OVERLAY_COLOR = VX.line2

const HOME_LINE_LABEL: Record<HomeLineVerdict, string> = {
  all: 'Home line',
  none: 'Not the home line',
  mixed: 'Mixed paths',
  unknown: 'Not reported',
}

/** The *Solid* variants, not `VX.good`/`VX.warn`/`VX.bad`: those are area-fill tokens mixed down to
 * 18% / 8% / 18% opacity (`tokens.css`), which is right behind a line and invisible on a 3 px
 * marker. A loss marker has to read at a glance or it is not a warning. */
/** Where the marker ramp steps from amber to red, named once because the legend entries
 * (`loss-partial` / `loss-heavy`) and the gate that decides which dot to draw both read it. Two
 * copies of a `20` would let a retuned threshold move the mark and leave the legend behind. */
const HEAVY_LOSS_PCT = 20

function lossColor(lossPct: number): string {
  if (lossPct <= 0) return VX.goodSolid
  if (lossPct < HEAVY_LOSS_PCT) return VX.warnSolid
  return VX.badSolid
}

/** Height of the vantage rail along the bottom axis, in px. */
const RAIL_H = 5

/** Stable across renders, unlike an inline arrow — `CartesianChart` memoizes the x keys and the
 * cursor's domain index on `getX`'s identity, and an inline `(p) => p.key` is a new function every
 * render of a page that re-renders on a 30 s heartbeat; see `availability-strip.tsx`'s identical
 * constant. */
const getPointKey = (p: Point): string => p.key

/**
 * The SmokePing-style signature chart (DESIGN.md's "Latency" view): a median line with a shaded
 * p5–p95 band, loss encoded as marker color. Genuinely unique (a band between two arbitrary
 * series, per-point loss markers) so it stays bespoke rather than becoming a shipped kind — but
 * bespoke now means **composing `CartesianChart` and drawing only marks**, not assembling a plot.
 * It is a single cartesian plot with one numeric y axis, which is exactly the shape that primitive
 * owns, so the ~230 lines this file spent on margins, scales, the grid, the axes, the shared
 * cursor, the crosshair, the hover overlay and the tooltip shell are gone. What is left below the
 * render prop is the four marks nothing else on the page draws.
 *
 * The x-domain comes from the requested window, never from the response. Three things this chart
 * used to draw as identical blank space are now three distinct marks: a bucket that was never
 * measured (hatched), a bucket where every cycle lost every packet (bad band), and a bucket
 * measured through something other than the home line (bottom rail).
 *
 * The chart no longer knows what a target is. It used to take `target: TargetName` and derive its
 * title/id straight from `TARGET_LABEL`, which meant it could only ever draw one of the four raw
 * per-target series. It now takes a plain `label` and `chartKey` and draws whatever band it is
 * handed — which is what lets the promoted dashboard view feed it a *folded* series (the three WAN
 * anchors' median-of-medians) instead of a single target, with the same component, unchanged.
 *
 * `overlay` adds a second, band-less median line sharing this chart's y-scale — the router's own
 * RTT drawn over the folded-internet band, so one picture answers "how bad, and is it past the
 * router".
 *
 * **With an overlay the primary takes the accent and the overlay takes the mid grey** — the same
 * ranking `speed-chart` and `throughput-chart` use, and for the same reason: the series the chart
 * is ABOUT should be the most visible thing on it.
 *
 * It took two wrong turns to land there, both worth recording because the symptom pointed away
 * from the cause. The internet band read as washed out next to the router line, so the accent was
 * moved to the router — which made the primary dimmer still. The actual fault was neither
 * assignment: the overlay's `LinePath` hard-coded `stroke={VX.line}` and never read the colour its
 * own legend entry declared, so the router was drawn at 11.1:1 against the panel no matter what
 * this file said, out-shining the accent primary at 7.8:1 the whole time — and once the legend
 * entry stopped saying `VX.line`, the swatch named a colour the mark did not have. Both colours now
 * come from one binding each; `overlay-color.test.ts` pins that they cannot drift apart again.
 *
 * With NO overlay the primary keeps `VX.line`, the bright neutral: there it is the only series on
 * the chart, and a lone neutral metric is supposed to be the bright one.
 */
export function LatencyBandChart({
  label,
  chartKey,
  buckets,
  vantage,
  from,
  to,
  bucketSeconds,
  isPending,
  overlay,
  renderExtraTooltipRows,
  outages,
}: {
  /** How the primary series is named in the legend, tooltip and accessible label. */
  label: string
  /** Stable identity for the cursor/chart id — must be unique per mounted instance. */
  chartKey: string
  buckets: ProbeBucket[]
  vantage: VantageBucket[]
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
  /**
   * True while the probe-buckets queries behind this band are in flight.
   *
   * Forwarded to `CartesianChart`, which hands it to `ChartFrame` — the plot rect is reserved,
   * `ChartPending` renders in place of the marks, the legend is dropped and `aria-busy` is set.
   * Dropping the legend is the part worth naming: it declares "Loss under 20%", "Loss 20% or
   * more" and "Cycles fully down" — an encoding for marks that, while pending, do not exist.
   */
  isPending?: boolean
  /**
   * A second median line drawn over the band, with no band of its own.
   *
   * `buckets` are matched to the primary series' slots by bucket start, through the same
   * `densifyBuckets` pass — never by array index. The two series are sparse in different places
   * (the gateway can answer a cycle in which no anchor did, and the reverse), so index-aligning
   * them would silently plot one series' reading at another's instant.
   */
  overlay?: {
    label: string
    buckets: readonly ProbeBucket[]
  }
  /**
   * Extra tooltip rows the caller supplies for a bucket it knows more about than this chart does.
   *
   * The dashboard feeds this chart a *folded* series — the three WAN anchors' median-of-medians —
   * whose buckets carry two facts a `ProbeBucket` has no field for: how many anchors the fold was
   * taken over, and the worst loss any single one of them reported. Both are exactly what a reader
   * needs in order not to misread the band: a one-anchor median and a three-anchor median are
   * different claims, and an internet-wide loss of 0% alongside one dead anchor is two separate
   * pieces of news. The chart cannot know either, so the caller states them, in its own words, on
   * the row that draws them.
   *
   * Called only for a measured bucket — an unmeasured slot has nothing extra to say, and a
   * supplementary row under "Not measured" would imply otherwise.
   */
  renderExtraTooltipRows?: (bucket: ProbeBucket) => ReactNode
  /**
   * Recorded outages to overlay, already scoped to this chart's own subject by the caller.
   *
   * The chart deliberately does not know what a target is (see the component docblock), so it
   * cannot decide whether an `Outage` with `scope: 'gateway'` belongs over the band it is drawing.
   * Drawing a gateway outage across the internet band would assert something the row does not say,
   * so the caller filters by scope and this draws whatever it is handed. Rows are expected to be
   * `GET /api/outages`'s OVERLAP result — an outage that began before `from` arrives whole, which is
   * why both edges are clamped to the plot rather than skipped.
   */
  outages?: readonly Outage[]
}) {
  const points: Point[] = useMemo(() => {
    const vantageByBucket = new Map(vantage.map((v) => [v.bucket, v]))
    // Densified on the SAME {from, to, bucketSeconds} window as the primary series, so its slot
    // grid lines up bucket-start-for-bucket-start with the primary's — matched below by that start,
    // not by array position.
    const overlayByBucket = overlay
      ? new Map(
          // `densifyBuckets` takes a mutable array; `overlay.buckets` is `readonly` on the public
          // prop so a caller's own array can't be mutated through it — spread a shallow copy in.
          densifyBuckets([...overlay.buckets], { from, to, bucketSeconds }).map((slot) => [
            slot.bucketStart,
            slot.value?.medianMs ?? null,
          ]),
        )
      : null
    return densifyBuckets(buckets, { from, to, bucketSeconds }).map((slot) => ({
      key: slot.key,
      bucketStart: slot.bucketStart,
      bucket: slot.value,
      vantage: vantageByBucket.get(slot.bucketStart) ?? null,
      overlayMs: overlayByBucket?.get(slot.bucketStart) ?? null,
    }))
  }, [buckets, vantage, overlay, from, to, bucketSeconds])

  // What the collector's cadence should have produced in one bucket. Named "expected" wherever it
  // is shown, because it is arithmetic over the configured cadence, not a count of anything.
  const expectedCycles = Math.max(1, Math.round((bucketSeconds * 1000) / PROBE_CYCLE_MS))

  // Alone, the primary is the bright neutral; against an overlay it takes the accent and the
  // overlay steps down to the mid grey. ONE binding each, and the mark now reads it back off the
  // series descriptor rather than repeating it — see `overlay-color.test.ts` for the bug that made
  // that worth spelling out, and why the fix is structural rather than a comment.
  const primaryColor = overlay ? VX.accent : VX.line
  const overlayKey = `${chartKey}-overlay`

  const hasOutages = outages !== undefined && outages.length > 0
  const bucketMs = bucketSeconds * 1000

  /**
   * The single source of truth for the marks, the legend and the tooltip's per-series rows.
   *
   * Six entries, only two of which carry a value. The other four are ENCODINGS — the two loss
   * marker thresholds, the full-loss band, the outage rail — which the legend has to name because
   * they are the marks on this chart a reader cannot decode from the axes. They return `null` from
   * `getValue`, so they are legended and never become a tooltip row or a crosshair dot; `mark`
   * still governs their swatch, and `fillOpacity` keeps the washed band's swatch distinguishable
   * from the solid dots.
   *
   * **Encoding does not mean "no mark behind it".** All four are read back out of `ctx.visible` in
   * `LatencyMarks` and gate the mark they name, one for one — which is what makes them honest
   * entries rather than captions, and what `legend={{ toggle: false }}` is currently the only
   * reason nobody can see.
   */
  const series: ChartSeries<Point>[] = [
    {
      key: chartKey,
      label,
      color: primaryColor,
      mark: 'line',
      getValue: (p) => p.bucket?.medianMs ?? null,
      formatValue: fmtMs,
      // The crosshair dot tracks the WORST cycle in the bucket, exactly as the per-point marker on
      // the line does. `getMarker` is the shipped seam for that — the dot used to be hand-placed
      // for this one reason, and losing the colour would have made the synced cursor say something
      // the mark under it does not.
      getMarker: (p) =>
        p.bucket !== null && p.bucket.maxLossPct > 0
          ? { color: lossColor(p.bucket.maxLossPct) }
          : null,
    },
    ...(overlay
      ? [
          {
            key: overlayKey,
            label: overlay.label,
            color: OVERLAY_COLOR,
            mark: 'line' as const,
            strokeWidth: VX.line2Width,
            getValue: (p: Point) => p.overlayMs,
            formatValue: fmtMs,
          },
        ]
      : []),
    // The loss markers, named. Two entries and not three: `lossColor(0)` returns the good token, but a
    // marker is only DRAWN when maxLossPct > 0, so a "No loss" swatch would name a mark this chart
    // never puts on a plot. (The tooltip's own Loss row does render that token at 0% — there it is a
    // value's swatch, not the marker legend, and it has a number beside it.)
    {
      key: 'loss-partial',
      label: 'Loss under 20%',
      color: VX.warnSolid,
      mark: 'bar',
      getValue: () => null,
    },
    {
      key: 'loss-heavy',
      label: 'Loss 20% or more',
      color: VX.badSolid,
      mark: 'bar',
      getValue: () => null,
    },
    // The full-loss band behind the line (the `alpha(VX.badSolid, 0.1–0.55)` rect keyed to
    // `downCycles`) had no legend entry at all — three distinct marks sharing one hue with only
    // two of them named. A lower, fixed `fillOpacity` distinguishes its washed-band swatch from
    // the solid dot swatches above, matching how the band itself reads against the loss dots.
    {
      key: 'down-band',
      label: 'Cycles fully down',
      color: VX.badSolid,
      mark: 'bar',
      fillOpacity: 0.3,
      getValue: () => null,
    },
    // `mark: 'line'`, not `'bar'` — the outage overlay is drawn as a thin rail along the top
    // edge, not a filled block, and sharing `loss-heavy`'s exact bar swatch made the two entries
    // byte-identical (same hue, same shape) with nothing to tell a reader which mark was which.
    ...(hasOutages
      ? [
          {
            key: 'outage',
            label: 'Recorded outage',
            color: VX.badSolid,
            mark: 'line' as const,
            getValue: () => null,
          },
        ]
      : []),
  ]

  // Measured for the x tick COUNT alone — see `speed-chart.tsx`'s identical wrapper. The default
  // (`smartTicks` at `VX.minPxPerTick`, 55) is sized for the bare `DD.MM` basalt's own formatter
  // produces, and `bucketTickFormat` draws `DD.MM HH:MM`; left to it, a 24 h window's ticks overlap
  // end to end. `VX.margin` is only a floor on the measured gutter now, so `plotWidth` slightly
  // OVER-estimates — absorbed by `AXIS_LABEL_PX`, which is already 96px for a ~72px label.
  const { ref: sizeRef, width } = useChartSize()
  // Observed on its own wrapper rather than the measuring div: `useChartSize`'s ref is a
  // CALLBACK ref of unpinned identity, and merging two callback refs inline would detach and
  // re-observe on every render. One layout-neutral div is the cheaper answer.
  const viewRef = useRef<HTMLDivElement>(null)
  const inView = useInViewport(viewRef)
  const plotWidth = Math.max(1, width - VX.margin.left - VX.margin.right)

  return (
    <div ref={viewRef}>
      <div ref={sizeRef}>
        <CartesianChart
          data={points}
          chartId={`latency-${chartKey}`}
          getX={getPointKey}
          series={series}
          // The envelope is part of the domain: `maxMs` is the only stored witness of a sub-cycle
          // stall (all four targets showing a worst RTT 8×+ their own median at zero loss), and a
          // domain sized to p95 alone would clip the very spikes it exists to show. The overlay's
          // values are folded in too — a router faster than the internet's p5 is a real, expected
          // reading, and sizing the axis off the primary alone would clip that line off the bottom.
          //
          // A FUNCTION rather than a tuple, because the function is handed the VISIBLE series: toggle
          // the band off in the legend and the axis rescales to the overlay instead of leaving a
          // permanent gap where the hidden series' spikes used to be.
          y={{
            domain: (data, visible) => [0, domainMax(data, visible, chartKey, overlayKey)],
            ticks: 4,
            format: fmtMs,
          }}
          xTicks={fitTickCount(
            points.length,
            Math.max(2, Math.floor(plotWidth / AXIS_LABEL_PX)),
            plotWidth,
          )}
          formatX={bucketTickFormat(bucketSeconds)}
          height={190}
          // The legend is unconditional, and the reason it used to be suppressed on the single-series
          // case no longer applies. It is not a caption restating the title any more — it is the only
          // place on the page that says what the red and amber dots mean. Those thresholds are an
          // ENCODING, and an encoding cannot live in the tooltip (which states one bucket's value,
          // not the rule) or in the guide drawer (which is a click away, which is why nobody found it
          // there).
          //
          // **Toggling is off, and not because it would not work.** Every entry here gates the mark
          // it names (`LatencyMarks` reads all six out of `ctx.visible`) and the y domain is a
          // function of the visible set, so a click would remove a mark and rescale the axis exactly
          // as the framework intends. It is off because this legend is a KEY first and a control
          // second: `ChartFrame` turns any legend of two or more entries into a toggle by default,
          // which on a chart whose legend explains its encoding invites a reader to hide the finding
          // they opened the page for. Same rule the compact-mode split already states — a section's
          // evidence may sit behind a named switch, a conclusion never may.
          // `getX` is a bucket's LEADING EDGE, so containment — not proximity — is what relates a
          // broadcast key to a column. It costs this chart nothing (it is unfolded, so every sibling
          // key it owns matches exactly) and is set anyway: the mode is a statement about what the
          // domain values MEAN, and a chart that declares it wrong stays wrong the day it folds.
          cursorResolution="leading"
          legend={{ toggle: false }}
          isPending={isPending}
          // Anchored to the crosshair rather than the pointer. Three charts on this page share one
          // cursor, and a tooltip that follows the mouse puts the primary band's numbers wherever the
          // hand happens to be while the strips below show the same instant at a fixed x — anchoring
          // lines all of them up on the column being read.
          tooltip={{
            follow: false,
            // Renders as a FOLLOWER too, not only as the cursor source. Before basalt-ui 1.15.0 this
            // directory drew a value chip on every synced sibling (`charts/synced-tip.tsx`); the
            // rebuild made tooltips source-only, so hovering any one chart moved a bare line across
            // the page and put numbers on exactly one of them. `onFollow` is the shipped answer and
            // every chart on this cursor opts in — the whole point of the shared cursor here is
            // reading four measurements of one instant at once.
            onFollow: inView,
            // The header states the calendar day and the badge the clock, because the header's own
            // formatter drops the time — right for a daily series, useless on a 5-minute grid.
            //
            // Both read `bucketStart`, never the domain key. Handing `fmtTooltipDate` a `Date`
            // takes its local-getter branch rather than its parse-a-string one, which is exactly the
            // day the axis and the badge name; formatting off the instant means the key never has to
            // be written in a particular zone to make the header come out right.
            formatHeader: (_key, p) => fmtTooltipDate(new Date(p.bucketStart)),
            label: (p) => ({ text: fmtClock(p.bucketStart), color: VX.legendText }),
            extraRows: (p) => (
              <>
                <BucketRows point={p} expectedCycles={expectedCycles} primaryColor={primaryColor} />
                <OutageRow point={p} outages={outages ?? []} bucketMs={bucketMs} windowTo={to} />
                {p.bucket !== null && renderExtraTooltipRows?.(p.bucket)}
                <VantageRows point={p} />
              </>
            ),
          }}
          ariaLabel={
            overlay
              ? `${label} latency with ${overlay.label} overlaid — median with p5 to p95 band, worst-ping envelope, and unmeasured periods marked${hasOutages ? ', with outages flagged' : ''}`
              : `${label} latency — median with p5 to p95 band, worst-ping envelope, and unmeasured periods marked${hasOutages ? ', with outages flagged' : ''}`
          }
        >
          {(ctx) => (
            <LatencyMarks
              ctx={ctx}
              chartKey={chartKey}
              overlayKey={overlayKey}
              bucketMs={bucketMs}
              outages={outages}
              windowTo={to}
            />
          )}
        </CartesianChart>
      </div>
    </div>
  )
}

/**
 * The top of the y domain: the highest thing any VISIBLE series can put on the plot, padded.
 *
 * Not `resolveAxisDomain`'s own `'auto'`, which reads `getValue` — and `getValue` is the MEDIAN.
 * A domain sized to the medians clips the band and the envelope drawn around them, which is most
 * of what this chart is.
 *
 * Exported for `latency-domain.test.ts`: this is the one piece of the collapsed chart that is not
 * the framework's, and whether it clips a spike is not observable in a render test.
 */
export function domainMax(
  data: readonly Point[],
  visible: readonly ChartSeries<Point>[],
  chartKey: string,
  overlayKey: string,
): number {
  const showPrimary = visible.some((s) => s.key === chartKey)
  const showOverlay = visible.some((s) => s.key === overlayKey)
  const values: number[] = []
  for (const p of data) {
    if (showPrimary && p.bucket !== null) {
      for (const v of [p.bucket.p95Ms, p.bucket.maxMs]) if (v !== null) values.push(v)
    }
    if (showOverlay && p.overlayMs !== null) values.push(p.overlayMs)
  }
  const max = values.length > 0 ? Math.max(...values) : 1
  return Math.max(1, max * 1.15)
}

/**
 * Everything this chart draws that no other chart does — and nothing else.
 *
 * Absence, the full-loss band, the outage rails, the worst-ping envelope, the p5–p95 area, the
 * median line, the overlay line, the loss markers and the vantage rail. The grid under them, the
 * axes around them, the crosshair, the dots, the overlay and the tooltip are `CartesianChart`'s.
 *
 * **Every colour is read back off `ctx.visible`, never off a local literal.** That is what makes a
 * legend swatch and its mark impossible to drift apart — the entry the legend renders and the
 * value this file strokes with are the same object — and it is what makes the legend's toggle
 * mean something: a series absent from `visible` draws nothing here.
 */
function LatencyMarks({
  ctx,
  chartKey,
  overlayKey,
  bucketMs,
  outages,
  windowTo,
}: {
  ctx: PlotContext<Point>
  chartKey: string
  overlayKey: string
  bucketMs: number
  outages?: readonly Outage[]
  windowTo: number
}) {
  // `LinePath`/`Area` take a mutable `data` array; `PlotContext.data` is `readonly` (the primitive
  // hands out its own array), so it is spread once here rather than cast away four times.
  const points = [...ctx.data]
  const { visible, xScale, yScale, xMax, yMax } = ctx
  const primary = visible.find((s) => s.key === chartKey)
  const overlaySeries = visible.find((s) => s.key === overlayKey)
  const showDownBand = visible.some((s) => s.key === 'down-band')
  const showOutages = visible.some((s) => s.key === 'outage')
  // Each loss threshold is gated on its OWN legend entry. They were one gate on `loss-partial`
  // alone, which drew both dot colours or neither and read `loss-heavy` nowhere at all — dormant
  // only because the legend does not toggle, and exactly the mark/legend disagreement this chart's
  // own history is about.
  const showLossPartial = visible.some((s) => s.key === 'loss-partial')
  const showLossHeavy = visible.some((s) => s.key === 'loss-heavy')

  const absentHatchId = `latency-${chartKey}-absent`
  const vantageHatchId = `latency-${chartKey}-vantage`
  const unknownHatchId = `latency-${chartKey}-unknown`

  const bandWidth = points.length > 1 ? xScale.step() : xMax
  const x = (p: Point): number => xScale(p.key) ?? Number.NaN
  /**
   * The two scale accessors, and the reason neither falls back to 0.
   *
   * `y` is called only for points a `defined` predicate already admitted, and `x` only for keys
   * taken from the scale's own domain, so in both the fallback is unreachable. It is NaN rather
   * than 0 deliberately: 0 is a real, plausible coordinate — a band edge pinned to the axis, a
   * marker stacked at the left margin — and drawing one is the unparseable→plausible-default
   * fabrication this project exists to prevent. NaN drops the mark visibly instead.
   */
  const y = (value: number | null): number => (value === null ? Number.NaN : yScale(value))

  /**
   * An arbitrary instant's x position, on a scale whose domain is ISO bucket-start STRINGS.
   *
   * There is no time→px path through `scalePoint`, but there does not need to be one:
   * `densifyBuckets` emits a uniform grid, so `points[i].bucketStart` is `points[0].bucketStart + i
   * * bucketMs` by construction and `xScale.step()` is the px per bucket. `xScale(points[0].key)`
   * is bucket 0's CENTRE, so the grid's left edge is that minus half a step, and everything after
   * is linear.
   *
   * This is the one mark on the chart whose x-extent is NOT quantised to a bucket, and that is the
   * point of computing it this way: an 80-second outage inside a 5-minute bucket draws 27% of a
   * column, which the full-loss band — snapped to bucket edges — structurally cannot express.
   *
   * Guarded on `points.length > 1`: `scalePoint.step()` on a one-element domain is degenerate, and
   * a mapping derived from it would place the rail somewhere arbitrary rather than fail visibly.
   */
  const gridFirst = points[0]?.bucketStart ?? 0
  const gridX0 = points[0] === undefined ? 0 : (xScale(points[0].key) ?? 0)
  const pxAt = (ms: number) => gridX0 - bandWidth / 2 + ((ms - gridFirst) / bucketMs) * bandWidth

  return (
    <>
      <defs>
        <HatchPattern id={absentHatchId} color={VX.neutral} />
        <HatchPattern id={vantageHatchId} color={VX.warnSolid} opacity={0.8} size={5} />
        <HatchPattern id={unknownHatchId} color={VX.neutral} opacity={0.8} size={5} />
      </defs>
      <Group>
        {/* Absence and full-loss are drawn FIRST, before anything decides whether there is a line
            to draw, so a bucket with nothing to plot still occupies pixels. */}
        {points.map((p) => {
          const left = x(p) - bandWidth / 2
          if (p.bucket === null) {
            return (
              <rect
                key={`absent-${p.key}`}
                x={left}
                y={0}
                width={bandWidth}
                height={yMax}
                fill={hatchFill(absentHatchId)}
              />
            )
          }
          if (!showDownBand || p.bucket.downCycles <= 0) return null
          // Opacity carries the measurement: the share of the bucket's cycles that got nothing
          // back. One blip in a 120-cycle hour is a faint tint; a bucket that was down throughout
          // is a solid band. A fixed opacity would make those two read the same.
          const downFraction = p.bucket.downCycles / Math.max(1, p.bucket.count)
          return (
            <rect
              key={`down-${p.key}`}
              x={left}
              y={0}
              width={bandWidth}
              height={yMax}
              fill={alpha(VX.badSolid, 0.1 + 0.45 * downFraction)}
            />
          )
        })}
        {showOutages &&
          points.length > 1 &&
          (outages ?? []).map((outage) => {
            // `GET /api/outages` filters on overlap, not containment, so an outage that began before
            // the window arrives whole and maps to a negative x. Clamp, never skip: a straddling
            // outage that vanishes is the recorded fact this overlay exists to show, silently
            // dropped.
            const left = Math.max(0, pxAt(outage.startedAt))
            const right = Math.min(xMax, pxAt(Math.min(outage.endedAt ?? windowTo, windowTo)))
            if (right - left <= 0) return null
            // At least one pixel: a sub-pixel outage drawn as nothing is indistinguishable from no outage.
            const railWidth = Math.max(1, right - left)
            return (
              <g key={`outage-${outage.id}`}>
                <rect x={left} y={0} width={railWidth} height={3} fill={VX.badSolid} />
                <rect x={left} y={0} width={1} height={yMax} fill={alpha(VX.badSolid, 0.5)} />
                <rect
                  x={Math.max(left, right - 1)}
                  y={0}
                  width={1}
                  height={yMax}
                  fill={alpha(VX.badSolid, 0.5)}
                />
              </g>
            )
          })}
        {primary !== undefined && (
          <>
            {/* The worst individual round trip in each bucket. Thin, unfilled and faint so it can
                never be mistaken for the p5–p95 band it encloses. */}
            <LinePath
              data={points}
              x={(p) => x(p)}
              y={(p) => y(p.bucket?.maxMs ?? null)}
              defined={(p) => p.bucket !== null && p.bucket.maxMs !== null}
              curve={curveMonotoneX}
              stroke={alpha(primary.color, 0.35)}
              strokeWidth={1}
              fill="none"
            />
            <Area
              data={points}
              x={(p) => x(p)}
              y0={(p) => y(p.bucket?.p95Ms ?? null)}
              y1={(p) => y(p.bucket?.p5Ms ?? null)}
              curve={curveMonotoneX}
              fill={alpha(primary.color, 0.14)}
              defined={isBanded}
            />
            <LinePath
              data={points}
              x={(p) => x(p)}
              y={(p) => y(p.bucket?.medianMs ?? null)}
              defined={(p) => p.bucket !== null && p.bucket.medianMs !== null}
              curve={curveMonotoneX}
              stroke={primary.color}
              // `lineWidth` (2.5), not `line2Width` (2). Both lines were drawn at the SECONDARY
              // weight, so the primary was ranked above the overlay by colour alone — and colour
              // alone is what the router overlay had already proved insufficient. Weight is the
              // second half of the same ranking, and the token pair is named for it.
              strokeWidth={primary.strokeWidth ?? VX.lineWidth}
            />
          </>
        )}
        {overlaySeries !== undefined && (
          // Plain reference line: no band, no p5/p95, no loss markers of its own — `defined` stops
          // it exactly at a null `overlayMs`, the same rule the primary median line follows, so an
          // unmeasured router cycle breaks the line rather than interpolating across it.
          <LinePath
            data={points}
            x={(p) => x(p)}
            y={(p) => y(p.overlayMs)}
            defined={(p) => p.overlayMs !== null}
            curve={curveMonotoneX}
            stroke={overlaySeries.color}
            strokeWidth={overlaySeries.strokeWidth ?? VX.line2Width}
          />
        )}
        {primary !== undefined &&
          points.map((p) => {
            const bucket = p.bucket
            if (bucket === null || bucket.maxLossPct <= 0 || bucket.medianMs === null) return null
            const heavy = bucket.maxLossPct >= HEAVY_LOSS_PCT
            if (heavy ? !showLossHeavy : !showLossPartial) return null
            return (
              <circle
                key={p.key}
                cx={x(p)}
                cy={yScale(bucket.medianMs)}
                r={3}
                fill={lossColor(bucket.maxLossPct)}
              />
            )
          })}
        {/* The vantage rail. `all` is the only verdict that claims the whole bucket measured this
            line, so everything else gets marked — `unknown` in neutral, since an unreported
            vantage is not evidence of a failover either. */}
        {points.map((p) =>
          p.vantage !== null && p.vantage.onHomeLine !== 'all' ? (
            <rect
              key={`vantage-${p.key}`}
              x={x(p) - bandWidth / 2}
              y={yMax - RAIL_H}
              width={bandWidth}
              height={RAIL_H}
              fill={hatchFill(p.vantage.onHomeLine === 'unknown' ? unknownHatchId : vantageHatchId)}
            />
          ) : null,
        )}
      </Group>
    </>
  )
}

/** All three band edges, not just the median. They come from one `GROUP BY` in one CTE today, so
 * they are all-null or all-non-null together and this cannot currently split them — but the Area
 * used to coalesce a missing edge to 0, and a band edge silently pinned to the axis is a
 * fabrication that would ship the moment the percentile SQL changes. */
function isBanded(p: Point): boolean {
  const b = p.bucket
  return b !== null && b.medianMs !== null && b.p5Ms !== null && b.p95Ms !== null
}

function BucketRows({
  point,
  expectedCycles,
  primaryColor,
}: {
  point: Point
  expectedCycles: number
  primaryColor: string
}) {
  const bucket = point.bucket
  if (bucket === null) {
    return (
      <TooltipRow
        color={VX.neutral}
        label="Not measured"
        value={`0 of ${expectedCycles} expected cycles`}
        shape="bar"
      />
    )
  }

  return (
    <>
      {/* No "Median" row. `CartesianChart` DERIVES one from the primary series — labelled with the
          series' own name, the same word the legend uses for the same mark — and its `getValue` is
          the median, so authoring one here printed the number twice under two different names. The
          rows below are the ones no series carries: a band, an envelope, two loss shares and the
          cycle counts behind them. */}
      <TooltipRow
        color={primaryColor}
        label="p5 – p95"
        value={`${fmtMs(bucket.p5Ms)} – ${fmtMs(bucket.p95Ms)}`}
        shape="line"
        dashed
      />
      {/* The envelope's own row: the slowest single round trip in the bucket, which is the only
          stored trace of a stall lasting less than one cycle. */}
      <TooltipRow
        color={alpha(primaryColor, 0.35)}
        label="Worst ping"
        value={fmtMs(bucket.maxMs)}
        shape="line"
      />
      <TooltipRow
        color={lossColor(bucket.lossPct)}
        label="Loss"
        value={fmtPct(bucket.lossPct)}
        shape="dot"
      />
      {/* The marker colour tracks the worst cycle, so name it — labelling it "Loss" made a
          one-blip hour read as a 100%-loss hour. */}
      <TooltipRow
        color={lossColor(bucket.maxLossPct)}
        label="Worst cycle"
        value={fmtPct(bucket.maxLossPct)}
        shape="dot"
      />
      {bucket.downCycles > 0 && (
        <TooltipRow
          color={VX.badSolid}
          label="Cycles fully down"
          value={String(bucket.downCycles)}
          shape="bar"
        />
      )}
      <TooltipRow
        color={VX.neutral}
        label="Measured"
        value={`${bucket.count} of ${expectedCycles} expected cycles`}
        shape="bar"
      />
    </>
  )
}

/** The overlaid outage rows the hovered bucket sits inside, named on the bucket that draws them. A
 * mark on a chart with no tooltip row behind it is the same unexplained-encoding defect the loss
 * dots had. One row whatever the count: two outages inside one bucket is a fact about the bucket,
 * not two facts. */
function OutageRow({
  point,
  outages,
  bucketMs,
  windowTo,
}: {
  point: Point
  outages: readonly Outage[]
  bucketMs: number
  windowTo: number
}) {
  const end = point.bucketStart + bucketMs
  const hits = outages.filter(
    (o) => o.startedAt < end && Math.min(o.endedAt ?? windowTo, windowTo) > point.bucketStart,
  )
  if (hits.length === 0) return null
  const value =
    hits.length > 1
      ? `${hits.length} recorded`
      : hits[0]!.endedAt === null
        ? 'ongoing'
        : fmtDuration(
            hits[0]!.durationS ?? Math.round((hits[0]!.endedAt - hits[0]!.startedAt) / 1000),
          )
  return <TooltipRow color={VX.badSolid} shape="bar" label="Recorded outage" value={value} />
}

/**
 * The rail's swatch, matching the rail. Three colours, not two.
 *
 * `all` is the only verdict that claims the whole bucket measured this line, so it is the only
 * green one — but `unknown` is NOT the same reading as `none`/`mixed`, and this row used to paint
 * both amber. The chart itself has always distinguished them: the rail draws `unknown` through
 * `unknownHatchId` in `VX.neutral`, on the stated grounds that an unreported vantage is not
 * evidence of a failover either. The tooltip is the only place a reader is told what the rail
 * means, and it was contradicting it — naming a neutral mark as a warning.
 *
 * This is one of the rows nobody had ever seen. `ChartTooltip` rendered a plain `<div>` inside
 * `<svg>`, where React creates it in the SVG namespace and the browser paints nothing; the portal
 * added in basalt-ui 1.9.0 is what makes this chart's tooltip visible at all, and the disagreement
 * only became reviewable once it was.
 */
function vantageColor(verdict: HomeLineVerdict): string {
  if (verdict === 'all') return VX.goodSolid
  if (verdict === 'unknown') return VX.neutral
  return VX.warnSolid
}

function VantageRows({ point }: { point: Point }) {
  const vantage = point.vantage
  if (vantage === null) return null

  return (
    <>
      <TooltipRow
        color={vantageColor(vantage.onHomeLine)}
        label="Vantage"
        value={HOME_LINE_LABEL[vantage.onHomeLine]}
        shape="bar"
      />
      {vantage.unknownHomeLineCycles > 0 && (
        <TooltipRow
          color={VX.neutral}
          label="Cycles with no vantage"
          value={String(vantage.unknownHomeLineCycles)}
          shape="bar"
        />
      )}
    </>
  )
}

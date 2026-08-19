import { useCallback, useMemo, useRef } from 'react'
import { scaleBand, scaleLinear } from '@visx/scale'
import {
  AxisBottomDate,
  AxisLeftNumeric,
  ChartFrame,
  ChartTooltipFloat,
  Crosshair,
  HoverOverlay,
  type SeriesStyle,
  TooltipBody,
  TooltipHeader,
  TooltipRow,
  VX,
  alpha,
  useChartCursor,
} from 'basalt-ui/charts'
import { tooltipAnchor } from './follower-anchor'
import { useInViewport } from './use-in-viewport'
import type { ProbeBucketSeconds, ThroughputBucket } from '../lib/types'
import { throughputPoints, type ThroughputPoint } from '../lib/throughput'
import { fmtBytes, fmtDateTime, fmtRate } from '../lib/format'
import { AXIS_LABEL_PX, axisTickValues, bucketTickFormat } from '../lib/axis'
import { HatchPattern, hatchFill } from './hatch'

// 180, not 240. This is a two-sided bar chart with three y ticks per half and no line to trace,
// so the extra 60 px bought no resolution — it bought a section that pushed the one below it off
// the fold on a laptop. The dashboard's other full-width plot (the latency band, which does have a
// curve worth the pixels) is 190.
const CHART_HEIGHT = 180
const AXIS_HEIGHT = 22
/** The one-row legend band reserved out of `ChartFrame`'s height — see `availability-strip.tsx`'s
 * identical constant. */
const LEGEND_BAND = 24
/**
 * Room for this chart's y labels, which are rates rather than plain numbers: `fmtRate` produces
 * `1.0 MB/s` and `400 kB/s`, eight characters at the 11 px axis font. At 56 px the widest of them
 * rendered with its leading character cut off by the SVG's left edge — and a clipped rate label is
 * worse than a missing one, because `.0 MB/s` still reads as a number.
 */
const LEFT_GUTTER = 72

/**
 * The mirror of `LEFT_GUTTER` on the right, which this chart never got and the two strips did.
 * `AxisBottomDate` centres its label on the tick, so a tick at the final index put half a label
 * outside the SVG, where ChartCard's overflow clipped it — at every viewport width, not just narrow
 * ones. Half a label width is exactly what a centred label needs.
 *
 * This stays the CEILING, not the drawn inset — `MirroredBars`' own `plotRight` scales it down at
 * narrow widths, the same way the two strips' `PLOT_LEFT`/`PLOT_RIGHT` already do.
 */
const PLOT_RIGHT = Math.round(AXIS_LABEL_PX / 2)

/**
 * The three marks this chart draws, declared once.
 *
 * The legend used to be a hand-written array literal beside a set of `fill=` expressions that
 * repeated the same three tokens — so a retuned download hue moved the bars and left the legend
 * swatch behind, and nothing would have caught it. `ChartFrame` derives the legend from this array
 * (`deriveLegend` internally) and the drawing code reads its colours from the same place: one edit
 * moves both. `basalt/chart-legend-literal` is the rule that now makes the old shape a build
 * failure rather than a convention.
 *
 * "Not measured" is a series here in the legend's sense but not in the data's — it has no values,
 * only an absence, which is why it carries no `getValue`. It has to be named on the legend all the
 * same: a hatched column is the one mark on this chart a reader cannot decode from the axes.
 */
const THROUGHPUT_SERIES: SeriesStyle[] = [
  { key: 'down', label: 'Download', color: VX.accent, mark: 'bar' },
  // `VX.line2` (`#a1a1aa`, 5.5:1 against the panel) — the MID grey, not `VX.line` (`#e4e4e7`,
  // 11.1:1), which is the brightest thing available on a dark panel and as a dense mass of bars
  // out-shouted the accent this chart's download half is drawn in. Three earlier answers were
  // worse: `VX.status.bad` drew ordinary outbound traffic as a fault, `VX.line` sat 6% in luminance
  // from the never-measured grey, and a registered teal series separated cleanly but read as loud
  // as the red had. Blue against a mid grey is the calm version, and it needs no series row —
  // never-measured stays the light grey above it AND is hatched, so all three are distinct.
  { key: 'up', label: 'Upload', color: VX.line2, mark: 'bar' },
  { key: 'absent', label: 'Not measured', color: VX.neutral, mark: 'bar' },
]

const DOWN_COLOR = THROUGHPUT_SERIES[0]!.color
const UP_COLOR = THROUGHPUT_SERIES[1]!.color
const ABSENT_COLOR = THROUGHPUT_SERIES[2]!.color

/** A drawn point, after folding. `foldedFrom` is 1 for a point drawn straight from the response and
 * >1 when it stands in for that many source buckets — see `foldPoints`. `unmeasuredMembers` is how
 * many of those source buckets had no rate at all (`downBytesPerS === null`) — `spanMs > 0` on the
 * folded sum only says at least ONE member measured, not all of them, and `MirroredBars` needs the
 * count to avoid drawing the folded span as though it were uniformly measured. */
type PlotPoint = ThroughputPoint & { foldedFrom: number; unmeasuredMembers: number }

/**
 * Aggregates points down to at most `cap` slots — the same sub-pixel pitch problem the two strips
 * fix. SUM, not mean: bytes are additive across a folded span (unlike the loss/link fields the
 * strips fold), so the folded rate is recomputed from summed bytes over summed measured time
 * (`spanMs`), never from averaging the per-slot rates — a fold that divides by the WRONG
 * denominator is exactly the bug `throughputPoints`'s own docblock records fixing once already.
 * `intervals`/`skipped` also sum, so the folded column's own "Measured"/"Understated" rows stay
 * honest about how many source intervals stand behind it.
 *
 * `spanMs > 0` after summing only takes ONE measured member — `[measured, absent, absent]` sums to
 * a positive `spanMs` and a real rate, which used to make the whole folded bar solid. That rate is
 * not wrong (it is the true rate over the time that WAS measured), but drawing it across the full
 * column width claims the other two-thirds of the span agreed, which they never reported either
 * way. `unmeasuredMembers` is what lets `MirroredBars` hatch that share instead.
 */
export function foldPoints(points: ThroughputPoint[], cap: number): PlotPoint[] {
  if (cap <= 0) return []
  if (points.length <= cap)
    return points.map((p) => ({
      ...p,
      foldedFrom: 1,
      unmeasuredMembers: p.downBytesPerS === null ? 1 : 0,
    }))

  const groupSize = Math.ceil(points.length / cap)
  const folded: PlotPoint[] = []
  for (let i = 0; i < points.length; i += groupSize) {
    const group = points.slice(i, i + groupSize)
    const first = group[0]
    if (first === undefined) continue
    const downBytes = group.reduce((sum, p) => sum + p.downBytes, 0)
    const upBytes = group.reduce((sum, p) => sum + p.upBytes, 0)
    const spanMs = group.reduce((sum, p) => sum + p.spanMs, 0)
    const intervals = group.reduce((sum, p) => sum + p.intervals, 0)
    const skipped = group.reduce((sum, p) => sum + p.skipped, 0)
    const unmeasuredMembers = group.filter((p) => p.downBytesPerS === null).length
    folded.push({
      ...first,
      downBytes,
      upBytes,
      spanMs,
      intervals,
      skipped,
      downBytesPerS: spanMs > 0 ? downBytes / (spanMs / 1000) : null,
      upBytesPerS: spanMs > 0 ? upBytes / (spanMs / 1000) : null,
      foldedFrom: group.length,
      unmeasuredMembers,
    })
  }
  return folded
}

/** Stable across renders — see `availability-strip.tsx`'s identical constant. */
const getPointKey = (p: PlotPoint): string => p.key

/**
 * Down and up on one mirrored axis: download below the baseline, upload above it.
 *
 * Two series on a shared positive axis would put a 220 kB/s download and a 20 kB/s upload on the
 * same scale, which flattens the upload to a line along the floor — and upload is the half that
 * actually explains a stalled video call. Mirroring gives each direction the full height of its own
 * half and makes the *ratio* legible at a glance, which is the thing a household actually reads
 * this for. Each half is scaled independently for the same reason.
 *
 * **This is not the speed chart and must never be read as one.** The speed tests measure what the
 * line *can* carry when asked; this measures what it *did* carry. A quiet night reads as near-zero
 * here and says nothing whatever about capacity.
 *
 * Bars rather than a filled area, deliberately. An area interpolates between buckets, and this
 * dashboard's whole discipline is that an unmeasured bucket must not be joined to its neighbours by
 * a smooth line. At the densities these ranges produce (24–180 columns) bars read as an area anyway,
 * and they can carry the hatch that a curve cannot.
 *
 * **`isPending` is the fourth state this chart has to draw, and it used to have no shape at all.**
 * `buckets={throughput?.buckets ?? []}` densifies to an all-null window regardless of whether the
 * query behind it has even landed — `throughputQuery` is not in the route loader, and a range
 * change discards `keepAcrossTimeAdvance`'s placeholder the moment the span changes — so the chart
 * was reachable, on every cold load and every range change, drawing exactly the shape the FOUNDING
 * RULE forbids: a fully-hatched band asserting the whole window was watched and held nothing. This
 * prop, and the `ChartPending` it renders in place of `MirroredBars`/`ChartLegend`, is that fix —
 * the same `isPending` idiom `OutageTable`/`TransitionTimeline` already use for their own queries.
 *
 * Both halves are the framework's now. `ChartFrame` reserves the plot, renders `ChartPending` in
 * place of the marks, drops the legend and sets `aria-busy` — so the app-side `PendingChart` and
 * the local `!isPending &&` guard around the legend are both gone, and there is one pending
 * renderer on the page rather than one per chart.
 */
export function ThroughputChart({
  buckets,
  from,
  to,
  bucketSeconds,
  isPending,
}: {
  buckets: readonly ThroughputBucket[]
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
  /** True while the throughput query for this window is in flight — see the component docblock. */
  isPending?: boolean
}) {
  const points = useMemo(
    () => throughputPoints(buckets, { from, to, bucketSeconds }),
    [buckets, from, to, bucketSeconds],
  )

  return (
    // A floor, not a height — see `availability-strip.tsx`'s identical wrapper.
    <div style={{ minHeight: CHART_HEIGHT + AXIS_HEIGHT + LEGEND_BAND }}>
      <ChartFrame
        series={THROUGHPUT_SERIES}
        chartId="throughput"
        height={CHART_HEIGHT + AXIS_HEIGHT + LEGEND_BAND}
        isPending={isPending === true}
        ariaLabel="Data carried per bucket — download below the baseline, upload above it, with unmeasured buckets marked"
        // "Not measured" is a hatch, not a series with values, so a three-entry toggle would offer
        // to hide a state rather than a measurement. The two real halves are scaled independently
        // and drawn against one baseline; hiding one would leave the other reading against an axis
        // that no longer has an opposite.
        legend={{ toggle: false }}
      >
        {({ width, height }) => (
          <MirroredBars
            points={points}
            bucketSeconds={bucketSeconds}
            width={width}
            height={height}
          />
        )}
      </ChartFrame>
    </div>
  )
}

function MirroredBars({
  points,
  bucketSeconds,
  width,
  height,
}: {
  points: ThroughputPoint[]
  bucketSeconds: ProbeBucketSeconds
  width: number
  /** The plot rect `ChartFrame` handed down — already net of the measured legend band. */
  height: number
}) {
  const absentHatchId = 'throughput-absent'
  // The bar band, derived from the rect rather than the constant, so a legend that wraps to two
  // rows on a phone takes its pixels from the bars instead of being drawn over by them.
  const barBand = Math.max(2, height - AXIS_HEIGHT)

  // `plotRight` scales down at narrow widths the same way the two strips' `plotLeft`/`plotRight`
  // already do — `PLOT_RIGHT` unscaled left the least room of any of the three charts (it does not
  // even get the strips' width-relative floor), which is why this one's fold hit sub-pixel columns
  // hardest. `LEFT_GUTTER` stays fixed: unlike a half-label inset it is sized to the y-axis rate
  // text itself, and shrinking it risks reintroducing the clipped-label bug the constant's own
  // docblock records fixing.
  const plotRight = Math.min(PLOT_RIGHT, Math.round(width * 0.12))
  const plotWidth = Math.max(0, width - LEFT_GUTTER - plotRight)
  // `/ 3`, not `/ 2` — see `availability-strip.tsx`'s identical constant for why the wider margin
  // is needed: a `/ 2` cap leaves no room for a partial fold's fill/hatch split to render as two
  // visibly distinct pieces.
  const plotPoints = useMemo(
    () => foldPoints(points, Math.floor(plotWidth / 3)),
    [points, plotWidth],
  )
  // Memoized — see `availability-strip.tsx`'s identical `keys`/`scale`.
  const keys = useMemo(() => plotPoints.map((p) => p.key), [plotPoints])
  const xScale = useMemo(
    () => scaleBand<string>({ domain: keys, range: [0, plotWidth] }),
    [keys, plotWidth],
  )
  const bandCenter = useCallback(
    (key: string) => {
      const v = xScale(key)
      return v === undefined ? undefined : v + xScale.bandwidth() / 2
    },
    [xScale],
  )

  // No fold seam any more — see `availability-strip.tsx`'s identical call, including why the
  // resolution mode is `'leading'` rather than the default: `getKey` returns a bucket's LEADING
  // EDGE, so containment is the relation that means anything here, and nearest put a follower's
  // crosshair one column right for every source bucket in the back half of a folded group.
  const cursor = useChartCursor<PlotPoint>({
    data: plotPoints,
    chartId: 'throughput',
    getKey: getPointKey,
    xScale: bandCenter,
    resolution: 'leading',
    marginLeft: LEFT_GUTTER,
  })
  const point = cursor.point
  // Own `<svg>`, so the follower tooltip's viewport position has to be measured off it —
  // see `tooltipAnchor`.
  const svgRef = useRef<SVGSVGElement>(null)
  const inView = useInViewport(svgRef)

  // Each half scaled independently — see the component docblock. `|| 1` keeps a window with no
  // traffic at all from producing a zero-width domain, which renders as NaN geometry.
  const maxDown = Math.max(...plotPoints.map((p) => p.downBytesPerS ?? 0), 0) || 1
  const maxUp = Math.max(...plotPoints.map((p) => p.upBytesPerS ?? 0), 0) || 1
  // Upload gets the smaller half: on a household line it is an order of magnitude below download,
  // and splitting the height evenly would waste most of the chart on empty space above the upload.
  const upHeight = Math.round(barBand * 0.35)
  const downHeight = barBand - upHeight
  const baseline = upHeight

  const downScale = scaleLinear<number>({ domain: [0, maxDown], range: [0, downHeight] })
  const upScale = scaleLinear<number>({ domain: [0, maxUp], range: [0, upHeight] })

  if (width < 60 || plotPoints.length === 0) return null

  const step = plotWidth / plotPoints.length
  const barWidth = Math.max(step - 1, 1)
  // See `availability-strip.tsx`'s identical constant — the hatch repeat shrunk to fit the column
  // rather than left at a fixed size a narrow bar cannot show even one full diagonal rule of.
  const hatchSize = Math.max(2, Math.min(5, Math.round(barWidth)))

  return (
    <>
      <svg ref={svgRef} width={width} height={height}>
        <defs>
          <HatchPattern id={absentHatchId} color={ABSENT_COLOR} opacity={0.7} size={hatchSize} />
        </defs>
        <g transform={`translate(${LEFT_GUTTER}, 0)`}>
          {/* One axis per half, each in its own scale's units, because the halves are scaled
              independently — a single shared axis would be wrong for at least one of them. Both sit
              inside this group so their ticks extend left into the gutter rather than off-canvas.

              theme-allow — declared non-single-plot. This is two panes, not one: download and
              upload are scaled INDEPENDENTLY against a shared baseline (see the component
              docblock), so the chart has two y scales stacked vertically rather than one plot rect
              with one or two numeric axes. `CartesianChart` cannot express that; `DualPanel` is the
              shipped kind of the same shape and composes `ChartFrame` for the same reason.
              Everything below the marks is the shipped primitive, assembled not re-implemented. */}
          <AxisLeftNumeric
            scale={scaleLinear<number>({ domain: [maxUp, 0], range: [0, upHeight] })}
            numTicks={2}
            tickFormat={(v) => fmtRate(Number(v))}
          />
          <g transform={`translate(0, ${baseline})`}>
            <AxisLeftNumeric
              scale={scaleLinear<number>({ domain: [0, maxDown], range: [0, downHeight] })}
              numTicks={3}
              tickFormat={(v) => fmtRate(Number(v))}
            />
          </g>
          {plotPoints.map((p, i) => {
            const x = i * step
            if (p.downBytesPerS === null || p.upBytesPerS === null) {
              // Absence spans the whole height rather than sitting on the baseline: a hatch drawn
              // only on the download half would read as "downloaded nothing, uploaded nothing",
              // which is the measured-and-idle state this must be distinguishable from.
              return (
                <rect
                  key={p.key}
                  x={x}
                  y={0}
                  width={barWidth}
                  height={barBand}
                  fill={hatchFill(absentHatchId)}
                  pointerEvents="none"
                />
              )
            }

            const downPx = downScale(p.downBytesPerS)
            const upPx = upScale(p.upBytesPerS)
            // A partial bucket is drawn at reduced opacity and named in the tooltip. It is a real
            // measurement — just a short one — so dimming is the right weight: visible enough not
            // to be read as complete, not so loud as to be read as a fault.
            const opacity = p.skipped > 0 ? 0.45 : 1
            // `spanMs > 0` after folding only takes ONE measured member, so `p.downBytesPerS`
            // can be a real rate while a share of the folded span reported nothing — see
            // `foldPoints`'s docblock. That share is hatched at full column height, the same
            // "spans the whole height" rule the fully-unmeasured branch above already uses, rather
            // than letting the bars imply the whole width agreed with a rate only part of it set.
            const unmeasuredFrac = p.unmeasuredMembers / p.foldedFrom
            const measuredWidth = barWidth * (1 - unmeasuredFrac)
            const hatchWidth = barWidth - measuredWidth

            return (
              <g key={p.key}>
                {measuredWidth > 0 && (
                  <>
                    <rect
                      x={x}
                      y={baseline - upPx}
                      width={measuredWidth}
                      height={Math.max(upPx, p.upBytesPerS > 0 ? 1 : 0)}
                      fill={alpha(UP_COLOR, opacity)}
                      pointerEvents="none"
                    />
                    <rect
                      x={x}
                      y={baseline}
                      width={measuredWidth}
                      height={Math.max(downPx, p.downBytesPerS > 0 ? 1 : 0)}
                      fill={alpha(DOWN_COLOR, opacity)}
                      pointerEvents="none"
                    />
                  </>
                )}
                {hatchWidth > 0 && (
                  <rect
                    x={x + measuredWidth}
                    y={0}
                    width={hatchWidth}
                    height={barBand}
                    fill={hatchFill(absentHatchId)}
                    pointerEvents="none"
                  />
                )}
              </g>
            )
          })}
          <line
            x1={0}
            y1={baseline}
            x2={plotWidth}
            y2={baseline}
            stroke={VX.axisStroke}
            strokeWidth={1}
          />
          {/* The tick VALUES are ISO bucket starts (the scale's domain); `bucketTickFormat` renders
              each as the time a reader sees — see `lib/axis.ts`. */}
          <AxisBottomDate
            scale={xScale}
            top={barBand}
            tickValues={axisTickValues(keys, plotWidth, AXIS_LABEL_PX)}
            tickFormat={bucketTickFormat(bucketSeconds)}
          />
          {point && (
            <Crosshair
              x={(xScale(point.key) ?? 0) + xScale.bandwidth() / 2}
              top={0}
              bottom={barBand}
            />
          )}
          <HoverOverlay
            width={plotWidth}
            height={barBand}
            onMove={cursor.onPointerMove}
            onLeave={cursor.onPointerLeave}
            onKeyDown={cursor.onKeyDown}
            onBlur={cursor.onBlur}
            // `CartesianChart` forwards its own `ariaLabel` to the overlay so the focusable slider
            // announces the chart rather than a generic "Chart data". A hand-composed plot has to
            // do it itself, or tabbing into it says nothing about which chart was reached.
            ariaLabel="Data carried per bucket — download below the baseline, upload above it"
            valueMax={Math.max(plotPoints.length - 1, 0)}
            {...(point !== null && {
              valueNow: plotPoints.indexOf(point),
              valueText: bucketTickFormat(bucketSeconds)(point.key),
            })}
          />
        </g>
      </svg>
      {/* Source-only, like every other chart now — the follower chip this chart used to draw went
          with `ChartTooltip`; see `availability-strip.tsx`. */}
      <ChartTooltipFloat
        anchor={tooltipAnchor({
          isSource: cursor.isSource,
          inView,
          ownAnchor: cursor.anchor,
          svg: svgRef.current,
          marginLeft: LEFT_GUTTER,
          crosshairX: point ? (xScale(point.key) ?? 0) + xScale.bandwidth() / 2 : null,
        })}
        // Followers stay silent. `ChartTooltipFloat` is `aria-live` by default, which is right for
        // the one tooltip a pointer produced and wrong for the three that appear beside it — four
        // live regions announcing on every cursor move makes the page unusable with a screen
        // reader. Same split `CartesianChart` makes for `onFollow`; a hand-composed chart has to
        // make it itself.
        ariaLive={cursor.isSource}
      >
        {point && <PointRows point={point} />}
      </ChartTooltipFloat>
    </>
  )
}

function PointRows({ point }: { point: PlotPoint }) {
  return (
    <>
      <TooltipHeader date={fmtDateTime(point.bucketStart)} label="Carried" labelColor={VX.accent} />
      <TooltipBody>
        {point.downBytesPerS === null ? (
          <TooltipRow
            color={VX.neutral}
            shape="bar"
            label="Not measured"
            value="no usable interval"
          />
        ) : (
          <>
            <TooltipRow
              color={VX.accent}
              shape="bar"
              label="Down"
              value={`${fmtRate(point.downBytesPerS)} · ${fmtBytes(point.downBytes)}`}
            />
            <TooltipRow
              color={VX.line2}
              shape="bar"
              label="Up"
              value={`${fmtRate(point.upBytesPerS)} · ${fmtBytes(point.upBytes)}`}
            />
            {/* The basis, always — the rate is bytes over *measured* time, and a bucket that
                measured 2 of 20 intervals is a different claim from one that measured all 20. */}
            <TooltipRow
              color={VX.neutral}
              shape="bar"
              label="Measured"
              value={`${point.intervals} interval${point.intervals === 1 ? '' : 's'} · ${Math.round(point.spanMs / 1000)}s`}
            />
            {point.skipped > 0 && (
              <TooltipRow
                color={VX.status.warn}
                shape="dot"
                label="Understated"
                value={`${point.skipped} interval${point.skipped === 1 ? '' : 's'} unplaceable`}
              />
            )}
          </>
        )}
        {point.foldedFrom > 1 && (
          <TooltipRow
            color={VX.neutral}
            shape="bar"
            label="Folded from"
            value={
              point.unmeasuredMembers > 0 && point.unmeasuredMembers < point.foldedFrom
                ? `${point.foldedFrom} buckets, ${point.unmeasuredMembers} not measured`
                : `${point.foldedFrom} buckets`
            }
          />
        )}
      </TooltipBody>
    </>
  )
}

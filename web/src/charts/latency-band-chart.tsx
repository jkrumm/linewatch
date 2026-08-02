import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Area } from '@visx/shape'
import { scaleLinear, scalePoint } from '@visx/scale'
import {
  AxisBottomDate,
  AxisLeftNumeric,
  ChartFrame,
  ChartTooltip,
  Crosshair,
  Group,
  GridRows,
  HoverOverlay,
  LinePath,
  SeriesDot,
  TooltipBody,
  TooltipHeader,
  TooltipRow,
  VX,
  alpha,
  curveMonotoneX,
  fmtTooltipDate,
  useHoverSync,
  useTooltipStyles,
} from 'basalt-ui/charts'
import type { HomeLineVerdict, ProbeBucket, ProbeBucketSeconds, VantageBucket } from '../lib/types'
import { densifyBuckets } from '../lib/densify'
import { axisTickValues, bucketAxisLabel } from '../lib/axis'
import { PROBE_CYCLE_MS } from '../lib/range'
import { fmtMs, fmtPct } from '../lib/format'
import { HatchPattern, hatchFill } from './hatch'

/** One position on the time axis. `bucket === null` is a bucket the range route returned no row
 * for: unmeasured, which the chart must draw as its own state rather than as a gap the curve
 * smooths over. `vantage` is the parallel per-bucket record of what those cycles measured
 * *through* — null when the bucket held no cycles at all. `overlayMs` is the second, band-less
 * median: always present on the point (null when there is no `overlay` prop, or the overlay's own
 * bucket at this slot has none), so the drawing code never has to ask the point "does an overlay
 * exist" separately from "what is its value here". */
type Point = {
  /** ISO-8601 of the bucket start — the instant, used by the tooltip's own date formatting. */
  key: string
  /**
   * The display label for this bucket, and the x-scale's domain value.
   *
   * Separate from `key` because `AxisBottomDate` accepts no `tickFormat` and renders whatever the
   * scale's domain holds through basalt's `fmtAxisDate`, which reduces an ISO string to `DD.MM` —
   * a 24 h window drew `01.08` a dozen times across the bottom of the page's primary latency
   * chart. `fmtAxisDate` passes a non-ISO string through untouched, so a pre-formatted label is
   * the only way to reach that axis. `bucketAxisLabel` guarantees it is unique per bucket, which
   * the point scale requires: two buckets sharing a domain value collapse onto one x position and
   * one of them stops being drawn.
   */
  label: string
  bucket: ProbeBucket | null
  vantage: VantageBucket | null
  overlayMs: number | null
}

/** Restatements of the four `HomeLineVerdict` values, not judgements about them. Only `all`
 * claims the whole bucket; the other three each mean the bucket's latency describes something
 * other than (or not provably) this line. */
const HOME_LINE_LABEL: Record<HomeLineVerdict, string> = {
  all: 'Home line',
  none: 'Not the home line',
  mixed: 'Mixed paths',
  unknown: 'Not reported',
}

/** The *Solid* variants, not `VX.good`/`VX.warn`/`VX.bad`: those are area-fill tokens mixed down to
 * 18% / 8% / 18% opacity (`tokens.css`), which is right behind a line and invisible on a 3 px
 * marker. A loss marker has to read at a glance or it is not a warning. */
function lossColor(lossPct: number): string {
  if (lossPct <= 0) return VX.goodSolid
  if (lossPct < 20) return VX.warnSolid
  return VX.badSolid
}

/** Height of the vantage rail along the bottom axis, in px. */
const RAIL_H = 5

/**
 * The SmokePing-style signature chart (DESIGN.md's "Latency" view): a median line with a shaded
 * p5–p95 band, loss encoded as marker color. Genuinely unique (a band between two arbitrary
 * series, per-point loss markers) so it's bespoke rather than a shipped kind — composes the visx
 * primitives directly, per the visx-charts rule's "stay bespoke" guidance.
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
 * router". It draws in `VX.line` and pushes the primary series to `VX.accent` (only when an
 * overlay is present — with none, colors are exactly what they were before this prop existed), the
 * same pairing `latency-compare-chart.tsx` and `speed-chart.tsx` use for a router/internet pair.
 */
export function LatencyBandChart({
  label,
  chartKey,
  buckets,
  vantage,
  from,
  to,
  bucketSeconds,
  overlay,
  renderExtraTooltipRows,
}: {
  /** How the primary series is named in the legend, tooltip and accessible label. */
  label: string
  /** Stable identity for the hover-sync/chart id — must be unique per mounted instance. */
  chartKey: string
  buckets: ProbeBucket[]
  vantage: VantageBucket[]
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
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
      label: bucketAxisLabel(slot.bucketStart, bucketSeconds),
      bucket: slot.value,
      vantage: vantageByBucket.get(slot.bucketStart) ?? null,
      overlayMs: overlayByBucket?.get(slot.bucketStart) ?? null,
    }))
  }, [buckets, vantage, overlay, from, to, bucketSeconds])

  // What the collector's cadence should have produced in one bucket. Named "expected" wherever it
  // is shown, because it is arithmetic over the configured cadence, not a count of anything.
  const expectedCycles = Math.max(1, Math.round((bucketSeconds * 1000) / PROBE_CYCLE_MS))

  // See the component docblock: the primary only moves off `VX.line` when there is a second line
  // to distinguish it from.
  const primaryColor = overlay ? VX.accent : VX.line

  return (
    <ChartFrame
      series={[
        { key: chartKey, label, color: primaryColor, mark: 'line' },
        ...(overlay
          ? [{ key: `${chartKey}-overlay`, label: overlay.label, color: VX.line, mark: 'line' as const }]
          : []),
      ]}
      height={190}
      chartId={`latency-${chartKey}`}
      // A legend for one series is a caption restating the card title; for two it is the only thing
      // saying which line is the router and which is the internet, and the tooltip cannot do that
      // job because it only appears once the reader has already guessed where to point.
      legend={overlay === undefined ? false : {}}
      ariaLabel={
        overlay
          ? `${label} latency with ${overlay.label} overlaid — median with p5 to p95 band, worst-ping envelope, and unmeasured periods marked`
          : `${label} latency — median with p5 to p95 band, worst-ping envelope, and unmeasured periods marked`
      }
    >
      {({ width, height }) => (
        <LatencyBandPlot
          label={label}
          chartKey={chartKey}
          points={points}
          expectedCycles={expectedCycles}
          primaryColor={primaryColor}
          overlayLabel={overlay?.label}
          renderExtraTooltipRows={renderExtraTooltipRows}
          width={width}
          height={height}
        />
      )}
    </ChartFrame>
  )
}

function LatencyBandPlot({
  label,
  chartKey,
  points,
  expectedCycles,
  primaryColor,
  overlayLabel,
  renderExtraTooltipRows,
  width,
  height,
}: {
  label: string
  chartKey: string
  points: Point[]
  expectedCycles: number
  primaryColor: string
  overlayLabel?: string
  renderExtraTooltipRows?: (bucket: ProbeBucket) => ReactNode
  width: number
  height: number
}) {
  // `VX.margin`'s 44 px left gutter is sized for two-digit axis labels, and this axis draws
  // milliseconds: `100 ms` overflowed it and rendered as `00 ms`, clipped at the SVG's left edge.
  // A clipped tick is worse than a missing one — it reads as a real number an order of magnitude
  // out. Widened here rather than in the token, because the token is shared by charts whose labels
  // genuinely do fit it.
  const margin = { ...VX.margin, left: 56 }
  const xMax = Math.max(0, width - margin.left - margin.right)
  const yMax = Math.max(0, height - margin.top - margin.bottom)
  const absentHatchId = `latency-${chartKey}-absent`
  const vantageHatchId = `latency-${chartKey}-vantage`
  const unknownHatchId = `latency-${chartKey}-unknown`

  const xScale = useMemo(
    () => scalePoint<string>({ domain: points.map((p) => p.label), range: [0, xMax], padding: 0.5 }),
    [points, xMax],
  )
  const bandWidth = points.length > 1 ? xScale.step() : xMax

  // The envelope is part of the domain: `maxMs` is the only stored witness of a sub-cycle stall
  // (all four targets showing a worst RTT 8×+ their own median at zero loss), and a domain sized
  // to p95 alone would clip the very spikes it exists to show. The overlay's values are folded into
  // the same domain — a router faster than the internet's p5 is a real, expected reading, and
  // sizing the axis off the primary series alone would clip that line off the bottom of the plot.
  const yDomainMax = useMemo(() => {
    const bucketValues = points.flatMap((p) => {
      const b = p.bucket
      if (b === null) return []
      return [b.p95Ms, b.maxMs].flatMap((v) => (v === null ? [] : [v]))
    })
    const overlayValues = points.flatMap((p) => (p.overlayMs === null ? [] : [p.overlayMs]))
    const values = [...bucketValues, ...overlayValues]
    const max = values.length > 0 ? Math.max(...values) : 1
    return Math.max(1, max * 1.15)
  }, [points])

  const yScale = useMemo(() => scaleLinear<number>({ domain: [0, yDomainMax], range: [yMax, 0] }), [
    yDomainMax,
    yMax,
  ])

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
  // Takes the point, not a bare string: the scale's domain is the display label while `key` stays
  // the ISO instant, and passing the wrong one silently yields NaN for every position.
  const x = (p: Point): number => xScale(p.label) ?? Number.NaN

  const { tip, tooltipRef, syncedPoint, handleMouse, handleLeave } = useHoverSync<Point>({
    data: points,
    chartId: `latency-${chartKey}`,
    getKey: (p) => p.label,
    xScale,
    marginLeft: margin.left,
  })
  const tooltipStyles = useTooltipStyles()
  /**
   * The x-axis, formatted like every other time axis on this dashboard.
   *
   * This chart drew its ticks with `smartTicks` and let `AxisBottomDate`'s default formatter render
   * them, which reduces an ISO string to `DD.MM` — so a 24 h window printed `01.08` a dozen times
   * across the bottom of the page's primary latency chart, an axis costing its full height to say
   * nothing about where in the window you are. `lib/axis.ts` already solved this for the
   * availability strip; the same two helpers apply here. `bucketAxisLabel` also decides the label's
   * *resolution* from the bucket size, so the `all` range keeps the year that stops its first and
   * last bucket reading identically.
   *
   * `axisTickValues` rather than `smartTicks` for the reason its own docblock gives: `smartTicks`
   * appends the final value unconditionally and the last two labels land on top of each other.
   */
  const dateTickValues = axisTickValues(
    points.map((p) => p.label),
    xMax,
  )

  if (width < 40 || height < 40) return null

  return (
    <svg width={width} height={height}>
      <defs>
        <HatchPattern id={absentHatchId} color={VX.neutral} />
        <HatchPattern id={vantageHatchId} color={VX.warnSolid} opacity={0.8} size={5} />
        <HatchPattern id={unknownHatchId} color={VX.neutral} opacity={0.8} size={5} />
      </defs>
      <Group left={margin.left} top={margin.top}>
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
          if (p.bucket.downCycles <= 0) return null
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
        <GridRows scale={yScale} width={xMax} stroke={VX.grid} strokeDasharray="2 3" />
        {/* The worst individual round trip in each bucket. Thin, unfilled and faint so it can
            never be mistaken for the p5–p95 band it encloses. */}
        <LinePath
          data={points}
          x={(p) => x(p)}
          y={(p) => y(p.bucket?.maxMs ?? null)}
          defined={(p) => p.bucket !== null && p.bucket.maxMs !== null}
          curve={curveMonotoneX}
          stroke={alpha(primaryColor, 0.35)}
          strokeWidth={1}
          fill="none"
        />
        <Area
          data={points}
          x={(p) => x(p)}
          y0={(p) => y(p.bucket?.p95Ms ?? null)}
          y1={(p) => y(p.bucket?.p5Ms ?? null)}
          curve={curveMonotoneX}
          fill={alpha(primaryColor, 0.14)}
          defined={isBanded}
        />
        <LinePath
          data={points}
          x={(p) => x(p)}
          y={(p) => y(p.bucket?.medianMs ?? null)}
          defined={(p) => p.bucket !== null && p.bucket.medianMs !== null}
          curve={curveMonotoneX}
          stroke={primaryColor}
          strokeWidth={VX.line2Width}
        />
        {overlayLabel !== undefined && (
          // Plain reference line: no band, no p5/p95, no loss markers of its own — `defined` stops
          // it exactly at a null `overlayMs`, the same rule the primary median line follows, so an
          // unmeasured router cycle breaks the line rather than interpolating across it.
          <LinePath
            data={points}
            x={(p) => x(p)}
            y={(p) => y(p.overlayMs)}
            defined={(p) => p.overlayMs !== null}
            curve={curveMonotoneX}
            stroke={VX.line}
            strokeWidth={VX.line2Width}
          />
        )}
        {points.map((p) =>
          p.bucket !== null && p.bucket.maxLossPct > 0 && p.bucket.medianMs !== null ? (
            <circle
              key={p.key}
              cx={x(p)}
              cy={yScale(p.bucket.medianMs)}
              r={3}
              fill={lossColor(p.bucket.maxLossPct)}
            />
          ) : null,
        )}
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
        <AxisLeftNumeric scale={yScale} numTicks={4} tickFormat={(v) => fmtMs(v)} />
        <AxisBottomDate scale={xScale} top={yMax} tickValues={dateTickValues} />
        {syncedPoint && <Crosshair x={x(syncedPoint)} top={0} bottom={yMax} />}
        {syncedPoint && syncedPoint.bucket !== null && syncedPoint.bucket.medianMs !== null && (
          <SeriesDot
            cx={x(syncedPoint)}
            cy={yScale(syncedPoint.bucket.medianMs)}
            color={lossColor(syncedPoint.bucket.maxLossPct)}
          />
        )}
        <HoverOverlay width={xMax} height={yMax} onMove={handleMouse} onLeave={handleLeave} />
      </Group>
      <ChartTooltip tip={tip} tooltipRef={tooltipRef} styles={tooltipStyles}>
        {tip && (
          <>
            <TooltipHeader date={fmtTooltipDate(tip.data.key)} label={label} labelColor={primaryColor} />
            <TooltipBody>
              <BucketRows point={tip.data} expectedCycles={expectedCycles} primaryColor={primaryColor} />
              {tip.data.bucket !== null && renderExtraTooltipRows?.(tip.data.bucket)}
              {overlayLabel !== undefined && <OverlayRow point={tip.data} overlayLabel={overlayLabel} />}
              <VantageRows point={tip.data} />
            </TooltipBody>
          </>
        )}
      </ChartTooltip>
    </svg>
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
      <TooltipRow color={primaryColor} label="Median" value={fmtMs(bucket.medianMs)} shape="line" />
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

/** The overlay's own tooltip row — `fmtMs` already renders a null median as "—", the same
 * unmeasured treatment the primary rows use, so no separate branch is needed here. */
function OverlayRow({ point, overlayLabel }: { point: Point; overlayLabel: string }) {
  return <TooltipRow color={VX.line} label={overlayLabel} value={fmtMs(point.overlayMs)} shape="line" />
}

function VantageRows({ point }: { point: Point }) {
  const vantage = point.vantage
  if (vantage === null) return null

  return (
    <>
      <TooltipRow
        color={vantage.onHomeLine === 'all' ? VX.goodSolid : VX.warnSolid}
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

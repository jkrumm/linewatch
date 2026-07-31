import { useMemo } from 'react'
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
  smartTicks,
  useHoverSync,
  useTooltipStyles,
} from 'basalt-ui/charts'
import type { HomeLineVerdict, ProbeBucket, TargetName, VantageBucket } from '../lib/types'
import { TARGET_LABEL } from '../lib/types'
import { densifyBuckets } from '../lib/densify'
import { PROBE_CYCLE_MS } from '../lib/range'
import { fmtMs, fmtPct } from '../lib/format'
import { HatchPattern, hatchFill } from './hatch'

/** One position on the time axis. `bucket === null` is a bucket the range route returned no row
 * for: unmeasured, which the chart must draw as its own state rather than as a gap the curve
 * smooths over. `vantage` is the parallel per-bucket record of what those cycles measured
 * *through* — null when the bucket held no cycles at all. */
type Point = {
  key: string
  bucket: ProbeBucket | null
  vantage: VantageBucket | null
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
 */
export function LatencyBandChart({
  target,
  buckets,
  vantage,
  from,
  to,
  bucketSeconds,
}: {
  target: TargetName
  buckets: ProbeBucket[]
  vantage: VantageBucket[]
  from: number
  to: number
  bucketSeconds: number
}) {
  const points: Point[] = useMemo(() => {
    const vantageByBucket = new Map(vantage.map((v) => [v.bucket, v]))
    return densifyBuckets(buckets, { from, to, bucketSeconds }).map((slot) => ({
      key: slot.key,
      bucket: slot.value,
      vantage: vantageByBucket.get(slot.bucketStart) ?? null,
    }))
  }, [buckets, vantage, from, to, bucketSeconds])

  // What the collector's cadence should have produced in one bucket. Named "expected" wherever it
  // is shown, because it is arithmetic over the configured cadence, not a count of anything.
  const expectedCycles = Math.max(1, Math.round((bucketSeconds * 1000) / PROBE_CYCLE_MS))

  return (
    <ChartFrame
      series={[{ key: target, label: TARGET_LABEL[target], color: VX.line, mark: 'line' }]}
      height={190}
      chartId={`latency-${target}`}
      legend={false}
      ariaLabel={`${TARGET_LABEL[target]} latency — median with p5 to p95 band, worst-ping envelope, and unmeasured periods marked`}
    >
      {({ width, height }) => (
        <LatencyBandPlot
          target={target}
          points={points}
          expectedCycles={expectedCycles}
          width={width}
          height={height}
        />
      )}
    </ChartFrame>
  )
}

function LatencyBandPlot({
  target,
  points,
  expectedCycles,
  width,
  height,
}: {
  target: TargetName
  points: Point[]
  expectedCycles: number
  width: number
  height: number
}) {
  const margin = VX.margin
  const xMax = Math.max(0, width - margin.left - margin.right)
  const yMax = Math.max(0, height - margin.top - margin.bottom)
  const absentHatchId = `latency-${target}-absent`
  const vantageHatchId = `latency-${target}-vantage`
  const unknownHatchId = `latency-${target}-unknown`

  const xScale = useMemo(
    () => scalePoint<string>({ domain: points.map((p) => p.key), range: [0, xMax], padding: 0.5 }),
    [points, xMax],
  )
  const bandWidth = points.length > 1 ? xScale.step() : xMax

  // The envelope is part of the domain: `maxMs` is the only stored witness of a sub-cycle stall
  // (all four targets showing a worst RTT 8×+ their own median at zero loss), and a domain sized
  // to p95 alone would clip the very spikes it exists to show.
  const yDomainMax = useMemo(() => {
    const values = points.flatMap((p) => {
      const b = p.bucket
      if (b === null) return []
      return [b.p95Ms, b.maxMs].flatMap((v) => (v === null ? [] : [v]))
    })
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
  const x = (key: string): number => xScale(key) ?? Number.NaN

  const { tip, tooltipRef, syncedPoint, handleMouse, handleLeave } = useHoverSync<Point>({
    data: points,
    chartId: `latency-${target}`,
    getKey: (p) => p.key,
    xScale,
    marginLeft: margin.left,
  })
  const tooltipStyles = useTooltipStyles()
  const dateTickValues = smartTicks(
    points.map((p) => p.key),
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
          const left = x(p.key) - bandWidth / 2
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
          x={(p) => x(p.key)}
          y={(p) => y(p.bucket?.maxMs ?? null)}
          defined={(p) => p.bucket !== null && p.bucket.maxMs !== null}
          curve={curveMonotoneX}
          stroke={alpha(VX.line, 0.35)}
          strokeWidth={1}
          fill="none"
        />
        <Area
          data={points}
          x={(p) => x(p.key)}
          y0={(p) => y(p.bucket?.p95Ms ?? null)}
          y1={(p) => y(p.bucket?.p5Ms ?? null)}
          curve={curveMonotoneX}
          fill={alpha(VX.line, 0.14)}
          defined={isBanded}
        />
        <LinePath
          data={points}
          x={(p) => x(p.key)}
          y={(p) => y(p.bucket?.medianMs ?? null)}
          defined={(p) => p.bucket !== null && p.bucket.medianMs !== null}
          curve={curveMonotoneX}
          stroke={VX.line}
          strokeWidth={VX.line2Width}
        />
        {points.map((p) =>
          p.bucket !== null && p.bucket.maxLossPct > 0 && p.bucket.medianMs !== null ? (
            <circle
              key={p.key}
              cx={x(p.key)}
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
              x={x(p.key) - bandWidth / 2}
              y={yMax - RAIL_H}
              width={bandWidth}
              height={RAIL_H}
              fill={hatchFill(p.vantage.onHomeLine === 'unknown' ? unknownHatchId : vantageHatchId)}
            />
          ) : null,
        )}
        <AxisLeftNumeric scale={yScale} numTicks={4} tickFormat={(v) => fmtMs(v)} />
        <AxisBottomDate scale={xScale} top={yMax} tickValues={dateTickValues} />
        {syncedPoint && <Crosshair x={x(syncedPoint.key)} top={0} bottom={yMax} />}
        {syncedPoint && syncedPoint.bucket !== null && syncedPoint.bucket.medianMs !== null && (
          <SeriesDot
            cx={x(syncedPoint.key)}
            cy={yScale(syncedPoint.bucket.medianMs)}
            color={lossColor(syncedPoint.bucket.maxLossPct)}
          />
        )}
        <HoverOverlay width={xMax} height={yMax} onMove={handleMouse} onLeave={handleLeave} />
      </Group>
      <ChartTooltip tip={tip} tooltipRef={tooltipRef} styles={tooltipStyles}>
        {tip && (
          <>
            <TooltipHeader date={fmtTooltipDate(tip.data.key)} label={TARGET_LABEL[target]} labelColor={VX.line} />
            <TooltipBody>
              <BucketRows point={tip.data} expectedCycles={expectedCycles} />
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

function BucketRows({ point, expectedCycles }: { point: Point; expectedCycles: number }) {
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
      <TooltipRow color={VX.line} label="Median" value={fmtMs(bucket.medianMs)} shape="line" />
      <TooltipRow
        color={VX.line}
        label="p5 – p95"
        value={`${fmtMs(bucket.p5Ms)} – ${fmtMs(bucket.p95Ms)}`}
        shape="line"
        dashed
      />
      {/* The envelope's own row: the slowest single round trip in the bucket, which is the only
          stored trace of a stall lasting less than one cycle. */}
      <TooltipRow
        color={alpha(VX.line, 0.35)}
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

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
import type { ProbeBucket, TargetName } from '../lib/types'
import { TARGET_LABEL } from '../lib/types'
import { fmtMs, fmtPct } from '../lib/format'

type Point = { key: string; bucket: ProbeBucket }

/** The *Solid* variants, not `VX.good`/`VX.warn`/`VX.bad`: those are area-fill tokens mixed down to
 * 18% / 8% / 18% opacity (`tokens.css`), which is right behind a line and invisible on a 3 px
 * marker. A loss marker has to read at a glance or it is not a warning. */
function lossColor(lossPct: number): string {
  if (lossPct <= 0) return VX.goodSolid
  if (lossPct < 20) return VX.warnSolid
  return VX.badSolid
}

/**
 * The SmokePing-style signature chart (DESIGN.md's "Latency" view): a median line with a shaded
 * p5–p95 band, loss encoded as marker color. Genuinely unique (a band between two arbitrary
 * series, per-point loss markers) so it's bespoke rather than a shipped kind — composes the visx
 * primitives directly, per the visx-charts rule's "stay bespoke" guidance.
 */
export function LatencyBandChart({ target, buckets }: { target: TargetName; buckets: ProbeBucket[] }) {
  const points: Point[] = useMemo(
    () => buckets.map((b) => ({ key: new Date(b.bucket).toISOString(), bucket: b })),
    [buckets],
  )

  return (
    <ChartFrame
      series={[{ key: target, label: TARGET_LABEL[target], color: VX.line, mark: 'line' }]}
      height={190}
      chartId={`latency-${target}`}
      legend={false}
      ariaLabel={`${TARGET_LABEL[target]} latency — median with p5 to p95 band`}
    >
      {({ width, height }) => <LatencyBandPlot target={target} points={points} width={width} height={height} />}
    </ChartFrame>
  )
}

function LatencyBandPlot({
  target,
  points,
  width,
  height,
}: {
  target: TargetName
  points: Point[]
  width: number
  height: number
}) {
  const margin = VX.margin
  const xMax = Math.max(0, width - margin.left - margin.right)
  const yMax = Math.max(0, height - margin.top - margin.bottom)

  const xScale = useMemo(
    () => scalePoint<string>({ domain: points.map((p) => p.key), range: [0, xMax], padding: 0.5 }),
    [points, xMax],
  )

  const yDomainMax = useMemo(() => {
    const values = points.flatMap((p) => (p.bucket.p95Ms === null ? [] : [p.bucket.p95Ms]))
    const max = values.length > 0 ? Math.max(...values) : 1
    return Math.max(1, max * 1.15)
  }, [points])

  const yScale = useMemo(() => scaleLinear<number>({ domain: [0, yDomainMax], range: [yMax, 0] }), [
    yDomainMax,
    yMax,
  ])

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
      <Group left={margin.left} top={margin.top}>
        <GridRows scale={yScale} width={xMax} stroke={VX.grid} strokeDasharray="2 3" />
        <Area
          data={points}
          x={(p) => xScale(p.key) ?? 0}
          y0={(p) => yScale(p.bucket.p95Ms ?? 0)}
          y1={(p) => yScale(p.bucket.p5Ms ?? 0)}
          curve={curveMonotoneX}
          fill={alpha(VX.line, 0.14)}
          defined={(p) => p.bucket.medianMs !== null}
        />
        <LinePath
          data={points}
          x={(p) => xScale(p.key) ?? 0}
          y={(p) => yScale(p.bucket.medianMs ?? 0)}
          defined={(p) => p.bucket.medianMs !== null}
          curve={curveMonotoneX}
          stroke={VX.line}
          strokeWidth={VX.line2Width}
        />
        {points.map((p) =>
          p.bucket.maxLossPct > 0 && p.bucket.medianMs !== null ? (
            <circle
              key={p.key}
              cx={xScale(p.key) ?? 0}
              cy={yScale(p.bucket.medianMs)}
              r={3}
              fill={lossColor(p.bucket.maxLossPct)}
            />
          ) : null,
        )}
        <AxisLeftNumeric scale={yScale} numTicks={4} tickFormat={(v) => fmtMs(v)} />
        <AxisBottomDate scale={xScale} top={yMax} tickValues={dateTickValues} />
        {syncedPoint && <Crosshair x={xScale(syncedPoint.key) ?? 0} top={0} bottom={yMax} />}
        {syncedPoint && syncedPoint.bucket.medianMs !== null && (
          <SeriesDot
            cx={xScale(syncedPoint.key) ?? 0}
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
              <TooltipRow color={VX.line} label="Median" value={fmtMs(tip.data.bucket.medianMs)} shape="line" />
              <TooltipRow
                color={VX.line}
                label="p5 – p95"
                value={`${fmtMs(tip.data.bucket.p5Ms)} – ${fmtMs(tip.data.bucket.p95Ms)}`}
                shape="line"
                dashed
              />
              <TooltipRow
                color={lossColor(tip.data.bucket.lossPct)}
                label="Loss"
                value={fmtPct(tip.data.bucket.lossPct)}
                shape="dot"
              />
              {/* The marker colour tracks the worst cycle, so name it — labelling it "Loss" made a
                  one-blip hour read as a 100%-loss hour. */}
              <TooltipRow
                color={lossColor(tip.data.bucket.maxLossPct)}
                label="Worst cycle"
                value={fmtPct(tip.data.bucket.maxLossPct)}
                shape="dot"
              />
            </TooltipBody>
          </>
        )}
      </ChartTooltip>
    </svg>
  )
}

import { useMemo } from 'react'
import { scaleBand, scaleLinear } from '@visx/scale'
import {
  AxisBottomDate,
  AxisLeftNumeric,
  ChartLegend,
  ChartTooltip,
  ResponsiveChart,
  TooltipBody,
  TooltipHeader,
  TooltipRow,
  VX,
  alpha,
  useChartTooltip,
  useTooltipStyles,
} from 'basalt-ui/charts'
import type { ProbeBucketSeconds, ThroughputBucket } from '../lib/types'
import { throughputPoints, type ThroughputPoint } from '../lib/throughput'
import { fmtBytes, fmtDateTime, fmtRate } from '../lib/format'
import { AXIS_LABEL_PX, axisTickValues } from '../lib/axis'
import { HatchPattern, hatchFill } from './hatch'

// 180, not 240. This is a two-sided bar chart with three y ticks per half and no line to trace,
// so the extra 60 px bought no resolution — it bought a section that pushed the one below it off
// the fold on a laptop. The dashboard's other full-width plot (the latency band, which does have a
// curve worth the pixels) is 190.
const CHART_HEIGHT = 180
const AXIS_HEIGHT = 22
/**
 * Room for this chart's y labels, which are rates rather than plain numbers: `fmtRate` produces
 * `1.0 MB/s` and `400 kB/s`, eight characters at the 11 px axis font. At 56 px the widest of them
 * rendered with its leading character cut off by the SVG's left edge — and a clipped rate label is
 * worse than a missing one, because `.0 MB/s` still reads as a number.
 */
const LEFT_GUTTER = 72

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
 */
export function ThroughputChart({
  buckets,
  from,
  to,
  bucketSeconds,
}: {
  buckets: readonly ThroughputBucket[]
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
}) {
  const points = useMemo(
    () => throughputPoints(buckets, { from, to, bucketSeconds }),
    [buckets, from, to, bucketSeconds],
  )

  return (
    <>
      <ResponsiveChart height={CHART_HEIGHT + AXIS_HEIGHT}>
        {({ width }) => <MirroredBars points={points} width={width} />}
      </ResponsiveChart>
      <ChartLegend
        chartId="throughput-legend"
        placement="bottom"
        items={[
          { key: 'down', label: 'Download', color: VX.accent, shape: 'bar' as const },
          { key: 'up', label: 'Upload', color: VX.status.bad, shape: 'bar' as const },
          { key: 'absent', label: 'Not measured', color: VX.neutral, shape: 'bar' as const },
        ]}
      />
    </>
  )
}

function MirroredBars({ points, width }: { points: ThroughputPoint[]; width: number }) {
  const tooltipStyles = useTooltipStyles()
  const { tip, show, hide, tooltipRef } = useChartTooltip<ThroughputPoint>()
  const absentHatchId = 'throughput-absent'

  const labels = points.map((p) => p.label)
  const plotWidth = Math.max(0, width - LEFT_GUTTER)
  const xScale = scaleBand<string>({ domain: labels, range: [0, plotWidth] })

  // Each half scaled independently — see the component docblock. `|| 1` keeps a window with no
  // traffic at all from producing a zero-width domain, which renders as NaN geometry.
  const maxDown = Math.max(...points.map((p) => p.downBytesPerS ?? 0), 0) || 1
  const maxUp = Math.max(...points.map((p) => p.upBytesPerS ?? 0), 0) || 1
  // Upload gets the smaller half: on a household line it is an order of magnitude below download,
  // and splitting the height evenly would waste most of the chart on empty space above the upload.
  const upHeight = Math.round(CHART_HEIGHT * 0.35)
  const downHeight = CHART_HEIGHT - upHeight
  const baseline = upHeight

  const downScale = scaleLinear<number>({ domain: [0, maxDown], range: [0, downHeight] })
  const upScale = scaleLinear<number>({ domain: [0, maxUp], range: [0, upHeight] })

  if (width < 60 || points.length === 0) return null

  const step = plotWidth / points.length
  const barWidth = Math.max(step - 1, 1)

  return (
    <div style={{ position: 'relative' }}>
      <svg
        width={width}
        height={CHART_HEIGHT + AXIS_HEIGHT}
        role="img"
        aria-label="Data carried per bucket — download below the baseline, upload above it, with unmeasured buckets marked"
      >
        <defs>
          <HatchPattern id={absentHatchId} color={VX.neutral} opacity={0.7} size={5} />
        </defs>
        <g transform={`translate(${LEFT_GUTTER}, 0)`}>
          {/* One axis per half, each in its own scale's units, because the halves are scaled
              independently — a single shared axis would be wrong for at least one of them. Both sit
              inside this group so their ticks extend left into the gutter rather than off-canvas. */}
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
          {points.map((point, i) => {
            const x = i * step
            if (point.downBytesPerS === null || point.upBytesPerS === null) {
              // Absence spans the whole height rather than sitting on the baseline: a hatch drawn
              // only on the download half would read as "downloaded nothing, uploaded nothing",
              // which is the measured-and-idle state this must be distinguishable from.
              return (
                <rect
                  key={point.key}
                  x={x}
                  y={0}
                  width={barWidth}
                  height={CHART_HEIGHT}
                  fill={hatchFill(absentHatchId)}
                  style={{ cursor: 'pointer' }}
                  onMouseMove={(e) => show(point, e)}
                  onMouseLeave={hide}
                />
              )
            }

            const downPx = downScale(point.downBytesPerS)
            const upPx = upScale(point.upBytesPerS)
            // A partial bucket is drawn at reduced opacity and named in the tooltip. It is a real
            // measurement — just a short one — so dimming is the right weight: visible enough not
            // to be read as complete, not so loud as to be read as a fault.
            const opacity = point.skipped > 0 ? 0.45 : 1

            return (
              <g
                key={point.key}
                style={{ cursor: 'pointer' }}
                onMouseMove={(e) => show(point, e)}
                onMouseLeave={hide}
              >
                {/* An invisible full-height target, so hovering a near-zero bar still works. */}
                <rect x={x} y={0} width={barWidth} height={CHART_HEIGHT} fill="transparent" />
                <rect
                  x={x}
                  y={baseline - upPx}
                  width={barWidth}
                  height={Math.max(upPx, point.upBytesPerS > 0 ? 1 : 0)}
                  fill={alpha(VX.status.bad, opacity)}
                />
                <rect
                  x={x}
                  y={baseline}
                  width={barWidth}
                  height={Math.max(downPx, point.downBytesPerS > 0 ? 1 : 0)}
                  fill={alpha(VX.accent, opacity)}
                />
              </g>
            )
          })}
          <line x1={0} y1={baseline} x2={plotWidth} y2={baseline} stroke={VX.axisStroke} strokeWidth={1} />
          <AxisBottomDate
            scale={xScale}
            top={CHART_HEIGHT}
            tickValues={axisTickValues(labels, plotWidth, AXIS_LABEL_PX)}
          />
        </g>
      </svg>
      <ChartTooltip tip={tip} tooltipRef={tooltipRef} styles={tooltipStyles}>
        {tip && <PointRows point={tip.data} />}
      </ChartTooltip>
    </div>
  )
}

function PointRows({ point }: { point: ThroughputPoint }) {
  return (
    <>
      <TooltipHeader date={fmtDateTime(point.bucketStart)} label="Carried" labelColor={VX.accent} />
      <TooltipBody>
        {point.downBytesPerS === null ? (
          <TooltipRow color={VX.neutral} shape="bar" label="Not measured" value="no usable interval" />
        ) : (
          <>
            <TooltipRow color={VX.accent} shape="bar" label="Down" value={`${fmtRate(point.downBytesPerS)} · ${fmtBytes(point.downBytes)}`} />
            <TooltipRow color={VX.status.bad} shape="bar" label="Up" value={`${fmtRate(point.upBytesPerS)} · ${fmtBytes(point.upBytes)}`} />
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
      </TooltipBody>
    </>
  )
}

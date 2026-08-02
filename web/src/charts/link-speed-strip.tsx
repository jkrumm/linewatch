import { useMemo } from 'react'
import { scaleBand } from '@visx/scale'
import {
  AxisBottomDate,
  ChartTooltip,
  ResponsiveChart,
  TooltipBody,
  TooltipHeader,
  TooltipRow,
  VX,
  alpha,
  fmtTooltipDate,
  useChartTooltip,
  useTooltipStyles,
} from 'basalt-ui/charts'
import type { ProbeBucketSeconds, VantageBucket } from '../lib/types'
import type { LinkBucketState } from '../lib/vantage'
import { linkBucketState } from '../lib/vantage'
import { densifyBuckets } from '../lib/densify'
import { AXIS_LABEL_PX, axisTickValues, bucketAxisLabel } from '../lib/axis'
import { HatchPattern, hatchFill } from './hatch'

const STRIP_HEIGHT = 44

/**
 * Room for the time axis this strip used to do without.
 *
 * It drew 289 columns of link state with no x-axis at all, so "the NIC renegotiated" was legible
 * and *when* it renegotiated was only recoverable by hovering the right column — on a chart whose
 * entire subject is a moment in time. The inset is half a label width on each side, because the
 * edge labels are centred on their own ticks and would otherwise be cut by the SVG's edges; the
 * left side takes the wider of that and the plot gutter the charts above use, so the two time axes
 * on this page start at the same x and can be read against each other.
 */
const PLOT_LEFT = Math.max(56, Math.round(AXIS_LABEL_PX / 2))
const PLOT_RIGHT = Math.round(AXIS_LABEL_PX / 2)
const AXIS_HEIGHT = 22

/** The height of the transition marker, as a fraction of the strip. It is drawn as a full-height
 * bar of its own colour rather than a value, so it cannot be read off the intensity ramp. */
const MARKER_INSET = 6

type Column = {
  /** ISO-8601 of the bucket start — what the tooltip's own date formatting reads. */
  key: string
  /** The pre-formatted axis label, which is also the band scale's domain value. `AxisBottomDate`
   * takes no `tickFormat` and reduces an ISO string to `DD.MM`, so this is the only way a time of
   * day reaches the axis — the same mechanism `availability-strip.tsx` uses. */
  label: string
  state: LinkBucketState
}

/**
 * Negotiated link speed over the window, one column per bucket.
 *
 * The one rule that shapes this chart: **a bucket holding more than one link speed is drawn as a
 * transition marker, not as a value.** `GET /api/probes`'s vantage series reports every distinct
 * speed seen in a bucket precisely so the client cannot flatten them, and averaging a
 * 1000→100 renegotiation into 550 renders a rate the NIC never ran at — a fabricated measurement
 * sitting in the middle of two real ones.
 *
 * Three more states stay distinct from each other and from a speed: a bucket the range route
 * returned nothing for (hatched — not measured), a bucket whose cycles reported no link speed at
 * all (faint — measured, but not this), and the speeds themselves, whose intensity is relative to
 * the fastest speed in the window rather than to any absolute rate, because this line's ceiling is
 * a property of the hardware and not of the chart.
 */
export function LinkSpeedStrip({
  vantage,
  from,
  to,
  bucketSeconds,
}: {
  vantage: VantageBucket[]
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
}) {
  const columns: Column[] = useMemo(
    () =>
      densifyBuckets(vantage, { from, to, bucketSeconds }).map((slot) => ({
        key: slot.key,
        label: bucketAxisLabel(slot.bucketStart, bucketSeconds),
        state: linkBucketState(slot.value),
      })),
    [vantage, from, to, bucketSeconds],
  )

  const maxMbit = useMemo(() => {
    let max = 0
    for (const column of columns) {
      if (column.state.kind === 'steady') max = Math.max(max, column.state.mbit)
      if (column.state.kind === 'transition') max = Math.max(max, ...column.state.mbits)
    }
    return max
  }, [columns])

  return (
    <ResponsiveChart height={STRIP_HEIGHT + AXIS_HEIGHT}>
      {({ width }) => <StripPlot columns={columns} maxMbit={maxMbit} width={width} />}
    </ResponsiveChart>
  )
}

function StripPlot({ columns, maxMbit, width }: { columns: Column[]; maxMbit: number; width: number }) {
  const tooltipStyles = useTooltipStyles()
  const { tip, show, hide, tooltipRef } = useChartTooltip<Column>()
  const absentHatchId = 'link-speed-strip-absent'

  const labels = columns.map((c) => c.label)
  const plotWidth = Math.max(0, width - PLOT_LEFT - PLOT_RIGHT)
  const scale = scaleBand<string>({ domain: labels, range: [0, plotWidth] })

  if (width < PLOT_LEFT + PLOT_RIGHT + 20 || columns.length === 0) return null

  const height = STRIP_HEIGHT
  const step = plotWidth / columns.length
  const barWidth = Math.max(step - 1, 1)

  return (
    <div style={{ position: 'relative' }}>
      <svg
        width={width}
        height={STRIP_HEIGHT + AXIS_HEIGHT}
        role="img"
        aria-label="Negotiated link speed per bucket, with unmeasured buckets hatched and renegotiations marked rather than averaged"
      >
        <defs>
          <HatchPattern id={absentHatchId} color={VX.neutral} opacity={0.7} size={5} />
        </defs>
        <g transform={`translate(${PLOT_LEFT}, 0)`}>
          {columns.map((column, i) => (
            <g key={column.key}>
              <rect
                x={i * step}
                y={0}
                width={barWidth}
                height={height}
                rx={1}
                fill={columnFill(column.state, maxMbit, absentHatchId)}
                style={{ cursor: 'pointer' }}
                onMouseMove={(e) => show(column, e)}
                onMouseLeave={hide}
              />
              {column.state.kind === 'transition' && (
                <rect
                  x={i * step}
                  y={MARKER_INSET}
                  width={barWidth}
                  height={Math.max(2, height - 2 * MARKER_INSET)}
                  rx={1}
                  fill={VX.warnSolid}
                  pointerEvents="none"
                />
              )}
            </g>
          ))}
          {/* `axisTickValues` rather than `smartTicks`, for the reason its docblock gives: the latter
            appends the final value unconditionally and the last two labels overlap. */}
          <AxisBottomDate
            scale={scale}
            top={STRIP_HEIGHT}
            tickValues={axisTickValues(labels, plotWidth, AXIS_LABEL_PX)}
          />
        </g>
      </svg>
      <ChartTooltip tip={tip} tooltipRef={tooltipRef} styles={tooltipStyles}>
        {tip && (
          <>
            <TooltipHeader date={fmtTooltipDate(tip.data.key)} label="Link speed" labelColor={VX.line} />
            <TooltipBody>
              <StateRows state={tip.data.state} />
            </TooltipBody>
          </>
        )}
      </ChartTooltip>
    </div>
  )
}

function columnFill(state: LinkBucketState, maxMbit: number, absentHatchId: string): string {
  if (state.kind === 'unmeasured') return hatchFill(absentHatchId)
  // Measured cycles that reported no link speed. Faint and solid rather than hatched: something
  // was measured here, so it is not absence — it just was not this.
  if (state.kind === 'no-vantage') return alpha(VX.neutral, 0.18)
  if (state.kind === 'transition') return alpha(VX.warnSolid, 0.25)
  // `maxMbit` is 0 only when no bucket in the window reported a speed, in which case this branch
  // is unreachable; the guard keeps the division defined rather than producing NaN.
  const intensity = maxMbit > 0 ? state.mbit / maxMbit : 1
  return alpha(VX.line, 0.25 + 0.65 * intensity)
}

function StateRows({ state }: { state: LinkBucketState }) {
  if (state.kind === 'unmeasured') {
    return <TooltipRow color={VX.neutral} shape="bar" label="Not measured" value="no cycles" />
  }
  if (state.kind === 'no-vantage') {
    return (
      <TooltipRow
        color={VX.neutral}
        shape="bar"
        label="No link speed reported"
        value={`${state.cycles} cycles`}
      />
    )
  }
  if (state.kind === 'transition') {
    return (
      <>
        <TooltipRow
          color={VX.warnSolid}
          shape="bar"
          label="Renegotiated in this bucket"
          // Joined with a slash, not an arrow: the bucket reports the distinct speeds it saw, not
          // the order it saw them in, and an arrow would invent a direction.
          value={state.mbits.map((mbit) => `${mbit} Mbit`).join(' / ')}
        />
        <TooltipRow
          color={VX.neutral}
          shape="dot"
          label="Not averaged"
          value="the order within the bucket is unrecorded"
        />
      </>
    )
  }
  return <TooltipRow color={VX.line} shape="bar" label="Negotiated" value={`${state.mbit} Mbit`} />
}

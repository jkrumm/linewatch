import { useMemo } from 'react'
import {
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
import { HatchPattern, hatchFill } from './hatch'

const STRIP_HEIGHT = 44

/** The height of the transition marker, as a fraction of the strip. It is drawn as a full-height
 * bar of its own colour rather than a value, so it cannot be read off the intensity ramp. */
const MARKER_INSET = 6

type Column = {
  key: string
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
    <ResponsiveChart height={STRIP_HEIGHT}>
      {({ width, height }) => (
        <StripPlot columns={columns} maxMbit={maxMbit} width={width} height={height} />
      )}
    </ResponsiveChart>
  )
}

function StripPlot({
  columns,
  maxMbit,
  width,
  height,
}: {
  columns: Column[]
  maxMbit: number
  width: number
  height: number
}) {
  const tooltipStyles = useTooltipStyles()
  const { tip, show, hide, tooltipRef } = useChartTooltip<Column>()
  const absentHatchId = 'link-speed-strip-absent'

  if (width < 20 || columns.length === 0) return null

  const step = width / columns.length
  const barWidth = Math.max(step - 1, 1)

  return (
    <div style={{ position: 'relative' }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Negotiated link speed per bucket, with unmeasured buckets hatched and renegotiations marked rather than averaged"
      >
        <defs>
          <HatchPattern id={absentHatchId} color={VX.neutral} opacity={0.7} size={5} />
        </defs>
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

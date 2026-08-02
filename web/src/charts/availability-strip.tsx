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
import type { ProbeBucket, ProbeBucketSeconds, TargetName } from '../lib/types'
import { TARGET_LABEL } from '../lib/types'
import { densifyBuckets } from '../lib/densify'
import { PROBE_CYCLE_MS } from '../lib/range'
import { fmtPct } from '../lib/format'
import { AXIS_LABEL_PX, axisTickValues, bucketAxisLabel } from '../lib/axis'
import { HatchPattern, hatchFill } from './hatch'

/** Loss share at which a column is painted at full strength — the same absolute scale the
 * availability heatmap uses, so the two views of the same data agree on what "bad" looks like. */
const FULL_INTENSITY_LOSS_PCT = 5

/** Faint floor under every measured column, so "measured, no loss" is a visible mark rather than
 * blank canvas. Without it a flawless bucket and an unmeasured one are both empty space. */
const MEASURED_FLOOR_ALPHA = 0.14

const STRIP_HEIGHT = 44

/**
 * Room under the columns for the time axis.
 *
 * The strip shipped without one, which made it the only chart on the page a reader could not
 * locate an event on: an outage was visible as a dark column and answerable only as "somewhere in
 * the last 24 hours". A column you cannot put a clock time to cannot be correlated with anything —
 * not a router reboot, not a speed test, not a memory of the call that dropped.
 */
const AXIS_HEIGHT = 22

type Column = {
  key: string
  bucketStart: number
  /** The axis label for this column, and the band scale's key — see `bucketAxisLabel`. */
  label: string
  bucket: ProbeBucket | null
}

/**
 * The Now view's 24 h summary, and why it is not a sparkline.
 *
 * `LineSparkline`/`BarSparkline` take `data: number[]` with no x accessor and no domain, so the
 * only way to feed them is to drop the buckets that measured nothing — and a dropped element is not
 * a gap, the array simply closes over it. Every 100%-loss bucket and every unmeasured bucket
 * shortened the array and the remaining points slid together into a continuous healthy trend, which
 * is a guaranteed-green summary regardless of what happened. A component that cannot express
 * absence must not be the 24 h headline.
 *
 * So: one column per bucket over the densified window (`densifyBuckets`), fixed count for a given
 * range whatever the response contains, and three visually distinct states — hatched for a bucket
 * that was never measured, a loss ramp for one that was, and a solid bad column for one where every
 * cycle got nothing back. Hatching is the dashboard's one vocabulary for absence (`hatch.tsx`).
 */
export function AvailabilityStrip({
  target,
  buckets,
  from,
  to,
  bucketSeconds,
}: {
  /** Which target's buckets these are — the tooltip names it rather than assuming the WAN anchor. */
  target: TargetName
  buckets: ProbeBucket[]
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
}) {
  const columns: Column[] = useMemo(
    () =>
      densifyBuckets(buckets, { from, to, bucketSeconds }).map((slot) => ({
        key: slot.key,
        bucketStart: slot.bucketStart,
        label: bucketAxisLabel(slot.bucketStart, bucketSeconds),
        bucket: slot.value,
      })),
    [buckets, from, to, bucketSeconds],
  )
  // Arithmetic over the configured cadence, not a count of anything — named "expected" wherever
  // it is shown, the same as in the latency chart's tooltip.
  const expectedCycles = Math.max(1, Math.round((bucketSeconds * 1000) / PROBE_CYCLE_MS))

  return (
    <ResponsiveChart height={STRIP_HEIGHT + AXIS_HEIGHT}>
      {({ width }) => (
        <StripPlot
          target={target}
          columns={columns}
          expectedCycles={expectedCycles}
          bucketSeconds={bucketSeconds}
          width={width}
        />
      )}
    </ResponsiveChart>
  )
}

function StripPlot({
  target,
  columns,
  expectedCycles,
  bucketSeconds,
  width,
}: {
  target: TargetName
  columns: Column[]
  expectedCycles: number
  bucketSeconds: ProbeBucketSeconds
  width: number
}) {
  const tooltipStyles = useTooltipStyles()
  const { tip, show, hide, tooltipRef } = useChartTooltip<Column>()
  const absentHatchId = 'availability-strip-absent'

  // The band scale is built before the width guard's early return so the hook order above it stays
  // fixed; `scaleBand` is a plain call, not a hook, so this is only ordering hygiene for readers.
  const labels = columns.map((c) => c.label)
  const scale = scaleBand<string>({ domain: labels, range: [0, width] })

  if (width < 20 || columns.length === 0) return null

  const step = width / columns.length
  const barWidth = Math.max(step - 1, 1)

  return (
    <div style={{ position: 'relative' }}>
      <svg
        width={width}
        height={STRIP_HEIGHT + AXIS_HEIGHT}
        role="img"
        aria-label={`${TARGET_LABEL[target]} availability in ${Math.round(bucketSeconds / 60)}-minute buckets, with unmeasured buckets marked`}
      >
        <defs>
          <HatchPattern id={absentHatchId} color={VX.neutral} opacity={0.7} size={5} />
        </defs>
        {columns.map((column, i) => (
          <rect
            key={column.key}
            x={i * step}
            y={0}
            width={barWidth}
            height={STRIP_HEIGHT}
            rx={1}
            fill={columnFill(column.bucket, absentHatchId)}
            style={{ cursor: 'pointer' }}
            onMouseMove={(e) => show(column, e)}
            onMouseLeave={hide}
          />
        ))}
        {/* `axisTickValues` rather than basalt's own `smartTicks`, for the reason its docblock
            gives: `smartTicks` appends the final value unconditionally and the last two labels
            land on top of each other. The labels are pre-formatted by `bucketAxisLabel` and pass
            through `fmtAxisDate` untouched — see `lib/axis.ts`. */}
        <AxisBottomDate
          scale={scale}
          top={STRIP_HEIGHT}
          tickValues={axisTickValues(labels, width, AXIS_LABEL_PX)}
        />
      </svg>
      <ChartTooltip tip={tip} tooltipRef={tooltipRef} styles={tooltipStyles}>
        {tip && (
          <>
            <TooltipHeader
              date={fmtTooltipDate(tip.data.key)}
              label={TARGET_LABEL[target]}
              labelColor={VX.line}
            />
            <TooltipBody>
              <ColumnRows column={tip.data} expectedCycles={expectedCycles} />
            </TooltipBody>
          </>
        )}
      </ChartTooltip>
    </div>
  )
}

/**
 * Three states, three fills. A bucket where every cycle got nothing back is solid, not merely the
 * top of the loss ramp: "the line was gone for this whole bucket" and "this bucket lost 5% of its
 * packets" are not neighbouring intensities of one fact.
 */
function columnFill(bucket: ProbeBucket | null, absentHatchId: string): string {
  if (bucket === null) return hatchFill(absentHatchId)
  // `count > 0` guards the degenerate row: 0 down of 0 cycles is not a fully-down bucket, and
  // painting it solid would invent an outage out of an empty aggregate.
  if (bucket.count > 0 && bucket.downCycles >= bucket.count) return VX.badSolid
  const intensity = Math.min(1, bucket.lossPct / FULL_INTENSITY_LOSS_PCT)
  return alpha(VX.badSolid, MEASURED_FLOOR_ALPHA + (1 - MEASURED_FLOOR_ALPHA) * intensity)
}

function ColumnRows({ column, expectedCycles }: { column: Column; expectedCycles: number }) {
  const bucket = column.bucket
  if (bucket === null) {
    return (
      <TooltipRow
        color={VX.neutral}
        shape="bar"
        label="Not measured"
        value={`0 of ${expectedCycles} expected cycles`}
      />
    )
  }

  return (
    <>
      <TooltipRow color={VX.badSolid} shape="bar" label="Loss" value={fmtPct(bucket.lossPct, 2)} />
      <TooltipRow
        color={VX.warnSolid}
        shape="dot"
        label="Worst cycle"
        value={fmtPct(bucket.maxLossPct)}
      />
      {bucket.downCycles > 0 && (
        <TooltipRow
          color={VX.badSolid}
          shape="bar"
          label="Cycles fully down"
          value={String(bucket.downCycles)}
        />
      )}
      <TooltipRow
        color={VX.neutral}
        shape="bar"
        label="Measured"
        value={`${bucket.count} of ${expectedCycles} expected cycles`}
      />
    </>
  )
}

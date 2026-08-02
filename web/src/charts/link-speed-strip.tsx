import { useCallback, useContext, useMemo, useRef } from 'react'
import { scaleBand } from '@visx/scale'
import {
  AxisBottomDate,
  ChartTooltip,
  Crosshair,
  HoverContext,
  ResponsiveChart,
  TooltipBody,
  TooltipHeader,
  TooltipRow,
  VX,
  alpha,
  useHoverSync,
  useTooltipStyles,
} from 'basalt-ui/charts'
import type { ProbeBucketSeconds, VantageBucket } from '../lib/types'
import type { LinkBucketState } from '../lib/vantage'
import { linkBucketState } from '../lib/vantage'
import { densifyBuckets } from '../lib/densify'
import { fmtDateTime } from '../lib/format'
import { AXIS_LABEL_PX, axisTickValues, bucketAxisLabel } from '../lib/axis'
import { foldSourceIndex } from './fold'
import { HatchPattern, hatchFill } from './hatch'
import { PointerOverlay } from './pointer-overlay'
import { SyncedTip } from './synced-tip'

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
 *
 * These stay the CEILING, not the drawn inset — `StripPlot`'s `plotLeft`/`plotRight` scale them
 * down at narrow widths (see `availability-strip.tsx`, which this file mirrors verbatim).
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
  bucketStart: number
  /** The pre-formatted axis label, which is also the band scale's domain value. `AxisBottomDate`
   * takes no `tickFormat` and reduces an ISO string to `DD.MM`, so this is the only way a time of
   * day reaches the axis — the same mechanism `availability-strip.tsx` uses. */
  label: string
  state: LinkBucketState
}

/** A drawn column, after folding. `foldedFrom` is 1 for a column drawn straight from the response
 * and >1 when it stands in for that many source columns — see `foldStates`. `unmeasuredMembers` is
 * how many of those source columns were `unmeasured` — `foldStates`'s own `kind` says what the
 * MEASURED members reported, never how much of the span they actually cover, and `StripPlot` needs
 * the coverage to avoid painting a 1-of-3-measured column as a fully-confident reading. */
type PlotColumn = Column & { foldedFrom: number; unmeasuredMembers: number }

/**
 * Aggregates columns down to at most `cap` slots — the same sub-pixel pitch problem
 * `availability-strip.tsx` fixes (289 columns over a narrow plot draws every bar at a flat 1px),
 * and the same MAX-never-mean argument this file's own guide copy already makes: the mean of 1000
 * and 100 is 550, a rate the link never ran at for a moment. That argument holds identically for a
 * *folded* span, and the fold rule below is built to keep it true:
 *
 *   - any member `transition` -> the folded slot is `transition`, over the union of every distinct
 *     speed any member reported (a fold can only widen the set of speeds seen, never narrow it);
 *   - all members `steady` but disagreeing on `mbit` -> ALSO `transition` — the renegotiation IS
 *     inside the folded span even though no single source bucket straddled it;
 *   - all members `steady` and agreeing -> `steady` at that one speed;
 *   - otherwise `no-vantage` (something was measured, just not a speed) when any member was;
 *   - `unmeasured` only when EVERY member is `unmeasured` — a group with any `no-vantage` or
 *     `steady` member was measured, and folding it to unmeasured would claim less was recorded
 *     than actually was.
 *
 * That last rule is honest about what `kind` MEANS (a speed genuinely was negotiated somewhere in
 * this span) but says nothing about how much of the span it covers — `[1000 Mbit, absent, absent]`
 * folds to `steady` at 1000 Mbit under this rule, correctly, and `StripPlot` used to fill the WHOLE
 * column at that reading, incorrectly: two-thirds of the span reported nothing. `unmeasuredMembers`
 * carries the count needed to hatch that share instead of painting over it.
 */
export function foldColumns(columns: Column[], cap: number): PlotColumn[] {
  if (cap <= 0) return []
  if (columns.length <= cap)
    return columns.map((c) => ({ ...c, foldedFrom: 1, unmeasuredMembers: c.state.kind === 'unmeasured' ? 1 : 0 }))

  const groupSize = Math.ceil(columns.length / cap)
  const folded: PlotColumn[] = []
  for (let i = 0; i < columns.length; i += groupSize) {
    const group = columns.slice(i, i + groupSize)
    const first = group[0]
    if (first === undefined) continue
    const unmeasuredMembers = group.filter((c) => c.state.kind === 'unmeasured').length
    folded.push({
      ...first,
      state: foldStates(group.map((c) => c.state)),
      foldedFrom: group.length,
      unmeasuredMembers,
    })
  }
  return folded
}

/** Stable across renders, unlike an inline arrow — see `availability-strip.tsx`'s identical
 * constant for why an unstable `getKey` defeats `useHoverSync`'s own memoization. */
const getColumnLabel = (c: PlotColumn): string => c.label

export function foldStates(states: LinkBucketState[]): LinkBucketState {
  const mbits = new Set<number>()
  let anyTransition = false
  let anySteady = false
  let anyNoVantage = false
  let noVantageCycles = 0

  for (const s of states) {
    if (s.kind === 'steady') {
      mbits.add(s.mbit)
      anySteady = true
    } else if (s.kind === 'transition') {
      for (const m of s.mbits) mbits.add(m)
      anyTransition = true
    } else if (s.kind === 'no-vantage') {
      anyNoVantage = true
      noVantageCycles += s.cycles
    }
    // 'unmeasured' contributes nothing to any of the above.
  }

  if (anyTransition || mbits.size > 1) return { kind: 'transition', mbits: [...mbits].toSorted((a, b) => a - b) }
  if (anySteady) return { kind: 'steady', mbit: [...mbits][0]! }
  if (anyNoVantage) return { kind: 'no-vantage', cycles: noVantageCycles }
  return { kind: 'unmeasured' }
}

/** The follower's own value, or `null` to render no follower at all — an absent/no-vantage slot has
 * nothing to say, and a follower reading "—" would assert a measured absence. */
function followerLinkValue(state: LinkBucketState): string | null {
  if (state.kind === 'steady') return `${state.mbit} Mbit`
  if (state.kind === 'transition') return 'Renegotiated'
  return null
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
        bucketStart: slot.bucketStart,
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
    // See `availability-strip.tsx`'s identical wrapper for why this is a floor, not a height.
    <div style={{ minHeight: STRIP_HEIGHT + AXIS_HEIGHT }}>
      <ResponsiveChart height={STRIP_HEIGHT + AXIS_HEIGHT}>
        {({ width }) => <StripPlot columns={columns} maxMbit={maxMbit} width={width} />}
      </ResponsiveChart>
    </div>
  )
}

function StripPlot({ columns, maxMbit, width }: { columns: Column[]; maxMbit: number; width: number }) {
  const tooltipStyles = useTooltipStyles()
  const absentHatchId = 'link-speed-strip-absent'
  const svgRef = useRef<SVGSVGElement | null>(null)

  // Width-relative insets — see `availability-strip.tsx`'s identical constants for the argument.
  const plotLeft = Math.min(PLOT_LEFT, Math.round(width * 0.14))
  const plotRight = Math.min(PLOT_RIGHT, Math.round(width * 0.12))
  const plotWidth = Math.max(0, width - plotLeft - plotRight)

  // `/ 3`, not `/ 2` — see `availability-strip.tsx`'s identical constant for why the wider margin
  // is needed: a `/ 2` cap leaves no room for a partial fold's fill/hatch split to render as two
  // visibly distinct pieces.
  const plotColumns = useMemo(() => foldColumns(columns, Math.floor(plotWidth / 3)), [columns, plotWidth])
  // Memoized — see `availability-strip.tsx`'s identical `labels`/`scale` for why an unmemoized
  // `scaleBand` call defeats the point of the `bandCenter` callback below.
  const labels = useMemo(() => plotColumns.map((c) => c.label), [plotColumns])
  const scale = useMemo(() => scaleBand<string>({ domain: labels, range: [0, plotWidth] }), [labels, plotWidth])
  // See `availability-strip.tsx`'s identical `sourceIndex` — resolves a key the latency chart
  // broadcasts from its full, unfolded space to the folded column that contains it.
  const sourceIndex = useMemo(() => foldSourceIndex(columns, plotColumns), [columns, plotColumns])
  const hoverCtx = useContext(HoverContext)

  const bandCenter = useCallback(
    (label: string) => {
      const v = scale(label)
      return v === undefined ? undefined : v + scale.bandwidth() / 2
    },
    [scale],
  )

  // This is the chart where the shared cursor pays most — its whole subject is *when did the NIC
  // renegotiate*, and correlating a transition column with the latency spike above it used to be a
  // manual eyeball across two cards. `useHoverSync` replaces the bare `useChartTooltip` this strip
  // shipped with, the same wiring `availability-strip.tsx` gets.
  const { tip, tooltipRef, isDirectHover, handleMouse, handleLeave } = useHoverSync<PlotColumn>({
    data: plotColumns,
    chartId: 'link-speed-strip',
    getKey: getColumnLabel,
    xScale: bandCenter,
    marginLeft: plotLeft,
  })
  // See `availability-strip.tsx`'s identical override of the hook's own `syncedPoint`.
  const syncedPoint = hoverCtx.key ? (sourceIndex.get(hoverCtx.key) ?? null) : (tip?.data ?? null)

  if (width < plotLeft + plotRight + 20 || plotColumns.length === 0) return null

  const height = STRIP_HEIGHT
  const step = plotWidth / plotColumns.length
  const barWidth = Math.max(step - 1, 1)
  // See `availability-strip.tsx`'s identical constant — the hatch repeat shrunk to fit the column
  // rather than left at a fixed size a narrow bar cannot show even one full diagonal rule of.
  const hatchSize = Math.max(2, Math.min(5, Math.round(barWidth)))

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={svgRef}
        width={width}
        height={STRIP_HEIGHT + AXIS_HEIGHT}
        role="img"
        aria-label="Negotiated link speed per bucket, with unmeasured buckets hatched and renegotiations marked rather than averaged"
      >
        <defs>
          <HatchPattern id={absentHatchId} color={VX.neutral} opacity={0.7} size={hatchSize} />
        </defs>
        <g transform={`translate(${plotLeft}, 0)`}>
          {plotColumns.map((column, i) => {
            // See `availability-strip.tsx`'s identical fraction — the share of this column's own
            // span no member measured, drawn hatched instead of being silently absorbed into
            // whatever the measured members reported: `[1000 Mbit, absent, absent]` used to paint a
            // solid 1000 Mbit column, asserting a reading for two absent buckets.
            const unmeasuredFrac = column.unmeasuredMembers / column.foldedFrom
            const measuredWidth = barWidth * (1 - unmeasuredFrac)
            const hatchWidth = barWidth - measuredWidth
            return (
              <g key={column.key}>
                {measuredWidth > 0 && (
                  <rect
                    x={i * step}
                    y={0}
                    width={measuredWidth}
                    height={height}
                    rx={1}
                    fill={columnFill(column.state, maxMbit, absentHatchId)}
                    // The overlay now owns hit-testing (below); these rects only paint.
                    pointerEvents="none"
                  />
                )}
                {hatchWidth > 0 && (
                  <rect
                    x={i * step + measuredWidth}
                    y={0}
                    width={hatchWidth}
                    height={height}
                    rx={1}
                    fill={hatchFill(absentHatchId)}
                    pointerEvents="none"
                  />
                )}
                {column.state.kind === 'transition' && (
                  <rect
                    x={i * step}
                    y={MARKER_INSET}
                    width={measuredWidth}
                    height={Math.max(2, height - 2 * MARKER_INSET)}
                    rx={1}
                    fill={VX.warnSolid}
                    pointerEvents="none"
                  />
                )}
              </g>
            )
          })}
          {syncedPoint && (
            <Crosshair
              x={(scale(syncedPoint.label) ?? 0) + scale.bandwidth() / 2}
              top={0}
              bottom={STRIP_HEIGHT}
            />
          )}
          <PointerOverlay
            width={plotWidth}
            height={STRIP_HEIGHT}
            onMove={handleMouse}
            onLeave={handleLeave}
            active={tip !== null || syncedPoint !== null}
          />
          {/* `axisTickValues` rather than `smartTicks`, for the reason its docblock gives: the latter
            appends the final value unconditionally and the last two labels overlap. */}
          <AxisBottomDate
            scale={scale}
            top={STRIP_HEIGHT}
            tickValues={axisTickValues(labels, plotWidth, AXIS_LABEL_PX)}
          />
        </g>
      </svg>
      <ChartTooltip tip={isDirectHover ? tip : null} tooltipRef={tooltipRef} styles={tooltipStyles}>
        {tip && (
          <>
            <TooltipHeader date={fmtDateTime(tip.data.bucketStart)} label="Link speed" labelColor={VX.line} />
            <TooltipBody>
              <StateRows column={tip.data} />
            </TooltipBody>
          </>
        )}
      </ChartTooltip>
      {!isDirectHover &&
        syncedPoint !== null &&
        followerLinkValue(syncedPoint.state) !== null && (
          <SyncedTip
            svgRef={svgRef}
            x={plotLeft + (scale(syncedPoint.label) ?? 0) + scale.bandwidth() / 2}
            styles={tooltipStyles}
          >
            <TooltipBody>
              <TooltipRow color={VX.line} shape="bar" label="Link" value={followerLinkValue(syncedPoint.state) ?? ''} />
              {/* See `availability-strip.tsx`'s identical caveat row — `followerLinkValue` reads
                  `state.kind`, which is set by the measured members alone and says nothing about how
                  much of the folded span they cover. A 1-of-3-measured fold reports "Link: 1000
                  Mbit" here exactly as confidently as a fully-measured one, with no header on this
                  chip naming the column to let a reader spot the difference. */}
              {syncedPoint.unmeasuredMembers > 0 && syncedPoint.unmeasuredMembers < syncedPoint.foldedFrom && (
                <TooltipRow
                  color={VX.neutral}
                  shape="dot"
                  label="Partial"
                  value={`${syncedPoint.foldedFrom - syncedPoint.unmeasuredMembers} of ${syncedPoint.foldedFrom} buckets`}
                />
              )}
            </TooltipBody>
          </SyncedTip>
        )}
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

function StateRows({ column }: { column: PlotColumn }) {
  const state = column.state
  // Named whenever more than one source bucket stands behind this column — see `foldColumns`. A
  // partial fold gets its own clause, matching `availability-strip.tsx`'s identical row: the fill
  // already hatches the unmeasured share, and the tooltip has to say the same thing in words.
  const foldedRow = column.foldedFrom > 1 && (
    <TooltipRow
      color={VX.neutral}
      shape="bar"
      label="Folded from"
      value={
        column.unmeasuredMembers > 0 && column.unmeasuredMembers < column.foldedFrom
          ? `${column.foldedFrom} buckets, ${column.unmeasuredMembers} not measured`
          : `${column.foldedFrom} buckets`
      }
    />
  )

  if (state.kind === 'unmeasured') {
    return (
      <>
        <TooltipRow color={VX.neutral} shape="bar" label="Not measured" value="no cycles" />
        {foldedRow}
      </>
    )
  }
  if (state.kind === 'no-vantage') {
    return (
      <>
        <TooltipRow
          color={VX.neutral}
          shape="bar"
          label="No link speed reported"
          value={`${state.cycles} cycles`}
        />
        {foldedRow}
      </>
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
        {foldedRow}
      </>
    )
  }
  return (
    <>
      <TooltipRow color={VX.line} shape="bar" label="Negotiated" value={`${state.mbit} Mbit`} />
      {foldedRow}
    </>
  )
}

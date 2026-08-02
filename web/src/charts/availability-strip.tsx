import { useCallback, useMemo, useRef } from 'react'
import { scaleBand } from '@visx/scale'
import {
  AxisBottomDate,
  ChartTooltip,
  Crosshair,
  HoverOverlay,
  ResponsiveChart,
  TooltipBody,
  TooltipHeader,
  TooltipRow,
  VX,
  alpha,
  useHoverSync,
  useTooltipStyles,
} from 'basalt-ui/charts'
import type { ProbeBucket, ProbeBucketSeconds, TargetName } from '../lib/types'
import { TARGET_LABEL } from '../lib/types'
import { densifyBuckets } from '../lib/densify'
import { PROBE_CYCLE_MS } from '../lib/range'
import { fmtDateTime, fmtPct } from '../lib/format'
import { AXIS_LABEL_PX, axisTickValues, bucketTickFormat } from '../lib/axis'
import { PendingChart } from './pending'
import { foldSourceIndex } from './fold'
import { HatchPattern, hatchFill } from './hatch'
import { SyncedTip } from './synced-tip'

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

/**
 * Horizontal room the edge axis labels need, in px.
 *
 * The strip drew its columns edge to edge and its bottom axis centred each label on its own tick,
 * so the first label — the window's start time, the one fact the axis exists to give — was cut in
 * half by the left edge of the SVG and the last by the right. Half a label width on each side is
 * what a centred label at x=0 needs; `AXIS_LABEL_PX` is the width `bucketAxisLabel`'s richest form
 * measures, so half of it is exactly the inset. The left side takes the wider of that and the
 * chart gutter the plots below use, so the strip's columns line up with theirs — they share a
 * hover cursor, and two time axes that start at different x are two axes the eye cannot compare.
 *
 * These stay the CEILING, not the drawn inset — see `StripPlot`'s `plotLeft`/`plotRight`, which
 * scale them down at narrow widths. Do not lower these constants themselves and do not try to make
 * this strip's origin match the latency chart's 56 or throughput's 72 exactly: each of those is
 * justified by its own documented clipped-label bug, and the shared cursor is correct regardless
 * of origin because every synced chart maps the broadcast key through its own scale.
 */
const PLOT_LEFT = Math.max(56, Math.round(AXIS_LABEL_PX / 2))
const PLOT_RIGHT = Math.round(AXIS_LABEL_PX / 2)

type Column = {
  /** The bucket's ISO start. The band scale's domain value, the broadcast hover key and
   * `foldSourceIndex`'s key — an identity, never a rendering. The axis label is derived from it at
   * draw time by `bucketTickFormat`; this used to carry a pre-formatted `label` alongside, because
   * `AxisBottomDate` took no `tickFormat` and a display string was the only thing that reached the
   * axis. See `lib/axis.ts`. */
  key: string
  bucketStart: number
  bucket: ProbeBucket | null
}

/** A drawn column, after folding. `foldedFrom` is 1 for a column drawn straight from the response
 * and >1 when it stands in for that many source columns — see `foldColumns`. `unmeasuredMembers`
 * is how many of those source columns had no bucket at all: `foldedFrom` alone cannot say whether
 * a 3:1 fold is fully measured or two-thirds absent, and `StripPlot` needs that count to draw the
 * absent share rather than silently absorb it (see the component's docblock). */
type PlotColumn = Column & { foldedFrom: number; unmeasuredMembers: number }

/**
 * Aggregates the drawn columns down to at most `cap` slots, for widths where the raw one-column-
 * per-bucket grid sub-pixels and overlaps — 288 buckets over a 234 px plot is a 0.81 px pitch, so
 * `barWidth = Math.max(step - 1, 1)` draws every column at a flat 1 px and a single 100%-loss
 * bucket can be overdrawn by its neighbour.
 *
 * MAXIMUM, never the mean, for `lossPct`/`maxLossPct`: averaging a fully-down bucket into its
 * clean neighbours is exactly the fabrication this dashboard exists to refuse — the mean of 0% and
 * 100% loss describes a bucket that never happened. `count` and `downCycles` SUM instead: a cycle
 * count is additive across the folded span the same way `count` already was, and the two were
 * inconsistent — `downCycles` used max beside a summed `count`, which understated "cycles fully
 * down" the moment a fold's worst member wasn't also its most-measured one. The folded column's
 * identity (`key`/`label`/`bucketStart`) comes from its FIRST member, so the axis stays monotone
 * and the hover key still names a real bucket start rather than an invented midpoint.
 *
 * `unmeasuredMembers` is carried through unconditionally, including the `measured.length === 0`
 * branch where it always equals `group.length` — `StripPlot` derives one absence fraction from it
 * for BOTH a partial and a fully-unmeasured fold rather than branching on which case it is.
 */
export function foldColumns(columns: Column[], cap: number): PlotColumn[] {
  if (cap <= 0) return []
  if (columns.length <= cap)
    return columns.map((c) => ({ ...c, foldedFrom: 1, unmeasuredMembers: c.bucket === null ? 1 : 0 }))

  const groupSize = Math.ceil(columns.length / cap)
  const folded: PlotColumn[] = []
  for (let i = 0; i < columns.length; i += groupSize) {
    const group = columns.slice(i, i + groupSize)
    const first = group[0]
    if (first === undefined) continue
    const measured = group.filter((c): c is Column & { bucket: ProbeBucket } => c.bucket !== null)
    const unmeasuredMembers = group.length - measured.length
    if (measured.length === 0) {
      folded.push({ ...first, bucket: null, foldedFrom: group.length, unmeasuredMembers })
      continue
    }
    folded.push({
      ...first,
      bucket: {
        ...measured[0]!.bucket,
        lossPct: Math.max(...measured.map((c) => c.bucket.lossPct)),
        maxLossPct: Math.max(...measured.map((c) => c.bucket.maxLossPct)),
        downCycles: measured.reduce((sum, c) => sum + c.bucket.downCycles, 0),
        count: measured.reduce((sum, c) => sum + c.bucket.count, 0),
      },
      foldedFrom: group.length,
      unmeasuredMembers,
    })
  }
  return folded
}

/** Stable across renders, unlike an inline arrow — `useHoverSync` rebuilds its 288-entry key→point
 * Map whenever `getKey`'s identity changes, and an inline `(c) => c.key` is a new function every
 * render of a page that re-renders on a 30 s heartbeat. */
const getColumnKey = (c: PlotColumn): string => c.key

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
  isPending,
}: {
  /** Which target's buckets these are — the tooltip names it rather than assuming the WAN anchor. */
  target: TargetName
  buckets: ProbeBucket[]
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
  /**
   * True while the probe-buckets query behind this strip is in flight.
   *
   * The strip had no such guard, and it is the chart on the page where the absence of one is
   * loudest: `densifyBuckets` fills every slot in the window the moment it is called, so an
   * unresolved query drew a fully-hatched 24 h band — "the collector watched this whole window and
   * recorded nothing", asserted over a question nobody had answered yet. The route loader warms
   * this query, which is exactly why it went unnoticed: the state is unreachable on a cold load
   * and reachable on every range change, and the loader guarantee is route config a later edit can
   * silently remove.
   */
  isPending?: boolean
}) {
  const columns: Column[] = useMemo(
    () =>
      densifyBuckets(buckets, { from, to, bucketSeconds }).map((slot) => ({
        key: slot.key,
        bucketStart: slot.bucketStart,
        bucket: slot.value,
      })),
    [buckets, from, to, bucketSeconds],
  )
  // Arithmetic over the configured cadence, not a count of anything — named "expected" wherever
  // it is shown, the same as in the latency chart's tooltip.
  const expectedCycles = Math.max(1, Math.round((bucketSeconds * 1000) / PROBE_CYCLE_MS))

  return (
    // A floor, not a height. `ResponsiveChart` draws nothing until `useParentSize` has measured in an
    // effect, so every mount contributes 0px for one frame — which under a sticky header is the page
    // visibly dropping and snapping back every time a section view is switched.
    <div style={{ minHeight: STRIP_HEIGHT + AXIS_HEIGHT }}>
      {isPending === true ? (
        <PendingChart height={STRIP_HEIGHT + AXIS_HEIGHT} />
      ) : (
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
      )}
    </div>
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
  const absentHatchId = 'availability-strip-absent'
  const svgRef = useRef<SVGSVGElement | null>(null)

  // The insets are half an axis-label width, which is right at 1548px and absurd at 390 — 104px of a
  // 338px chart spent on empty gutter, for a strip that has no left axis at all. Capped at an eighth
  // of the width each so a phone keeps its plot. (PLOT_LEFT/PLOT_RIGHT's own docblock explains why
  // the constants themselves stay the ceiling.)
  const plotLeft = Math.min(PLOT_LEFT, Math.round(width * 0.14))
  const plotRight = Math.min(PLOT_RIGHT, Math.round(width * 0.12))
  const plotWidth = Math.max(0, width - plotLeft - plotRight)

  // Folded to the measured width BEFORE the scale is built, so the scale's domain — and therefore
  // the hover key space — is the folded grid, not the raw one.
  //
  // `/ 3`, not `/ 2`: a `/ 2` cap floors `barWidth` at ~1px, which is enough room for the FULL
  // column but not for a partial fold's fill/hatch split inside it — a 1-of-3-measured column at
  // that width draws a 0.5px fill next to a 1px hatch, both of which antialias into a smudge no
  // reader can tell apart from a fully-measured column. `/ 3` trades some of that resolution back
  // for the room the split needs to render as two visibly distinct pieces.
  const plotColumns = useMemo(() => foldColumns(columns, Math.floor(plotWidth / 3)), [columns, plotWidth])
  // Memoized so `scale` below is referentially stable across renders that don't change the fold —
  // `scaleBand` and the `xScale` wrapper closing over it are otherwise rebuilt every render, which
  // invalidates `useHoverSync`'s `handleMouse` callback identity for no reason.
  const keys = useMemo(() => plotColumns.map((c) => c.key), [plotColumns])
  // The band scale is built before the width guard's early return so the hook order below it stays
  // fixed; `scaleBand` is a plain call, not a hook, so this is only ordering hygiene for readers.
  const scale = useMemo(() => scaleBand<string>({ domain: keys, range: [0, plotWidth] }), [keys, plotWidth])
  // Every source (unfolded) column's key, resolved to the folded column that swallowed it — see
  // `foldSourceIndex`. This is what lets the crosshair follow a key broadcast by the latency chart,
  // which keys all 288 raw buckets rather than this strip's folded ~96.
  const sourceIndex = useMemo(() => foldSourceIndex(columns, plotColumns), [columns, plotColumns])

  // `+ bandwidth()/2` is mandatory. `useHoverSync`'s nearest-point loop compares the pointer against
  // `xScale(getKey(d))`, and `scaleBand` returns the band's LEFT edge — passing `scale` raw biases
  // every snap by half a column, which at 288 columns is a systematic one-bucket-early cursor.
  const bandCenter = useCallback(
    (key: string) => {
      const v = scale(key)
      return v === undefined ? undefined : v + scale.bandwidth() / 2
    },
    [scale],
  )
  // The `resolveKey` seam, and the reason this file no longer reads `HoverContext` itself. The hook
  // resolves a sibling's broadcast key by exact string match against its own drawn points, which on
  // a folded chart misses two keys in three; this overrides just that lookup. It was previously
  // done by reading the context directly and shadowing the hook's own `syncedPoint` — same result,
  // but it duplicated the hook's provider-vs-standalone fallback (`tip?.data ?? null`) at the call
  // site, where it could drift from the hook's.
  const resolveKey = useCallback((key: string) => sourceIndex.get(key) ?? null, [sourceIndex])

  // This strip's own docblock has claimed since it was written that it shares a hover cursor with the
  // plots below, and pinned PLOT_LEFT to match their gutter for exactly that reason. The alignment
  // shipped; the sync did not — it was on bare `useChartTooltip` and the provider mounted around the
  // whole chart region never saw it. Its key is the same bucket ISO start `densifyBuckets` gives
  // the latency chart over the same window, so the key space needed no design, only wiring.
  const { tip, tooltipRef, syncedPoint, isDirectHover, handleMouse, handleLeave } = useHoverSync<PlotColumn>({
    data: plotColumns,
    chartId: 'availability-strip',
    getKey: getColumnKey,
    xScale: bandCenter,
    // `localPoint` returns SVG-viewport coordinates, so this is PLOT_LEFT even though the overlay
    // sits inside the translated <g>.
    marginLeft: plotLeft,
    resolveKey,
  })

  if (width < plotLeft + plotRight + 20 || plotColumns.length === 0) return null

  const step = plotWidth / plotColumns.length
  const barWidth = Math.max(step - 1, 1)
  // The hatch pattern's own repeat, shrunk to fit the column rather than left at the fixed 5px tuned
  // for a full-width column. At barWidth ~1.5px a size-5 pattern draws less than one diagonal rule
  // per column — the fill/hatch split it is meant to texture reads as a single faint smudge instead
  // of two distinct pieces. Floored at 2 (below that the stroke itself has nothing to render on).
  const hatchSize = Math.max(2, Math.min(5, Math.round(barWidth)))

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={svgRef}
        width={width}
        height={STRIP_HEIGHT + AXIS_HEIGHT}
        role="img"
        aria-label={`${TARGET_LABEL[target]} availability in ${Math.round(bucketSeconds / 60)}-minute buckets, with unmeasured buckets marked`}
      >
        <defs>
          <HatchPattern id={absentHatchId} color={VX.neutral} opacity={0.7} size={hatchSize} />
        </defs>
        {/* Columns and axis share one translated group, so the axis ticks land under the columns
            they label — the inset is the plot's origin, not a decoration applied to one of them. */}
        <g transform={`translate(${plotLeft}, 0)`}>
          {plotColumns.map((column, i) => {
            // The share of this column's own span that no member measured — 0 for an unfolded or
            // fully-measured column, 1 for a fully-unmeasured one, and anything between for a fold
            // that is genuinely part absent. Drawing that share hatched, rather than letting the
            // measured members' fill cover the whole width, is the fix: a 1-of-3-measured fold used
            // to paint as a clean, fully-measured column because `columnFill` only ever saw the
            // measured members' aggregate, never the fact that two-thirds of the span had nothing
            // behind it.
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
                    height={STRIP_HEIGHT}
                    rx={1}
                    fill={columnFill(column.bucket, absentHatchId)}
                    pointerEvents="none"
                  />
                )}
                {hatchWidth > 0 && (
                  <rect
                    x={i * step + measuredWidth}
                    y={0}
                    width={hatchWidth}
                    height={STRIP_HEIGHT}
                    rx={1}
                    fill={hatchFill(absentHatchId)}
                    pointerEvents="none"
                  />
                )}
              </g>
            )
          })}
          {syncedPoint && (
            <Crosshair
              x={(scale(syncedPoint.key) ?? 0) + scale.bandwidth() / 2}
              top={0}
              bottom={STRIP_HEIGHT}
            />
          )}
          <HoverOverlay width={plotWidth} height={STRIP_HEIGHT} onMove={handleMouse} onLeave={handleLeave} />
          {/* `axisTickValues` rather than basalt's own `smartTicks`, for the reason its docblock
              gives: `smartTicks` appends the final value unconditionally and the last two labels
              land on top of each other. The tick VALUES are ISO bucket starts (the scale's domain);
              `bucketTickFormat` turns each into the time a reader sees — see `lib/axis.ts`. */}
          <AxisBottomDate
            scale={scale}
            top={STRIP_HEIGHT}
            tickValues={axisTickValues(keys, plotWidth, AXIS_LABEL_PX)}
            tickFormat={bucketTickFormat(bucketSeconds)}
          />
        </g>
      </svg>
      <ChartTooltip tip={isDirectHover ? tip : null} tooltipRef={tooltipRef} styles={tooltipStyles}>
        {tip && (
          <>
            <TooltipHeader
              date={fmtDateTime(tip.data.bucketStart)}
              label={TARGET_LABEL[target]}
              labelColor={VX.line}
            />
            <TooltipBody>
              <ColumnRows column={tip.data} expectedCycles={expectedCycles} />
            </TooltipBody>
          </>
        )}
      </ChartTooltip>
      {!isDirectHover && syncedPoint !== null && syncedPoint.bucket !== null && (
        <SyncedTip
          svgRef={svgRef}
          x={plotLeft + (scale(syncedPoint.key) ?? 0) + scale.bandwidth() / 2}
          styles={tooltipStyles}
        >
          <TooltipBody>
            <TooltipRow
              color={VX.badSolid}
              shape="bar"
              label="Loss"
              value={fmtPct(syncedPoint.bucket?.lossPct ?? null, 2)}
            />
            {/* The direct-hover tooltip has `ColumnRows`' own "Folded from" caveat; this chip has
                none, and a follower has no header naming the column it belongs to either — so a
                1-of-3-measured fold reads exactly like a fully-measured reading with nobody pointed
                at the difference. Suppressing the whole chip on a partial fold would be worse: it
                would draw nothing for a column that genuinely did measure something. */}
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

function ColumnRows({ column, expectedCycles }: { column: PlotColumn; expectedCycles: number }) {
  const bucket = column.bucket
  // `expectedCycles` is one bucket's worth; this column stands for `foldedFrom` of them, so the
  // denominator has to scale with the fold or a 3:1 fold prints "30 of 10 expected" (fully
  // measured) and a 1-of-3-measured fold prints "10 of 10 expected" — full coverage claimed over a
  // span that was two-thirds unmeasured.
  const totalExpected = expectedCycles * column.foldedFrom
  // The fold basis, named whenever more than one source bucket stands behind this column — see
  // `foldColumns`. A mark this dashboard draws with no register saying what it means is the same
  // defect the loss dots on the latency chart had. A genuinely partial fold gets its own clause:
  // the column's own fill already hatches the absent share, and the tooltip has to say the same
  // thing in words for a reader who cannot judge a few px of hatch by eye.
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

  if (bucket === null) {
    return (
      <>
        <TooltipRow
          color={VX.neutral}
          shape="bar"
          label="Not measured"
          value={`0 of ${totalExpected} expected cycles`}
        />
        {foldedRow}
      </>
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
        value={`${bucket.count} of ${totalExpected} expected cycles`}
      />
      {foldedRow}
    </>
  )
}

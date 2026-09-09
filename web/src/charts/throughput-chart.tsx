import { useMemo } from 'react'
import {
  type BandFold,
  type ChartMargin,
  type ChartSeries,
  MirroredBars,
  type MirroredBarPane,
  TooltipRow,
  VX,
} from 'basalt-ui/charts'
import { useInViewport } from './use-in-viewport'
import type { ProbeBucketSeconds, ThroughputBucket } from '../lib/types'
import { throughputPoints, type ThroughputPoint } from '../lib/throughput'
import { fmtBytes, fmtDateTime, fmtRate } from '../lib/format'
import { axisTickValues, bucketTickFormat } from '../lib/axis'

// 180, not 240. This is a two-sided bar chart with three y ticks per half and no line to trace,
// so the extra 60 px bought no resolution — it bought a section that pushed the one below it off
// the fold on a laptop. The dashboard's other full-width plot (the latency band, which does have a
// curve worth the pixels) is 190.
const CHART_HEIGHT = 180

/** Room for the time axis, and `VX.margin.bottom` restated — see `availability-strip.tsx`'s
 * identical constant for why a banded kind's plot height has to be backed out of `height`. */
const AXIS_HEIGHT = 30

/** The one-row legend band reserved out of the height handed to the kind. */
const LEGEND_BAND = 24

const CHART_FRAME_HEIGHT = CHART_HEIGHT + AXIS_HEIGHT + LEGEND_BAND

/** Nothing is drawn above the upload pane's own axis, so the top gutter is dead space — see
 * `availability-strip.tsx`'s identical override. */
const CHART_MARGIN: Partial<ChartMargin> = { top: 0 }

/** A drawn point, after folding. `foldedFrom` is 1 for a point drawn straight from the response and
 * >1 when it stands in for that many source buckets; `unmeasuredMembers` is how many of those had
 * no rate at all (`downBytesPerS === null`). Both are carried from CONSTRUCTION — `MirroredBars`
 * hands `getAbsentFraction` a datum and nothing else, so the fold's own bookkeeping has to ride on
 * the datum. `spanMs > 0` on the folded sum only says at least ONE member measured, not all of
 * them. */
export type PlotPoint = ThroughputPoint & { foldedFrom: number; unmeasuredMembers: number }

/**
 * How a group of adjacent buckets collapses into the one column drawn in its place, at widths where
 * one column per bucket sub-pixels.
 *
 * SUM, not mean: bytes are additive across a folded span (unlike the loss/link fields the strips
 * fold), so the folded rate is recomputed from summed bytes over summed measured time (`spanMs`),
 * never from averaging the per-slot rates — a fold that divides by the WRONG denominator is exactly
 * the bug `throughputPoints`'s own docblock records fixing once already. `intervals`/`skipped` also
 * sum, so the folded column's "Measured"/"Understated" rows stay honest about how many source
 * intervals stand behind it.
 *
 * `spanMs > 0` after summing only takes ONE measured member — `[measured, absent, absent]` sums to
 * a positive `spanMs` and a real rate. That rate is not wrong (it is the true rate over the time
 * that WAS measured), but drawing it across the full column width claims the other two-thirds of
 * the span agreed, which they never reported either way. `unmeasuredMembers` is what hatches that
 * share instead.
 */
export function mergePoints(group: PlotPoint[]): PlotPoint {
  const first = group[0]
  if (first === undefined) throw new Error('mergePoints: empty group')
  const downBytes = group.reduce((sum, p) => sum + p.downBytes, 0)
  const upBytes = group.reduce((sum, p) => sum + p.upBytes, 0)
  const spanMs = group.reduce((sum, p) => sum + p.spanMs, 0)
  return {
    ...first,
    downBytes,
    upBytes,
    spanMs,
    intervals: group.reduce((sum, p) => sum + p.intervals, 0),
    skipped: group.reduce((sum, p) => sum + p.skipped, 0),
    downBytesPerS: spanMs > 0 ? downBytes / (spanMs / 1000) : null,
    upBytesPerS: spanMs > 0 ? upBytes / (spanMs / 1000) : null,
    foldedFrom: group.reduce((sum, p) => sum + p.foldedFrom, 0),
    unmeasuredMembers: group.reduce((sum, p) => sum + p.unmeasuredMembers, 0),
  }
}

const FOLD: BandFold<PlotPoint> = { merge: mergePoints }

/** Stable across renders — see `availability-strip.tsx`'s identical constant. */
const getPointKey = (p: PlotPoint): string => p.key

/** The share of a column's span no member measured. A fully-unmeasured slot is `1/1` unfolded and
 * `n/n` folded, so the one expression covers both and no branch is needed. */
const getAbsentFraction = (p: PlotPoint): number => p.unmeasuredMembers / p.foldedFrom

/** A partial bucket is drawn at reduced opacity and named in the tooltip. It is a real measurement
 * — just a short one — so dimming is the right weight: visible enough not to be read as complete,
 * not so loud as to be read as a fault. */
const getBarOpacity = (p: PlotPoint): number => (p.skipped > 0 ? 0.45 : 1)

/**
 * The three marks this chart draws, declared once.
 *
 * The legend used to be a hand-written array literal beside a set of `fill=` expressions that
 * repeated the same three tokens — so a retuned download hue moved the bars and left the legend
 * swatch behind, and nothing would have caught it. `MirroredBars` derives the legend, the bar
 * fills AND the tooltip rows from this one array: one edit moves all three.
 *
 * "Not measured" is a series here in the legend's sense but not in the data's — it has no values,
 * only an absence, which is why its `getValue` is `() => null` (the shipped legend-only idiom).
 * It has to be named on the legend all the same: a hatched column is the one mark on this chart a
 * reader cannot decode from the axes.
 */
const THROUGHPUT_SERIES: ChartSeries<PlotPoint>[] = [
  {
    key: 'down',
    label: 'Download',
    color: VX.accent,
    mark: 'bar',
    getValue: (p) => p.downBytesPerS,
    formatValue: (v, p) => `${fmtRate(v)} · ${fmtBytes(p.downBytes)}`,
  },
  // `VX.line2` — the MID grey, not `VX.line`, which is the brightest rule grey available on a dark
  // panel and as a dense mass of bars out-shouted the accent this chart's download half is drawn
  // in. Both are generated by basalt's derive engine, so no resolved hex or contrast ratio is
  // written here: quoting one would silently go stale the next time the palette is retuned. Three
  // earlier answers were worse: `VX.status.bad` drew ordinary outbound traffic as a fault, `VX.line`
  // sat too close in luminance to the never-measured grey, and a registered teal series separated
  // cleanly but read as loud as the red had. Blue against a mid grey is the calm version, and it
  // needs no series row — never-measured stays the light grey above it AND is hatched, so all three
  // are distinct.
  {
    key: 'up',
    label: 'Upload',
    color: VX.line2,
    mark: 'bar',
    getValue: (p) => p.upBytesPerS,
    formatValue: (v, p) => `${fmtRate(v)} · ${fmtBytes(p.upBytes)}`,
  },
  { key: 'absent', label: 'Not measured', color: VX.neutral, mark: 'bar', getValue: () => null },
]

/**
 * One pane per direction, each in its OWN domain — which is the whole reason this is `MirroredBars`
 * and not a two-series bar chart. A shared scale puts a 220 kB/s download and a 20 kB/s upload on
 * one axis and flattens the upload to a line along the baseline, and upload is the half that
 * actually explains a stalled video call.
 *
 * The upload pane's axis gets two ticks and the download pane's three: the download half is the
 * taller one (`upFraction` defaults to 0.35) and can carry the extra rule without crowding.
 */
const UP_PANE: MirroredBarPane = { key: 'up', ticks: 2, format: fmtRate }
const DOWN_PANE: MirroredBarPane = { key: 'down', ticks: 3, format: fmtRate }

/**
 * Down and up on one mirrored axis: download below the baseline, upload above it.
 *
 * Mirroring gives each direction the full height of its own half and makes the *ratio* legible at a
 * glance, which is the thing a household actually reads this for.
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
 * RULE forbids: a fully-hatched band asserting the whole window was watched and held nothing.
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
  const points: PlotPoint[] = useMemo(
    () =>
      throughputPoints(buckets, { from, to, bucketSeconds }).map((p) => ({
        ...p,
        foldedFrom: 1,
        unmeasuredMembers: p.downBytesPerS === null ? 1 : 0,
      })),
    [buckets, from, to, bucketSeconds],
  )
  const formatX = useMemo(() => bucketTickFormat(bucketSeconds), [bucketSeconds])
  const { ref: viewRef, inView } = useInViewport<HTMLDivElement>()

  return (
    // A floor, not a height — see `availability-strip.tsx`'s identical wrapper.
    <div ref={viewRef} style={{ minHeight: CHART_FRAME_HEIGHT }}>
      <MirroredBars
        data={points}
        chartId="throughput"
        getX={getPointKey}
        series={THROUGHPUT_SERIES}
        up={UP_PANE}
        down={DOWN_PANE}
        getAbsentFraction={getAbsentFraction}
        getBarOpacity={getBarOpacity}
        fold={FOLD}
        height={CHART_FRAME_HEIGHT}
        margin={CHART_MARGIN}
        formatX={formatX}
        xTickValues={axisTickValues}
        absentState="absent"
        isPending={isPending === true}
        ariaLabel="Data carried per bucket — download below the baseline, upload above it, with unmeasured buckets marked"
        // "Not measured" is a hatch, not a series with values, so a three-entry toggle would offer
        // to hide a state rather than a measurement. The two real halves are scaled independently
        // and drawn against one baseline; hiding one would leave the other reading against an axis
        // that no longer has an opposite.
        legend={{ toggle: false }}
        tooltip={{
          onFollow: inView,
          formatHeader: (_key, p) => fmtDateTime(p.bucketStart),
          label: () => ({ text: 'Carried', color: VX.accent }),
          extraRows: (p) => <PointRows point={p} />,
        }}
      />
    </div>
  )
}

/** The rows the derived per-series ones cannot carry — the measurement's basis, and the fold. */
function PointRows({ point }: { point: PlotPoint }) {
  return (
    <>
      {point.downBytesPerS === null ? (
        <TooltipRow
          color={VX.neutral}
          shape="bar"
          label="Not measured"
          value="no usable interval"
        />
      ) : (
        <>
          {/* The basis, always — the rate is bytes over *measured* time, and a bucket that measured
              2 of 20 intervals is a different claim from one that measured all 20. */}
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
    </>
  )
}

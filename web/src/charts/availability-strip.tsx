import { useMemo } from 'react'
import {
  type BandFold,
  type BandSpan,
  BandStrip,
  type BandStripSeries,
  type ChartTooltipRow,
} from 'basalt-ui/charts'
import { VX, alpha } from 'basalt-ui/tokens'
import { ABSENT_ALPHA, ABSENT_COLOR, foldedFromRows } from './band-shared'
import { useInViewport } from './use-in-viewport'
import type { ProbeBucket, ProbeBucketSeconds, TargetName } from '../lib/types'
import { TARGET_LABEL } from '../lib/types'
import { densifyBuckets } from '../lib/densify'
import { PROBE_CYCLE_MS } from '../lib/range'
import { fmtDateTime, fmtPct } from '../lib/format'
import { bucketTickFormat } from '../lib/axis'

/** Loss share at which a band is painted at full strength — the same absolute scale the
 * availability heatmap uses, so the two views of the same data agree on what "bad" looks like. */
const FULL_INTENSITY_LOSS_PCT = 5

/**
 * The floor under a measured band, so "measured, no loss" is a visible mark rather than blank
 * canvas. Without it a flawless bucket and an unmeasured one are both empty space.
 *
 * **NEUTRAL, and that is the fix.** This floor was the bad hue at 14% — the loss ramp's own bottom
 * step — so a window with not one lost packet painted a faint red wash from end to end, and the
 * chart that answers "was the line up" answered it in the colour this dashboard uses for "no". The
 * reader's report was exactly that: *why is reachability red all the time even though we are
 * online?* Nothing was numerically wrong; the ramp was continuous and 0% sat at its floor. But a
 * ramp that starts at "bad, faintly" has no colour left to mean "fine", and colour is the only
 * channel a strip this short has.
 *
 * So the ramp is split at zero. A clean bucket is neutral ink — present, measured, making no
 * claim. Loss is the bad hue, and it starts at `LOSS_FLOOR_ALPHA` rather than at nothing, so the
 * smallest recorded loss is visibly not clean. The step at the boundary is deliberate: any loss at
 * all is a different fact from none, and this is the chart that has to say so.
 */
const CLEAN_ALPHA = 0.14
const LOSS_FLOOR_ALPHA = 0.34

/**
 * The FRAME height — bands plus the axis — in every basalt kind (documented as of 2.10.0; there is
 * no `bandHeight` or `plotHeight`). The band row gets what the measured axis gutter (~21px) leaves
 * out of `height`: 65 gives the 44px band 1.41 drew, and 98 gave a 77px one in the browser. The
 * legend sits OUTSIDE this height, in its own row below the plot.
 */
const STRIP_FRAME_HEIGHT = 65

/**
 * One slot of the strip.
 *
 * `foldedFrom` is 1 for a band drawn straight from the response and >1 when it stands in for that
 * many source buckets; `unmeasuredMembers` is how many of those had no bucket at all. **Both are
 * carried from CONSTRUCTION, not derived in the merge**, because `getBand` never sees the fold's
 * own bookkeeping — the kind hands it a datum and nothing else — and an unfolded slot has to answer
 * the same question a folded one does. `foldedFrom` alone cannot say whether a 3:1 fold is fully
 * measured or two-thirds absent, and the absent share has to be drawn rather than silently
 * absorbed.
 */
export type Column = {
  /** The bucket's start, epoch ms: the strip's x (as a `Date`, the instant — never a display
   * string), the broadcast hover key and the cursor's resolution key. `bucketTickFormat` turns it
   * into the time a reader sees at draw time. See `lib/axis.ts`. */
  bucketStart: number
  bucket: ProbeBucket | null
  foldedFrom: number
  unmeasuredMembers: number
}

/**
 * How a group of adjacent slots collapses into the one band drawn in its place, at widths where
 * one band per bucket sub-pixels (288 buckets over a 234px plot is a 0.81px pitch).
 *
 * MAXIMUM, never the mean, for `lossPct`/`maxLossPct`: averaging a fully-down bucket into its clean
 * neighbours is exactly the fabrication this dashboard exists to refuse — the mean of 0% and 100%
 * loss describes a bucket that never happened. `count` and `downCycles` SUM instead: a cycle count
 * is additive across the folded span. The folded band's identity (`key`/`bucketStart`) comes from
 * its FIRST member, which `BandFold.merge` requires — otherwise the axis stops being monotone and
 * the cursor key stops naming a real bucket start.
 *
 * `foldedFrom`/`unmeasuredMembers` SUM rather than counting the group, so the arithmetic holds
 * whatever the group is made of and every source bucket is accounted for exactly once.
 */
export function mergeColumns(group: Column[]): Column {
  const first = group[0]
  if (first === undefined) throw new Error('mergeColumns: empty group')
  const measured = group.filter((c): c is Column & { bucket: ProbeBucket } => c.bucket !== null)
  const foldedFrom = group.reduce((sum, c) => sum + c.foldedFrom, 0)
  const unmeasuredMembers = group.reduce((sum, c) => sum + c.unmeasuredMembers, 0)
  const head = measured[0]
  if (head === undefined) return { ...first, bucket: null, foldedFrom, unmeasuredMembers }
  return {
    ...first,
    bucket: {
      ...head.bucket,
      lossPct: Math.max(...measured.map((c) => c.bucket.lossPct)),
      maxLossPct: Math.max(...measured.map((c) => c.bucket.maxLossPct)),
      downCycles: measured.reduce((sum, c) => sum + c.bucket.downCycles, 0),
      count: measured.reduce((sum, c) => sum + c.bucket.count, 0),
    },
    foldedFrom,
    unmeasuredMembers,
  }
}

const FOLD: BandFold<Column> = { merge: mergeColumns }

/** Stable across renders, unlike an inline arrow — the kind recompiles when `x` changes identity. */
const columnX = (c: Column): Date => new Date(c.bucketStart)

/**
 * Four states, four fills, and only two of them are the bad hue.
 *
 * A bucket where every cycle got nothing back is solid, not merely the top of the loss ramp: "the
 * line was gone for this whole bucket" and "this bucket lost 5% of its packets" are not
 * neighbouring intensities of one fact. A bucket that lost nothing is neutral, not the bottom of
 * that ramp, for the reason `CLEAN_ALPHA` gives at length. Only the loss state overrides its
 * series fill, because only it is a RAMP — the other three are one colour each and the series entry
 * already carries it.
 *
 * Exported for `availability-strip.test.ts`, which pins the one property no amount of prose keeps
 * true: a clean bucket and a lossy one must not be drawn in the same hue.
 */
export function getBand(c: Column): BandSpan {
  // `foldedFrom` is never 0 — it is 1 at construction and a sum of those in a merge — so the share
  // is always defined. The kind clamps a non-finite one anyway, to "nothing is absent".
  const absentFraction = c.unmeasuredMembers / c.foldedFrom
  const bucket = c.bucket
  if (bucket === null) return { state: 'absent', absentFraction }
  // `count > 0` guards the degenerate row: 0 down of 0 cycles is not a fully-down bucket, and
  // painting it solid would invent an outage out of an empty aggregate.
  if (bucket.count > 0 && bucket.downCycles >= bucket.count)
    return { state: 'down', absentFraction }
  if (bucket.lossPct <= 0) return { state: 'clean', absentFraction }
  const intensity = Math.min(1, bucket.lossPct / FULL_INTENSITY_LOSS_PCT)
  return {
    state: 'loss',
    absentFraction,
    fill: alpha(VX.badSolid, LOSS_FLOOR_ALPHA + (1 - LOSS_FLOOR_ALPHA) * intensity),
  }
}

/**
 * The reading behind whichever measured state a band is in — the derived row's value.
 *
 * `null`, not `''`, for a band with no bucket: `BandStripSeries.formatValue` reads it as an ABSENT
 * reading and prints an em dash, where `''` printed a label with a blank value — indistinguishable
 * from a state whose name is the whole reading. Unreachable by construction (`getBand` routes a
 * null bucket to `absent`, which formats itself), so this is the honest answer to a branch that
 * should never fire rather than a state the strip draws.
 */
const lossValue = (c: Column) => (c.bucket === null ? null : fmtPct(c.bucket.lossPct, 2))

/**
 * The strip's states, which on `BandStrip` are also its legend and its one derived tooltip row.
 *
 * `fillOpacity` mirrors the real alphas rather than a swatch-friendly constant, so the legend
 * cannot drift into describing a fill the chart does not draw. The loss swatch sits at the ramp's
 * midpoint: it stands for a range, not for one value. `formatValue` is what the derived row prints
 * — the state names itself, and the value is the reading behind it.
 *
 * Built per render rather than declared as a constant because the absent row's denominator scales
 * with the fold and with the bucket size.
 */
export function bandStates(expectedCycles: number): BandStripSeries<Column>[] {
  return [
    {
      key: 'clean',
      label: 'No loss',
      color: VX.neutral,
      fillOpacity: CLEAN_ALPHA,
      formatValue: lossValue,
    },
    {
      key: 'loss',
      label: 'Packet loss',
      color: VX.badSolid,
      fillOpacity: (LOSS_FLOOR_ALPHA + 1) / 2,
      formatValue: lossValue,
    },
    {
      key: 'down',
      label: 'Every cycle down',
      color: VX.badSolid,
      fillOpacity: 1,
      formatValue: lossValue,
    },
    {
      key: 'absent',
      label: 'Not measured',
      color: ABSENT_COLOR,
      fillOpacity: ABSENT_ALPHA,
      // `expectedCycles` is one bucket's worth; a folded band stands for `foldedFrom` of them, so
      // the denominator has to scale or a 3:1 fold claims full coverage over a span two-thirds of
      // which reported nothing.
      formatValue: (c) => `0 of ${expectedCycles * c.foldedFrom} expected cycles`,
    },
  ]
}

/**
 * The Now view's 24 h summary, and why it is not a sparkline.
 *
 * `Sparkline` takes `data: number[]` with no x accessor and no domain, so the
 * only way to feed them is to drop the buckets that measured nothing — and a dropped element is not
 * a gap, the array simply closes over it. Every 100%-loss bucket and every unmeasured bucket
 * shortened the array and the remaining points slid together into a continuous healthy trend, which
 * is a guaranteed-green summary regardless of what happened. A component that cannot express
 * absence must not be the 24 h headline.
 *
 * So: one band per bucket over the densified window (`densifyBuckets`), fixed count for a given
 * range whatever the response contains, and four visually distinct states — accent for a bucket
 * that was never measured, a loss ramp for one that was, and a solid bad band for one where every
 * cycle got nothing back. Absence is a flat fill in its own hue (`ABSENT_COLOR`), legended, and
 * `absentFraction` paints the share of a folded band nothing measured from the band's right edge.
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
   * unresolved query drew a fully-absent 24 h band — "the collector watched this whole window and
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
        bucketStart: slot.bucketStart,
        bucket: slot.value,
        foldedFrom: 1,
        unmeasuredMembers: slot.value === null ? 1 : 0,
      })),
    [buckets, from, to, bucketSeconds],
  )
  // Arithmetic over the configured cadence, not a count of anything — named "expected" wherever
  // it is shown, the same as in the latency chart's tooltip.
  const expectedCycles = Math.max(1, Math.round((bucketSeconds * 1000) / PROBE_CYCLE_MS))
  const states = useMemo(() => bandStates(expectedCycles), [expectedCycles])
  const formatX = useMemo(() => bucketTickFormat(bucketSeconds), [bucketSeconds])
  // The viewport gate every follower tooltip on this page needs — a follower tooltip is clamped
  // into the window, so an unconditional `onFollow` draws an off-screen chart's numbers over the
  // ones the reader is looking at. See `use-in-viewport.ts`.
  const { ref: viewRef, inView } = useInViewport<HTMLDivElement>()
  const label = `${TARGET_LABEL[target]} availability in ${Math.round(bucketSeconds / 60)}-minute buckets`
  const tooltip = useMemo(
    () => ({
      onFollow: inView,
      // From the instant, never from the key: a header regexed out of an ISO string and rebuilt as
      // a LOCAL date names the previous calendar day for every bucket after 22:00 local. See
      // `charts/tooltip-header.test.ts`.
      formatHeader: (_x: Date, c: Column) => fmtDateTime(c.bucketStart),
      rows: (c: Column) => columnRows(c, expectedCycles, TARGET_LABEL[target]),
    }),
    [inView, expectedCycles, target],
  )

  return (
    // A floor, not a height: the chart's measured height can arrive an effect late, so every mount
    // would contribute 0px for one frame — which under a sticky header is the page visibly dropping
    // and snapping back every time a section view is switched.
    <div ref={viewRef} style={{ minHeight: STRIP_FRAME_HEIGHT }}>
      <BandStrip
        data={columns}
        x={columnX}
        states={states}
        getBand={getBand}
        fold={FOLD}
        absentState="absent"
        height={STRIP_FRAME_HEIGHT}
        formatX={formatX}
        ariaLabel={`${label}, with unmeasured buckets marked`}
        state={{ pending: isPending === true }}
        // The legend toggles nothing: these four entries are STATES, not series with values, so
        // hiding one would remove a name from the key and change no mark — except `absent`, whose
        // toggle would zero every band's absent share and make a folded band read fully measured.
        // `state` conceals it while pending (basalt-ui 2.10.0).
        legend={{ toggle: false }}
        tooltip={tooltip}
      />
    </div>
  )
}

/**
 * The rows the derived one cannot carry.
 *
 * `BandStrip` derives exactly ONE row — the hovered band's state, named and formatted by its own
 * `states` entry — which is the row that cannot go stale. Everything a bucket reports beyond the
 * state it is in stays hand-authored here. The anchor the buckets belong to rides last: the 1.x
 * `tooltip.label` badge has no 2.x slot, and a bare strip must not read as the whole connection.
 */
export function columnRows(
  column: Column,
  expectedCycles: number,
  targetLabel: string,
): ChartTooltipRow[] {
  const bucket = column.bucket
  // `expectedCycles` is one bucket's worth; this band stands for `foldedFrom` of them, so the
  // denominator has to scale with the fold or a 3:1 fold prints "30 of 10 expected".
  const totalExpected = expectedCycles * column.foldedFrom
  const foldedRows = foldedFromRows(column.foldedFrom, column.unmeasuredMembers)
  const anchorRow: ChartTooltipRow = { label: 'Anchor', value: targetLabel }

  if (bucket === null) return [...foldedRows, anchorRow]

  return [
    { label: 'Worst cycle', value: fmtPct(bucket.maxLossPct), color: VX.warnSolid },
    ...(bucket.downCycles > 0
      ? [{ label: 'Cycles fully down', value: String(bucket.downCycles), color: VX.badSolid }]
      : []),
    {
      label: 'Measured',
      value: `${bucket.count} of ${totalExpected} expected cycles`,
      color: VX.neutral,
    },
    ...foldedRows,
    anchorRow,
  ]
}

// MIGRATION-STUB(w4): the BandStrip availability strip (states, loss ramp, fold, tooltip rows)
import { ChartCard } from 'basalt-ui/charts'
import type { ProbeBucket, ProbeBucketSeconds, TargetName } from '../lib/types'

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
  /** The bucket's ISO start: the band scale's domain value, the broadcast hover key and the
   * cursor's resolution key — an identity, never a rendering. `bucketTickFormat` turns it into the
   * time a reader sees at draw time. See `lib/axis.ts`. */
  key: string
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
 * its FIRST member, which `BandFold` requires — otherwise the axis stops being monotone and the
 * cursor key stops naming a real bucket start.
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
 * So: one band per bucket over the densified window (`densifyBuckets`), fixed count for a given
 * range whatever the response contains, and four visually distinct states — hatched for a bucket
 * that was never measured, a loss ramp for one that was, and a solid bad band for one where every
 * cycle got nothing back. Hatching is the dashboard's one vocabulary for absence, and `BandStrip`
 * ships it: `absentFraction` paints the share of a folded band nothing measured.
 */
export function AvailabilityStrip(_props: {
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
  return <ChartCard state={{ empty: 'Migrating to basalt-ui 2.0' }} />
}

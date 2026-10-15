// MIGRATION-STUB(w4): the MirroredBars throughput chart (down/up panes, fold, absent hatch, tooltip rows)
import { ChartCard } from 'basalt-ui/charts'
import type { ProbeBucketSeconds, ThroughputBucket } from '../lib/types'
import type { ThroughputPoint } from '../lib/throughput'

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
export function ThroughputChart(_props: {
  buckets: readonly ThroughputBucket[]
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
  /** True while the throughput query for this window is in flight — see the component docblock. */
  isPending?: boolean
}) {
  return <ChartCard state={{ empty: 'Migrating to basalt-ui 2.0' }} />
}

import { bucketAxisLabel } from './axis'
import { densifyBuckets } from './densify'
import { TARGETS, type ProbeBucket, type ProbeBucketSeconds, type TargetName } from './types'

/**
 * The three WAN anchors. `TARGETS` minus the gateway — derived rather than written out, so adding
 * an anchor to `TARGETS` adds it here too instead of silently leaving it out of every WAN figure.
 */
export const WAN_TARGETS: readonly TargetName[] = TARGETS.filter((t) => t !== 'gateway')

/**
 * One position on the comparison chart's axis: the LAN gateway and the WAN, side by side.
 *
 * This is the aggregation the four stacked per-target charts never performed. Reading them meant
 * comparing three near-identical WAN traces by eye across three cards to answer one question —
 * "is this the LAN or the internet" — which is the only question their difference actually
 * answers. Two lines answer it directly.
 */
export interface LatencyComparePoint {
  /** ISO-8601 of `bucketStart` — the identity of the slot, carried through from `densifyBuckets`. */
  key: string
  /**
   * The display label for this bucket, and the chart's categorical x key (`bucketAxisLabel`).
   *
   * Separate from `key` because the two answer different questions. `key` is an ISO instant and is
   * how a slot is identified; `label` is what a reader sees on the axis, and `basalt-ui`'s
   * `MultiLine` gives no way to format the axis other than through the value `getX` returns. Using
   * `key` there produced an axis reading `31.07` a dozen times over a 24 h window.
   */
  label: string
  bucketStart: number
  /** The gateway's own bucket median. One target, so this is a reading, not an aggregate. */
  gatewayMs: number | null
  /** Median of the WAN anchors' bucket medians — see `median`. */
  wanMs: number | null
  /** How many anchors that median was taken over, so the tooltip can state its own basis. */
  wanAnchors: number
  /** Worst aggregate loss across gateway and anchors alike, for the per-point marker. */
  worstLossPct: number
}

/**
 * The median of whatever reported, and `null` when nothing did.
 *
 * Deliberately not a mean: a single anchor routed badly for one bucket drags a mean of three and
 * leaves no trace of having done so, while a median of three ignores it and a median of two
 * reports the midpoint of a genuine disagreement. Neither hides the outlier — the per-target view
 * still holds every anchor separately, and this figure never claims to replace it.
 *
 * **A missing term is skipped, never counted as 0**, and `count` travels with the value so the
 * caller can state the basis it actually got. Counting a null as zero would report a *faster* WAN
 * for a bucket that measured less of it: an absent measurement rendered as a good one. Nothing at
 * all is `null` — unmeasured, not fast.
 *
 * Shared by the compare chart's WAN line and the KPI row's window medians; both need exactly this
 * null-skipping behaviour and neither may have its own copy of it.
 */
export function median(values: readonly (number | null)[]): { value: number | null; count: number } {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b)
  if (present.length === 0) return { value: null, count: 0 }
  const mid = Math.floor(present.length / 2)
  const value =
    present.length % 2 === 0
      ? // Both middle terms are real readings, so their midpoint is the median of an even sample —
        // not an invented value. `!` is unreachable given the length check.
        (present[mid - 1]! + present[mid]!) / 2
      : present[mid]!
  return { value, count: present.length }
}

/**
 * Fold per-target buckets into one gateway-vs-WAN series.
 *
 * Takes the already-densified slot list so unmeasured buckets stay unmeasured: a bucket the range
 * route returned no row for arrives here as a slot with no targets and leaves as `null` on both
 * lines, which the chart renders as a gap. Rebuilding the axis from the rows instead would join
 * the two sides of a hole into a continuous line — the failure `densifyBuckets` exists to prevent,
 * and it would reappear here if this function took raw rows.
 */
export function toComparePoints(
  slots: readonly { key: string; bucketStart: number; value: Map<string, ProbeBucket> | null }[],
  bucketSeconds: ProbeBucketSeconds,
): LatencyComparePoint[] {
  return slots.map((slot) => {
    const label = bucketAxisLabel(slot.bucketStart, bucketSeconds)
    const byTarget = slot.value
    if (byTarget === null) {
      return { key: slot.key, label, bucketStart: slot.bucketStart, gatewayMs: null, wanMs: null, wanAnchors: 0, worstLossPct: 0 }
    }

    const gateway = byTarget.get('gateway') ?? null
    const anchors = WAN_TARGETS.map((t) => byTarget.get(t) ?? null)
    const { value: wanMs, count: wanAnchors } = median(anchors.map((a) => a?.medianMs ?? null))

    // Across every target present, gateway included: the marker means "this bucket lost packets
    // somewhere", and excluding the gateway would hide LAN loss from the LAN-vs-WAN chart.
    const worstLossPct = [gateway, ...anchors].reduce((worst, b) => (b === null ? worst : Math.max(worst, b.lossPct)), 0)

    return {
      key: slot.key,
      label,
      bucketStart: slot.bucketStart,
      gatewayMs: gateway?.medianMs ?? null,
      wanMs,
      wanAnchors,
      worstLossPct,
    }
  })
}

/**
 * Four per-target range responses in, one comparison series out.
 *
 * The merge happens *before* densification, on purpose. Each target's rows are sparse in its own
 * places — an anchor can miss a bucket the others recorded — so densifying per target and zipping
 * the results afterwards would need a fifth pass to realign them and would let one target's hole
 * shift another's readings. Merging first means one union of bucket starts, and `densifyBuckets`
 * then imposes the window's own axis on it and throws if any row lands off-grid.
 *
 * A bucket where only some targets reported survives as a partial map, which is exactly what
 * `toComparePoints` needs to report an honest anchor count.
 */
export function comparePointsFrom(
  byTarget: ReadonlyMap<TargetName, readonly ProbeBucket[]>,
  opts: { from: number; to: number; bucketSeconds: ProbeBucketSeconds },
): LatencyComparePoint[] {
  const merged = new Map<number, Map<string, ProbeBucket>>()
  for (const [target, rows] of byTarget) {
    for (const row of rows) {
      const entry = merged.get(row.bucket) ?? new Map<string, ProbeBucket>()
      entry.set(target, row)
      merged.set(row.bucket, entry)
    }
  }

  const rows = [...merged.entries()]
    .map(([bucket, targets]) => ({ bucket, targets }))
    .sort((a, b) => a.bucket - b.bucket)

  return toComparePoints(
    densifyBuckets(rows, opts).map((slot) => ({
      key: slot.key,
      bucketStart: slot.bucketStart,
      value: slot.value?.targets ?? null,
    })),
    opts.bucketSeconds,
  )
}

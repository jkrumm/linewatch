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
 * The three WAN anchors folded into one series, in `ProbeBucket`'s own shape.
 *
 * Carries two fields a real bucket has no need for, because a folded bucket can misread in two
 * ways a single target's cannot: the reader cannot tell a three-anchor median from a one-anchor
 * median, and cannot tell "the internet lost packets" from "one anchor did".
 */
export type InternetBucket = ProbeBucket & {
  /** How many anchors reported anything at all in this bucket. Never 0 — a bucket no anchor
   * reported is not emitted. */
  anchors: number
  /** The worst aggregate loss any single anchor reported. `lossPct` is the median across anchors
   * and is the internet-wide figure; this is the outlier the median deliberately ignores. */
  worstAnchorLossPct: number
}

/**
 * Fold Cloudflare, Google and Quad9 into one "internet" bucket series.
 *
 * The dashboard drew these three as three near-identical stacked bands, and reading them meant
 * comparing three curves by eye to answer a question none of them asks individually: how bad is
 * the path off this machine. One anchor's own trace matters only when it disagrees with the other
 * two, which is a detail view's job — the per-target charts still draw all four in full.
 *
 * **Every statistic folds by the same rule the WAN median already uses: the median across the
 * anchors that reported it, nulls skipped rather than counted as 0.** A mean would let one badly
 * routed anchor drag the whole series with no trace of having done so; counting a missing anchor
 * as zero would report a *faster* internet for a bucket that measured less of it.
 *
 * Three fields do not fold that way, and each for a stated reason:
 *
 * - `minMs`/`maxMs` are the true floor and ceiling of individual pings, and the fold's floor and
 *   ceiling are the extremes across anchors, not the middle of them. `maxMs` is the only stored
 *   witness of a sub-cycle stall and taking its median would erase one.
 * - `maxLossPct` — the worst single cycle — takes the max, for the same reason: it is already an
 *   extreme statistic, and the median of three extremes is not one.
 * - `downCycles` is the only field where the honest answer is not derivable, and the fold refuses
 *   to guess. What the chart draws it as is "the internet was fully unreachable for this many
 *   cycles", and per-target aggregates cannot tell whether anchor A's three down cycles were the
 *   *same* three as anchor B's. So this takes the provable lower bound by inclusion–exclusion:
 *   `max(0, Σ downᵢ − (n−1)·count)`. Exact at both ends that matter — every anchor down for every
 *   cycle yields `count`, and one anchor answering throughout yields 0 — and never claims an
 *   internet outage the rows do not prove. Taking the minimum instead would report three
 *   internet-down cycles for two anchors that failed at different times.
 *
 * A bucket that no anchor reported is omitted rather than emitted empty, so `densifyBuckets`
 * downstream still renders it as unmeasured — which is what it was.
 */
export function foldInternetBuckets(byTarget: ReadonlyMap<TargetName, readonly ProbeBucket[]>): InternetBucket[] {
  const byBucket = new Map<number, ProbeBucket[]>()
  for (const target of WAN_TARGETS) {
    for (const row of byTarget.get(target) ?? []) {
      const entry = byBucket.get(row.bucket)
      if (entry === undefined) byBucket.set(row.bucket, [row])
      else entry.push(row)
    }
  }

  return [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, rows]) => {
      const extreme = (pick: (b: ProbeBucket) => number | null, reduce: (a: number, b: number) => number) => {
        const present = rows.map(pick).filter((v): v is number => v !== null)
        // An arrow, not a bare `Math.min` reference: `reduce` passes the index and the array as a
        // third and fourth argument, and `Math.min(a, b, index, array)` is NaN.
        return present.length === 0 ? null : present.reduce((a, b) => reduce(a, b))
      }

      // The most cycles any one anchor recorded. Every anchor is probed once per cycle, so the
      // three counts agree in the ordinary case; where they do not, the largest is the tightest
      // lower bound on how many cycles the bucket actually held.
      const count = rows.reduce((most, r) => Math.max(most, r.count), 0)
      const downSum = rows.reduce((sum, r) => sum + r.downCycles, 0)

      return {
        bucket,
        target: 'internet',
        anchors: rows.length,
        medianMs: median(rows.map((r) => r.medianMs)).value,
        p5Ms: median(rows.map((r) => r.p5Ms)).value,
        p95Ms: median(rows.map((r) => r.p95Ms)).value,
        minMs: extreme((r) => r.minMs, Math.min),
        maxMs: extreme((r) => r.maxMs, Math.max),
        // `?? 0` is unreachable — `lossPct` is non-null on every row and `rows` is non-empty by
        // construction — and is here only so the field's type stays `number` as `ProbeBucket`
        // declares it, rather than widening the fold's shape to admit a null the API cannot send.
        lossPct: median(rows.map((r) => r.lossPct)).value ?? 0,
        worstAnchorLossPct: rows.reduce((worst, r) => Math.max(worst, r.lossPct), 0),
        maxLossPct: rows.reduce((worst, r) => Math.max(worst, r.maxLossPct), 0),
        downCycles: Math.max(0, downSum - (rows.length - 1) * count),
        count,
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

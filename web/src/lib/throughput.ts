import { densifyBuckets } from './densify'
import { bucketAxisLabel } from './axis'
import type { ProbeBucketSeconds, ThroughputBucket } from './types'

/**
 * One column of the throughput chart: a rate, or the reason there isn't one.
 *
 * Three states, and collapsing any two of them is the bug this type exists to prevent:
 *
 * - **measured** — `downBytesPerS`/`upBytesPerS` are numbers, possibly 0. A quiet line.
 * - **unmeasured** — both null and `skipped` is 0. No cycle reported here at all; the chart
 *   hatches it, the same vocabulary the availability strip uses for absence.
 * - **partial** — a rate *and* `skipped > 0`. Something moved that the server could not place in
 *   time (a reboot reset the counters, the interface failed over, or the gap was too long), so the
 *   column is real but understates. Marked, never silently drawn as though complete.
 */
export interface ThroughputPoint {
  key: string
  label: string
  bucketStart: number
  downBytesPerS: number | null
  upBytesPerS: number | null
  downBytes: number
  upBytes: number
  /** Milliseconds of measured time behind the rate — the denominator that was actually used. */
  spanMs: number
  intervals: number
  skipped: number
}

/**
 * Fold a throughput response onto the window's own axis.
 *
 * **The rate divides by `spanMs`, never by the bucket width.** A bucket that measured two intervals
 * out of twenty covers 60 s of a 10-minute slot; dividing its bytes by the slot would report a
 * tenth of the true rate, and would do so most severely exactly when the collector was struggling —
 * turning a measurement problem into an apparent traffic collapse.
 *
 * A bucket the response did not mention, or one whose intervals were all refused, has no rate at
 * all. Null, not 0: an unmeasured hour and an idle hour look nothing alike on this line and must
 * not look alike on the chart.
 */
export function throughputPoints(
  buckets: readonly ThroughputBucket[],
  opts: { from: number; to: number; bucketSeconds: ProbeBucketSeconds },
): ThroughputPoint[] {
  return densifyBuckets([...buckets], opts).map((slot) => {
    const label = bucketAxisLabel(slot.bucketStart, opts.bucketSeconds)
    const row = slot.value
    if (row === null || row.spanMs <= 0) {
      return {
        key: slot.key,
        label,
        bucketStart: slot.bucketStart,
        downBytesPerS: null,
        upBytesPerS: null,
        downBytes: row?.inBytes ?? 0,
        upBytes: row?.outBytes ?? 0,
        spanMs: row?.spanMs ?? 0,
        intervals: row?.intervals ?? 0,
        skipped: row?.skipped ?? 0,
      }
    }

    const seconds = row.spanMs / 1000
    return {
      key: slot.key,
      label,
      bucketStart: slot.bucketStart,
      downBytesPerS: row.inBytes / seconds,
      upBytesPerS: row.outBytes / seconds,
      downBytes: row.inBytes,
      upBytes: row.outBytes,
      spanMs: row.spanMs,
      intervals: row.intervals,
      skipped: row.skipped,
    }
  })
}

/**
 * The window's totals, and how much of the window they are known to cover.
 *
 * `skippedBuckets` is not decoration. Every refused interval moved bytes that are not in these
 * totals, so a window with any refusals reports a **floor**, and a headline that does not say so
 * is a headline claiming to be a total. There is no way to recover the missing volume — that is
 * precisely why the intervals were refused — so the only honest options are to state the floor or
 * to state nothing, and stating the floor with its caveat is more useful.
 */
export interface ThroughputTotals {
  downBytes: number
  upBytes: number
  /** Buckets that produced a rate, and buckets holding at least one refused interval. */
  measuredBuckets: number
  skippedBuckets: number
  /** Buckets in the window that reported nothing at all. */
  unmeasuredBuckets: number
}

export function throughputTotals(points: readonly ThroughputPoint[]): ThroughputTotals {
  let downBytes = 0
  let upBytes = 0
  let measuredBuckets = 0
  let skippedBuckets = 0
  let unmeasuredBuckets = 0

  for (const point of points) {
    downBytes += point.downBytes
    upBytes += point.upBytes
    if (point.skipped > 0) skippedBuckets += 1
    if (point.downBytesPerS === null) unmeasuredBuckets += 1
    else measuredBuckets += 1
  }

  return { downBytes, upBytes, measuredBuckets, skippedBuckets, unmeasuredBuckets }
}

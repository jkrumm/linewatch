import type { ProbeBucketSeconds } from './types'

/**
 * One position on the time axis. `value` is `null` when the range route returned no row for it —
 * **the bucket was not measured**, which is a different fact from "the bucket measured zero" and
 * has to reach the chart as its own state rather than as an absent array entry.
 */
export interface Slot<T> {
  /** ISO-8601 of `bucketStart` — the categorical x-axis key. Identical to the key a chart would
   * have derived from the row itself (`new Date(row.bucket).toISOString()`), so a densified axis
   * and a row-derived one address the same point. */
  key: string
  bucketStart: number
  value: T | null
}

/**
 * A slot count no dashboard range produces (`lib/range.ts`'s `RANGE_BUCKET` tops out at 1441 slots,
 * for a 24 h window at the 1 h view's 60 s bucket). Exceeding it means the caller's window and
 * bucket size disagree, and silently building a million-element array would hang the tab.
 */
const MAX_SLOTS = 5_000

/**
 * Turn a sparse range response into the complete time domain it was queried over.
 *
 * A bucket with no rows is simply absent from `GET /api/probes`'s array. A chart that builds its
 * x-domain from the response therefore draws the two neighbours of a hole adjacent to each other,
 * and a smoothing curve joins them into a healthy-looking line across the gap — a data hole
 * rendered zero pixels wide. `defined` predicates cannot fix that: they only ever see points that
 * exist. The domain itself has to come from the window, which is what this does.
 *
 * **The slot starts must match the server's grouping key exactly.** `src/db/bucket-probes.ts`
 * groups on `(ts / bucketMs) * bucketMs` with SQLite integer division — epoch-aligned, NOT aligned
 * to `from`. So the first slot is `floor(from / bucketMs) * bucketMs`, which is at or *before*
 * `from`. Aligning to `from` instead would shift every point by up to one bucket and, far worse,
 * would leave every real bucket unmatched — every measurement rendered as a hole.
 *
 * Rows that land on no slot are a contract violation (the server filters `ts >= from AND ts <= to`,
 * so every bucket it returns is on the grid and inside the window) and throw rather than
 * disappearing. Dropping a measured bucket silently is the same class of bug this function exists
 * to fix.
 */
export function densifyBuckets<T extends { bucket: number }>(
  rows: T[],
  opts: { from: number; to: number; bucketSeconds: ProbeBucketSeconds },
): Slot<T>[] {
  // Same clamp and rounding as bucketProbes/bucketVantage, so the two never disagree on width.
  const bucketMs = Math.max(1, Math.round(opts.bucketSeconds * 1000))
  const first = Math.floor(opts.from / bucketMs) * bucketMs
  if (opts.to < first) return []

  const slotCount = Math.floor((opts.to - first) / bucketMs) + 1
  if (slotCount > MAX_SLOTS) {
    throw new RangeError(
      `densifyBuckets: ${slotCount} slots for a ${opts.to - opts.from} ms window at ${opts.bucketSeconds} s buckets — over the ${MAX_SLOTS} cap`,
    )
  }

  const byBucket = new Map<number, T>()
  for (const row of rows) byBucket.set(row.bucket, row)
  if (byBucket.size !== rows.length) {
    throw new RangeError('densifyBuckets: two rows share one bucket start — expected one row per bucket')
  }

  const slots: Slot<T>[] = []
  let matched = 0
  for (let bucketStart = first; bucketStart <= opts.to; bucketStart += bucketMs) {
    const value = byBucket.get(bucketStart) ?? null
    if (value !== null) matched += 1
    slots.push({ key: new Date(bucketStart).toISOString(), bucketStart, value })
  }

  if (matched !== byBucket.size) {
    throw new RangeError(
      `densifyBuckets: ${byBucket.size - matched} of ${byBucket.size} rows landed on no slot — the window [${opts.from}, ${opts.to}] and the ${opts.bucketSeconds} s bucket size do not describe this response`,
    )
  }

  return slots
}

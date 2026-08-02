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
 * **A row that lands on no slot has two possible causes, and only one of them is a bug.** This used
 * to throw on both, which took the whole dashboard down every five minutes:
 *
 *  - **Off the grid, inside the window** — the window and the bucket size genuinely do not describe
 *    this response. Nothing legitimate produces it: the server groups on `(ts / bucketMs) * bucketMs`
 *    and filters `ts >= from AND ts <= to`, so a row inside the window is on the grid by
 *    construction. Still throws. Dropping a measured bucket silently is the class of bug this
 *    function exists to fix, and this is that case.
 *  - **On the grid, outside the window** — the caller is holding an *overlapping* window's rows.
 *    That is not a contract violation, it is `keepAcrossTimeAdvance` (`lib/queries.ts`) doing its
 *    job: when the window steps forward, the previous answer is served as `placeholderData` under
 *    the new key so the page doesn't drop to skeletons every step. Those rows are span-identical
 *    but shifted, so the oldest of them fall before `first`. Skipped, because a bucket outside the
 *    requested window is simply not part of what this call was asked to draw.
 *
 * That second case was live and constant: on the 24 h range the window steps one 5-minute bucket at
 * a time, so a single step put one measured row before `first` and threw
 * `1 of 288 rows landed on no slot`. A placeholder that had been chaining for an hour (each step's
 * placeholder drawn from the last, while no fetch landed) threw `13 of 288`.
 *
 * The consequence to accept, rather than a thing to fix: for the moment a placeholder is on screen,
 * the newest slot has no row behind it and densifies to `null` — "not measured" — until the real
 * fetch lands, well under a second. It is one bucket at the leading edge, and it is the same trade
 * `keepAcrossTimeAdvance`'s own docblock already makes when it shows a 99.9%-overlapping window
 * under the current label.
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

  // Duplicate detection runs over the RAW rows, before the window filter below — two rows sharing a
  // bucket start is a malformed response whichever window it is read against, and checking it after
  // the filter would let a duplicate pair hide by sitting outside the window.
  const seen = new Set<number>()
  for (const row of rows) {
    if (seen.has(row.bucket)) {
      throw new RangeError('densifyBuckets: two rows share one bucket start — expected one row per bucket')
    }
    seen.add(row.bucket)
  }

  const byBucket = new Map<number, T>()
  let offGrid = 0
  for (const row of rows) {
    // Outside the requested window: an overlapping window's row, carried in by a placeholder. Not
    // this call's subject — see the docblock. Checked FIRST, so an out-of-window row is never also
    // judged against the grid: the two conditions have different causes and only one is a bug.
    if (row.bucket < first || row.bucket > opts.to) continue
    if ((row.bucket - first) % bucketMs !== 0) {
      offGrid += 1
      continue
    }
    byBucket.set(row.bucket, row)
  }

  if (offGrid > 0) {
    throw new RangeError(
      `densifyBuckets: ${offGrid} of ${rows.length} rows sit inside the window [${opts.from}, ${opts.to}] but off the ${opts.bucketSeconds} s grid — the bucket size does not describe this response`,
    )
  }

  const slots: Slot<T>[] = []
  for (let bucketStart = first; bucketStart <= opts.to; bucketStart += bucketMs) {
    slots.push({ key: new Date(bucketStart).toISOString(), bucketStart, value: byBucket.get(bucketStart) ?? null })
  }

  return slots
}

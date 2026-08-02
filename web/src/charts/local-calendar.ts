/**
 * The day × hour calendar both heatmaps are drawn on, in the reader's own zone.
 *
 * **Both grids used to be UTC, and the reasoning that put them there was about a real bug.** The
 * range routes group on `(ts / bucketMs) * bucketMs`, which is epoch-aligned — an hourly bucket is
 * a UTC hour — so deriving the column with `getHours()` while treating one bucket as one cell
 * meant that on the autumn fall-back two distinct buckets collapsed onto one local column, the
 * later silently overwriting the earlier.
 *
 * That is a real failure, and it is not an argument for a UTC axis. It is an argument for handling
 * the collision. A UTC axis on a page read from `UTC+02:00` tells the reader the line is worst at
 * 03:00 when it is worst at 05:00 — a wrong answer to the exact question the grid exists to answer
 * ("which hours of MY day are bad"), given every day of the year rather than one hour of it. So
 * the calendar is local, and the two hours a year where the local clock and the bucket grid do not
 * line up are handled honestly:
 *
 *  - **Fall-back**: two buckets share one cell. They are MERGED — never overwritten — by the
 *    caller's own merge rule, and both really did happen in that local hour, so one cell holding
 *    both is the true reading rather than a compromise.
 *  - **Spring-forward**: one local hour has no bucket and draws as not measured. Also true: that
 *    hour did not occur locally, and this dashboard's whole vocabulary for "nothing here" is the
 *    same hatch it would use for a collector outage. The one cell a year where those two causes
 *    are indistinguishable is a cost worth the other 8 759.
 */

/** `YYYY-MM-DD` of the instant's LOCAL date — the grid's row key. Deliberately not
 * `toISOString().slice(0, 10)`, which is the UTC date and is the thing this replaces. */
export function localDayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `'00'`…`'23'` of the instant's LOCAL hour — the grid's column key, matching `HOUR_LABELS`. */
export function localHourKey(ts: number): string {
  return String(new Date(ts).getHours()).padStart(2, '0')
}

/** A `localDayKey` back to a `Date` at local midnight. `new Date('2026-08-01')` parses a bare
 * date-only string as UTC per the spec, so feeding a row key straight to `Date` and formatting it
 * locally re-introduces exactly the off-by-one-day this module exists to remove. */
export function localDayStart(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

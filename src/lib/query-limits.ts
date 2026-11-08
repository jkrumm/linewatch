import { z } from 'zod'
import { config } from '../config.js'

/**
 * Bounds on what a read route will compute, so one URL cannot make the API
 * scan the table or return it whole.
 *
 * The dashboard's widest request is the `all` range: 365 d at a 86 400 s bucket
 * (365 buckets), and 30 d / 14 400 s elsewhere — all far inside these.
 */

/** Most buckets one range query may produce: `(to - from) / bucket`. */
export const MAX_BUCKETS = 10_000

/** Rows a list route returns when the caller names no `limit`. */
export const DEFAULT_LIST_LIMIT = 10_000

/** The ceiling on `limit`. */
export const MAX_LIST_LIMIT = 50_000

/** The `limit` query parameter shared by every list route. */
export const limitQuery = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_LIST_LIMIT)
  .default(DEFAULT_LIST_LIMIT)
  .describe(
    `Most rows returned, newest first (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}). A result of exactly this length may be truncated.`,
  )

/**
 * Why a bucketed range request is refused, or null when it is fine. The caller
 * answers 422 with the message.
 *
 * A bucket narrower than the probe cycle cannot hold more than one cycle, so it
 * buys no resolution and only multiplies rows.
 */
export function rangeProblem(params: { from: number; to: number; bucket: number }): string | null {
  const { from, to, bucket } = params
  if (from > to) return 'from must not be after to'
  if (bucket < config.probeCycleSeconds) {
    return `bucket must be at least the probe cycle (${config.probeCycleSeconds} s)`
  }
  if ((to - from) / (bucket * 1000) > MAX_BUCKETS) {
    return `range would produce more than ${MAX_BUCKETS} buckets; raise bucket or narrow the range`
  }
  return null
}

/** Why an optional `from`/`to` pair is refused, or null. */
export function windowProblem(params: { from?: number | undefined; to?: number | undefined }) {
  const { from, to } = params
  if (from !== undefined && to !== undefined && from > to) return 'from must not be after to'
  return null
}

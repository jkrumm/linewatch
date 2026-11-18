import { z } from 'zod'

/**
 * Bounds on what a read route will compute, so one URL cannot return a table whole.
 */

/** Rows a list route returns when the caller names no `limit`. */
const DEFAULT_LIST_LIMIT = 10_000

/** The ceiling on `limit`. */
const MAX_LIST_LIMIT = 50_000

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

/** Why an optional `from`/`to` pair is refused, or null. */
export function windowProblem(params: { from?: number | undefined; to?: number | undefined }) {
  const { from, to } = params
  if (from !== undefined && to !== undefined && from > to) return 'from must not be after to'
  return null
}

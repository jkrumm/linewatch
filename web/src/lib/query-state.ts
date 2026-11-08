/**
 * What a section needs to know about one query: still waiting, or failed with nothing to show.
 *
 * Loading is a third state, distinct from both "data" and "failed". A rejected query with no data
 * is `error`, never `pending` — `data === undefined` alone cannot tell them apart, and a section
 * that treats a failure as "pending" shows a skeleton forever. A failed BACKGROUND refetch that
 * still holds data is neither: the data stays on screen (the page-level notice and the live chip say
 * the refresh failed).
 */
export interface LoadState {
  pending: boolean
  error: unknown
}

export function loadState(
  results: readonly { data: unknown; isError: boolean; error: unknown }[],
): LoadState {
  const failed = results.find((r) => r.data === undefined && r.isError)
  if (failed !== undefined)
    return { pending: false, error: failed.error ?? new Error('Request failed') }
  return { pending: results.some((r) => r.data === undefined), error: undefined }
}

import { Callout } from 'basalt-ui/content'

/** The message of whatever a query rejected with, never a bare "[object Object]". */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return 'The request failed.'
}

/**
 * A section whose query failed and has nothing to show — the failed state, which is neither the
 * loading skeleton nor the empty state. Showing either would claim something about the line that a
 * failed request cannot support.
 */
export function QueryError({ what, error }: { what: string; error: unknown }) {
  return (
    <div role="alert">
      <Callout kind="bad" title={`Could not load ${what}`}>
        {errorMessage(error)}
      </Callout>
    </div>
  )
}

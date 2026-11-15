/**
 * The watchdog asking the API for a router poll, and the decision of when to.
 *
 * Separate from `watchdog.ts` because that file is a daemon — importing it
 * starts it — and these are the parts worth asserting.
 *
 * The reboot rung needs a line reading no older than 60 s (`no_fresh_poll`),
 * and its announce step fires only on a tick where every other precondition
 * already holds, then waits a further 60 s that is outside the freshness
 * window. The scheduled poll runs every 10 minutes and stores about three in
 * four, so the rung's latency was the poll schedule's, not the ladder's.
 *
 * **A poll can only make the evidence a rung waits for available sooner; it
 * never permits one.** Freshness is still read from `/api/router`'s stored line
 * reading on the next tick — never from this call's answer — so a poll that
 * answered 200 but lost its line read leaves `no_fresh_poll` standing, which is
 * the correct outcome.
 */

/** Minimum spacing between requests from one process. The route's own floor is 60 s. */
export const POLL_REQUEST_MIN_GAP_MS = 120_000

/** Login plus the reads. The tick deadline is 120 s; this sits well inside it. */
export const POLL_REQUEST_TIMEOUT_MS = 25_000

/**
 * Blockers that may stand beside `no_fresh_poll` and still mean "this rung is
 * otherwise due". Deliberately a closed list: a blocker added to the ladder
 * later stops requests until someone decides it belongs here, which is the safe
 * direction. `announce_pending` is absent on purpose — a poll taken during the
 * announce lead is older than the window again by the time the lead ends.
 */
const COMPATIBLE_BLOCKERS: ReadonlySet<string> = new Set(['no_fresh_poll', 'not_announced'])

export interface PollRequestInput {
  rung: string
  blockedBy: readonly string[]
  now: number
  /** Null when this process has not asked yet. */
  lastRequestedAt: number | null
  minGapMs: number
}

/**
 * True only when the reboot rung is due and the stale reading is the one thing
 * (besides the announce step it unblocks) standing in its way. While the rung
 * is off, disarmed, rate-limited or latched, `blockedBy` carries that and
 * nothing is requested — so deploying this changes nothing until the reboot
 * switch is turned on.
 */
export function wantsOnDemandPoll(input: PollRequestInput): boolean {
  if (input.rung !== 'reboot') return false
  if (!input.blockedBy.includes('no_fresh_poll')) return false
  if (!input.blockedBy.every((blocker) => COMPATIBLE_BLOCKERS.has(blocker))) return false
  if (input.lastRequestedAt !== null && input.now - input.lastRequestedAt < input.minGapMs)
    return false
  return true
}

export type PollRequestOutcome =
  | { kind: 'complete' | 'partial' }
  | { kind: 'rate_limited' | 'busy' }
  | { kind: 'failed'; status: number }
  | { kind: 'no_answer'; reason: string }

export interface PollRequestDeps {
  fetch: typeof fetch
  apiUrl: string
  token: string
  timeoutMs: number
}

/** Never throws: a watchdog tick must not die on a poll it only asked for. */
export async function requestRouterPoll(deps: PollRequestDeps): Promise<PollRequestOutcome> {
  try {
    const response = await deps.fetch(`${deps.apiUrl}/api/router/poll`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}` },
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
    if (response.status === 429) return { kind: 'rate_limited' }
    if (response.status === 409) return { kind: 'busy' }
    if (!response.ok) return { kind: 'failed', status: response.status }
    const body = (await response.json()) as { outcome?: unknown }
    return { kind: body.outcome === 'partial' ? 'partial' : 'complete' }
  } catch (error) {
    return { kind: 'no_answer', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The runner's pure decisions about *reporting*: how an executor's answer maps
 * onto the ledger, and what a notification says.
 *
 * Separate from `watchdog.ts` because that file is a daemon — it calls `main()`
 * at module scope, so importing it starts it. These are the parts of it worth
 * asserting, and two of them are safety-critical rather than cosmetic:
 * `ledgerOutcome` decides whether an attempt counts against the latch, and the
 * delay marker decides whether a notification can arrive claiming to be current
 * when it is not.
 */

/** What the two action routes can answer. Mirrors `ActionResult['outcome']`. */
export type ActionOutcome = 'executed' | 'failed' | 'not_executed' | 'refused' | 'unknown'

/** What the ledger records. Mirrors `LedgerAction['outcome']`. */
export type RecordedOutcome = 'executed' | 'failed' | 'not_executed' | 'unknown'

/**
 * Map the executor's answer onto the ledger's four outcomes.
 *
 * The distinction that matters is **did anything reach the line**, because
 * `recordOutcome` gives the latch increment back when nothing did. Two
 * pre-flight refusals must not self-disarm a watchdog that never sent a verb.
 *
 * - `refused` — the executor read the router and declined (no connected WAN
 *   instance, an unrecognised connType). Nothing was sent.
 * - `not_executed` — the capability switch is off, or the API answered 403.
 *   Nothing was sent.
 * - `failed` — a verb went out and the device rejected it.
 * - `unknown` — no answer. For a reboot that is the expected signature of
 *   success; for a reconnect it is genuinely ambiguous. Either way the line may
 *   have been touched, so it counts.
 *
 * A `null` answer means the request itself never completed, which is the same
 * ambiguity and gets the same conservative reading.
 */
export function ledgerOutcome(answer: { outcome: ActionOutcome } | null): RecordedOutcome {
  if (answer === null) return 'unknown'
  switch (answer.outcome) {
    case 'refused':
    case 'not_executed':
      return 'not_executed'
    case 'executed':
    case 'failed':
      return answer.outcome
    default:
      return 'unknown'
  }
}

/** Only an attempt that reached the line is an `intervention`; everything else is a `note`. */
export function eventKindFor(outcome: RecordedOutcome): 'intervention' | 'note' {
  return outcome === 'not_executed' ? 'note' : 'intervention'
}

/**
 * Anything older than this is stamped with its age. Five seconds is well past
 * any push that merely queued behind a slow request, and well short of the
 * shortest outage the record contains (90 s).
 */
const LIVE_WINDOW_MS = 5_000

/**
 * Stamp a delayed notification with its age.
 *
 * The notification spool drains across the WAN, which is by definition down
 * when there is something worth saying — so most of what it carries is
 * delivered late, and one that read as current would date an outage to whenever
 * the line came back rather than to when it started.
 */
export function markDelay(msg: string, ts: number, now: number): string {
  const delayedMs = now - ts
  if (delayedMs <= LIVE_WINDOW_MS) return msg
  return `[${Math.round(delayedMs / 1000)}s ago] ${msg}`
}

export interface NotificationSubject {
  state: string
  outageClass: string
  action: string
  note: string
  armed: boolean
  consecutiveActions: number
}

/**
 * Whether the watchdog's own monitor should read up or down.
 *
 * Down means **the watchdog has stopped being able to help**, not that the line
 * is bad — the line has its own monitor, and that one is silence-means-down.
 * Only two things qualify: it has latched itself out of service, or it has run
 * out of ladder and is asking for a human. A blocked rung is normal operation
 * and stays up; so does every shadow-mode evaluation, or two weeks of shadow
 * running would page continuously.
 */
export function notificationStatus(subject: Pick<NotificationSubject, 'state' | 'action'>): 'up' | 'down' {
  return subject.state === 'latched' || subject.action === 'escalate' ? 'down' : 'up'
}

/** Kuma truncates long messages, so the state and the class lead and the prose follows. */
export function notificationMessage(subject: NotificationSubject): string {
  const uncleared = subject.consecutiveActions > 0 ? ` · ${subject.consecutiveActions} action(s) uncleared` : ''
  return `${subject.state} · ${subject.outageClass} · ${subject.armed ? 'armed' : 'shadow'}${uncleared} · ${subject.note}`.slice(0, 240)
}

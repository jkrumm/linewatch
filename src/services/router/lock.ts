/**
 * One lock for everything that holds the router's single admin session.
 *
 * A poll's fresh login force-evicts whoever holds the slot, this process's own
 * action included: a poll starting between a reconnect's disconnect and connect
 * would null the session and leave the line half-bounced. So polls and both
 * executor methods run through here, strictly one at a time.
 *
 * A poll that finds the lock taken is skipped (the next cron tick is minutes
 * away); an action queues behind whatever is running.
 */

let tail: Promise<unknown> = Promise.resolve()
let pending = 0

/** True while a poll or an action holds, or is queued for, the lock. */
export function isRouterBusy(): boolean {
  return pending > 0
}

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  pending += 1
  const run = tail.then(fn)
  tail = run
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      pending -= 1
    })
  return run
}

import { Cron } from 'croner'
import { db } from '../../db/client.js'
import { desc } from 'drizzle-orm'
import { event, routerWanSample } from '../../db/schema.js'
import { RouterClient, RouterSessionLostError, RouterUnreachableError } from './client.js'
import { resolveCollectorHostIp } from './collector-address.js'
import { routerConfig } from './config.js'
import { RouterPoller } from './poll.js'
import { LiveExecutor, NullExecutor, type KnownWan, type RouterActionExecutor } from './actions.js'
import { isRouterBusy, runExclusive } from './lock.js'

/**
 * The router poller's schedule.
 *
 * Nothing here may take the API down. The router being unreachable, evicted,
 * slow, or reporting a field it no longer has is normal operation, so every
 * failure is logged and swallowed: the poller is a source of extra context for
 * the uptime record, never a dependency of serving it.
 */

const FIRST_POLL_DELAY_MS = 5_000

/**
 * Pause before the one retry of a scheduled poll that stored no line reading.
 * Long enough for whatever invalidated the first session (the router answers
 * 406 and closes the socket, or a login that "did not take") to have passed;
 * short against the 10-minute cadence it saves.
 */
const RETRY_DELAY_MS = 30_000

let lastPollAttemptAt: number | null = null
let poller: RouterPoller | null = null
let client: RouterClient | null = null
let executor: RouterActionExecutor = new NullExecutor()

/**
 * The one place the executor is built, so the wiring of the reconnect's
 * known-connection selector has a test that fails when it is dropped.
 */
export function buildExecutor(input: {
  client: RouterClient
  writeEnabled: boolean
}): RouterActionExecutor {
  return input.writeEnabled
    ? new LiveExecutor(input.client, undefined, lastStoredWan)
    : new NullExecutor()
}

/** The newest stored WAN connection, the reconnect's selector when no instance is connected. */
export function lastStoredWan(): KnownWan | null {
  const row = db
    .select({ name: routerWanSample.connName, stack: routerWanSample.stack })
    .from(routerWanSample)
    .orderBy(desc(routerWanSample.ts))
    .limit(1)
    .all()[0]
  return row ?? null
}

/**
 * The poller, for the on-demand poll route. Null when no router is configured —
 * the route answers 503 rather than pretending a poll happened.
 */
export function getRouterPoller(): RouterPoller | null {
  return poller
}

/**
 * The action executor. A `NullExecutor` unless both a password and
 * `LINEWATCH_ROUTER_WRITE=1` are present, so the default in every environment
 * — including every test and every fresh checkout — sends nothing.
 */
export function getRouterExecutor(): RouterActionExecutor {
  return executor
}

/**
 * What a poll attempt came to. `skipped` means another poll or an action holds
 * the router session; `login_failed` means no read ever happened.
 */
export type PollAttempt =
  | 'complete'
  | 'partial'
  | 'skipped'
  | 'login_failed'
  | 'failed'
  | 'unconfigured'

/**
 * Seconds since a poll last *started*, or null if none has in this process.
 * An attempt timestamp rather than the newest stored sample: a failed poll
 * writes no sample, so the sample would never rate-limit mid-outage — exactly
 * when someone hammers the route.
 */
export function secondsSincePollAttempt(now: number): number | null {
  return lastPollAttemptAt === null ? null : Math.floor((now - lastPollAttemptAt) / 1000)
}

/** Serialises an on-demand poll against the scheduled one and any action: they share a session. */
export function pollOnDemand(): Promise<PollAttempt> {
  return pollGuarded().then((run) => run.attempt)
}

/** One poll's outcome plus the fact the retry rule needs: did it store a line reading. */
export interface PollRun {
  attempt: PollAttempt
  lineStored: boolean
}

/**
 * The scheduled poll: one attempt, and **one** more fresh login when the first
 * stored no line reading.
 *
 * Measured 2026-11-15: about one scheduled poll in four stored nothing — the
 * login "did not take", or the first read answered 406 and then lost its socket
 * — which is 75% coverage against the 80% the watchdog's arming needs. A
 * standalone process logging in every 40 s read 12 of 12 clean, and nothing else
 * on the host logs into the router, so the cause is not reproducible from here;
 * the retry is the bounded answer to a cause that is not ours to remove.
 *
 * It is not the session repair `RouterClient` refuses: no session is held
 * across polls, the retry is a whole new poll with its own login, and it is
 * capped at two logins per cadence tick. `skipped` (the lock is held by an
 * action) and `unconfigured` are not failures to read, so they never retry. The
 * on-demand route does not use this: whoever asked decides whether to ask again.
 */
export async function pollWithRetry(deps: {
  poll: () => Promise<PollRun>
  sleep: (ms: number) => Promise<void>
  delayMs: number
}): Promise<PollRun> {
  const first = await deps.poll()
  const storedNothing =
    first.attempt === 'login_failed' ||
    first.attempt === 'failed' ||
    ((first.attempt === 'complete' || first.attempt === 'partial') && !first.lineStored)
  if (!storedNothing) return first
  console.warn(`[router] poll stored no line reading (${first.attempt}) — one retry`)
  await deps.sleep(deps.delayMs)
  return deps.poll()
}

function pollScheduled(): Promise<PollRun> {
  return pollWithRetry({
    poll: pollGuarded,
    sleep: (ms) => Bun.sleep(ms),
    delayMs: RETRY_DELAY_MS,
  })
}

/**
 * Swaps the process-wide router runtime. Tests only: the real one is built by
 * `startRouterPoller`, which also starts timers against a real device.
 */
export function setRouterRuntimeForTest(runtime: {
  poller: RouterPoller | null
  client: RouterClient | null
  executor: RouterActionExecutor
}): void {
  poller = runtime.poller
  client = runtime.client
  executor = runtime.executor
  lastPollAttemptAt = null
}

function recordLoginFailure(message: string): void {
  try {
    db.insert(event)
      .values({
        ts: Date.now(),
        kind: 'note',
        detail: JSON.stringify({
          source: 'router-poller',
          reason: 'login_failed',
          error: message,
        }),
      })
      .run()
  } catch (error) {
    console.error(
      `[router] could not record the failed login: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function pollGuarded(): Promise<PollRun> {
  if (poller === null || client === null) return { attempt: 'unconfigured', lineStored: false }
  if (isRouterBusy()) {
    console.warn('[router] skipped — a poll or an action is already in progress')
    return { attempt: 'skipped', lineStored: false }
  }
  const activePoller = poller
  const activeClient = client
  return runExclusive(async (): Promise<PollRun> => {
    lastPollAttemptAt = Date.now()
    try {
      const summary = await activePoller.poll()
      console.log(
        `[router] poll ${JSON.stringify({
          status: summary.lineStatus,
          syncKbps: [summary.downSyncKbps, summary.upSyncKbps],
          wan: {
            name: summary.wanIfName,
            rxKbps: summary.wanRxKbps,
            txKbps: summary.wanTxKbps,
          },
          lan: { rxKbps: summary.lanRxKbps, txKbps: summary.lanTxKbps },
          rows: {
            intf: summary.intfRows,
            ports: summary.portRows,
            hosts: summary.hostRows,
          },
          outcome: summary.outcome,
          reads: `${summary.readsOk}/8`,
          ...(summary.abandonedAt === null ? {} : { abandonedAt: summary.abandonedAt }),
          resync: summary.resync,
          ...(summary.sessionRestarts.length === 0
            ? {}
            : { sessionRestarts: summary.sessionRestarts }),
          disagreements: summary.disagreements,
          logins: activeClient.status().logins,
        })}`,
      )
      for (const warning of summary.warnings) console.warn(`[router] ${warning}`)
      return { attempt: summary.outcome, lineStored: summary.lineStored }
    } catch (error) {
      if (error instanceof RouterSessionLostError || error instanceof RouterUnreachableError) {
        // Reaching here means the *login* failed, so no read ever happened and
        // there is nothing to keep. A session lost partway through a poll does
        // not arrive here: `poll()` stops reading, stores what the earlier reads
        // bought, and reports `outcome: 'partial'`. A failed login is a
        // non-clean poll, so it is the one case that writes a note.
        console.warn(`[router] login failed, poll never started: ${error.message}`)
        recordLoginFailure(error.message)
        return { attempt: 'login_failed', lineStored: false }
      }
      console.error(
        `[router] poll failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return { attempt: 'failed', lineStored: false }
    }
  })
}

/**
 * Starts the router poll on the configured cadence (`LINEWATCH_ROUTER_CRON`,
 * every 10 minutes by default), or returns null when no router password is
 * configured — an unconfigured poller logs why and the rest of the service runs
 * exactly as before.
 */
export function startRouterPoller(): Cron | null {
  if (!routerConfig.enabled || routerConfig.password === null) {
    console.warn(`[router] poller disabled — ${routerConfig.disabledReason ?? 'no reason given'}`)
    return null
  }
  if (routerConfig.configWarning !== null) console.warn(`[router] ${routerConfig.configWarning}`)

  client = new RouterClient({
    baseUrl: routerConfig.baseUrl,
    user: routerConfig.user,
    password: routerConfig.password,
    requestTimeoutMs: routerConfig.requestTimeoutMs,
  })
  poller = new RouterPoller({
    db,
    client,
    collectorHostIp: () =>
      resolveCollectorHostIp({ db, override: routerConfig.collectorHostIpOverride }),
  })
  executor = buildExecutor({ client, writeEnabled: routerConfig.writeEnabled })
  console.log(
    routerConfig.writeEnabled
      ? '[router] WRITE CAPABILITY ENABLED (LINEWATCH_ROUTER_WRITE=1) — the action routes can reach the device'
      : '[router] write capability off — the action routes answer 403 and the executor sends nothing',
  )

  // One poll shortly after boot: it fills the tables right after a deploy and is
  // the fastest honest answer to "is the router reachable from in here".
  setTimeout(() => void pollScheduled(), FIRST_POLL_DELAY_MS)
  const cron = new Cron(routerConfig.pollCron, () => void pollScheduled())
  // Says out loud that the poller exists in *this* process. Its absence from the
  // container log is what a deployment where the password never reached the
  // image looks like, and that went unnoticed once already.
  console.log(
    `[router] poller started — ${routerConfig.pollCron} (every ${routerConfig.pollIntervalMs / 1000}s) against ${routerConfig.baseUrl}, readings stale after ${routerConfig.staleAfterMs / 1000}s`,
  )
  return cron
}

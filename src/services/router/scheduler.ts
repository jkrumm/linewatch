import { Cron } from 'croner'
import { db } from '../../db/client.js'
import {
  RouterBackingOffError,
  RouterClient,
  RouterSessionLostError,
  RouterUnreachableError,
} from './client.js'
import { routerConfig } from './config.js'
import { RouterPoller } from './poll.js'

/**
 * The router poller's schedule.
 *
 * Nothing here may take the API down. The router being unreachable, evicted,
 * slow, or reporting a field it no longer has is normal operation, so every
 * failure is logged and swallowed: the poller is a source of extra context for
 * the uptime record, never a dependency of serving it.
 */

const FIRST_POLL_DELAY_MS = 5_000

let running = false
let poller: RouterPoller | null = null
let client: RouterClient | null = null

async function pollGuarded(): Promise<void> {
  if (poller === null || client === null) return
  if (running) {
    console.warn('[router] skipped — a poll is already in progress')
    return
  }
  running = true
  try {
    const summary = await poller.poll()
    console.log(
      `[router] poll ${JSON.stringify({
        status: summary.lineStatus,
        syncKbps: [summary.downSyncKbps, summary.upSyncKbps],
        wan: { name: summary.wanIfName, rxKbps: summary.wanRxKbps, txKbps: summary.wanTxKbps },
        lan: { rxKbps: summary.lanRxKbps, txKbps: summary.lanTxKbps },
        rows: { intf: summary.intfRows, ports: summary.portRows, hosts: summary.hostRows },
        resync: summary.resync,
        disagreements: summary.disagreements,
        logins: client.status().logins,
      })}`,
    )
    for (const warning of summary.warnings) console.warn(`[router] ${warning}`)
  } catch (error) {
    if (error instanceof RouterBackingOffError) {
      console.log(`[router] ${error.message}`)
    } else if (error instanceof RouterSessionLostError || error instanceof RouterUnreachableError) {
      // Both are ordinary operating conditions for a consumer router, not
      // faults of this service: log and let the next poll try again.
      console.warn(`[router] poll abandoned: ${error.message}`)
    } else {
      console.error(`[router] poll failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } finally {
    running = false
  }
}

/**
 * Starts the five-minute router poll, or returns null when no router password is
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
    reloginBackoffMs: routerConfig.reloginBackoffMs,
    requestTimeoutMs: routerConfig.requestTimeoutMs,
  })
  poller = new RouterPoller({
    db,
    client,
    collectorHostIp: routerConfig.collectorHostIp,
  })

  // One poll shortly after boot: it fills the tables right after a deploy and is
  // the fastest honest answer to "is the router reachable from in here".
  setTimeout(() => void pollGuarded(), FIRST_POLL_DELAY_MS)
  const cron = new Cron(routerConfig.pollCron, () => void pollGuarded())
  // Says out loud that the poller exists in *this* process. Its absence from the
  // container log is what a deployment where the password never reached the
  // image looks like, and that went unnoticed once already.
  console.log(
    `[router] poller started — ${routerConfig.pollCron} (every ${routerConfig.pollIntervalMs / 1000}s) against ${routerConfig.baseUrl}, readings stale after ${routerConfig.staleAfterMs / 1000}s`,
  )
  return cron
}

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type TargetScope = 'gateway' | 'wan'

export interface Target {
  name: string
  addr: string
  scope: TargetScope
}

// docs/DESIGN.md "Targets" — gateway distinguishes "router down" from "WAN
// down"; three WAN anchors on three different networks so a single
// provider's outage or ICMP deprioritisation cannot register as a local
// outage (a WAN outage requires all three to fail in the same cycle).
const DEFAULT_TARGETS: Target[] = [
  { name: 'gateway', addr: '192.168.1.1', scope: 'gateway' },
  { name: 'cloudflare', addr: '1.1.1.1', scope: 'wan' },
  { name: 'google', addr: '8.8.8.8', scope: 'wan' },
  { name: 'quad9', addr: '9.9.9.9', scope: 'wan' },
]

function parseTargets(raw: string | undefined): Target[] {
  if (!raw) return DEFAULT_TARGETS
  // LINEWATCH_TARGETS overrides the default set: comma-separated
  // "name:addr:scope" entries, e.g. "gw:10.0.0.1:gateway,cf:1.1.1.1:wan".
  return raw.split(',').map((entry) => {
    const [name, addr, scope] = entry.trim().split(':')
    if (!name || !addr || (scope !== 'gateway' && scope !== 'wan')) {
      throw new Error(`invalid LINEWATCH_TARGETS entry "${entry}" (want "name:addr:gateway|wan")`)
    }
    return { name, addr, scope }
  })
}

const TOKEN_FILE_PATH = join(homedir(), '.config', 'linewatch', 'token')

function resolveToken(): string {
  const envToken = process.env['LINEWATCH_TOKEN']
  if (envToken) return envToken
  if (existsSync(TOKEN_FILE_PATH)) {
    const fileToken = readFileSync(TOKEN_FILE_PATH, 'utf-8').trim()
    if (fileToken) return fileToken
  }
  throw new Error(
    `No bearer token: set LINEWATCH_TOKEN or write one to ${TOKEN_FILE_PATH} (chmod 600). Run "make collector-setup" to generate it.`,
  )
}

/**
 * A cycle is "degraded" when its worst target lost at least this share of its
 * packets while still getting *something* back. The outage state machine only
 * opens a row when `received === 0`, so everything below that is invisible in
 * the outage table: the recovered data holds a cycle at 12:41 that lost up to
 * 80% across all four targets and produced zero outage rows. 20% is roughly
 * four of twenty pings — well past what a healthy line does at any hour, and
 * low enough to catch the shoulder of a flap before it becomes a full outage.
 */
const DEGRADED_LOSS_PCT = 20

/**
 * Minimum spacing between manual speed-test triggers, in seconds. `POST
 * /api/speedtests/run` is unauthenticated (tailnet-only, like every read): the
 * only abuse it enables is saturating the line, and this interval caps that.
 * Enforced against the last `speed_test` row's `ts`, not an in-memory clock, so
 * restarting the container cannot reset the budget.
 */
const SPEEDTEST_MIN_INTERVAL_S = 300

export interface Config {
  port: number
  dbPath: string
  /** Cadence of one full ping cycle across every target, in seconds. */
  probeCycleSeconds: number
  /** Pings sent per target per cycle. */
  pingCount: number
  /** Spacing between pings within one target's cycle, in seconds. */
  pingIntervalSeconds: number
  /** croner pattern for the speed-test schedule (jittered at runtime — see speedtest-runner.ts). */
  speedtestCron: string
  /** Rate limit for the manual speed-test trigger, in seconds. */
  speedtestMinIntervalS: number
  targets: Target[]
  /**
   * The gateway that *is* the home line. A cycle whose default route points
   * anywhere else did not measure this line, however healthy its probes look —
   * see `probe_cycle.on_home_line`.
   */
  homeGatewayAddr: string
  /** Per-cycle loss share (0–100) at or above which a cycle counts as degraded. */
  degradedLossPct: number
  token: string
}

/**
 * The address of the gateway-scoped target, which is by definition the home
 * router. Falls back to the first target only if the target list was overridden
 * with no gateway entry at all.
 */
function resolveHomeGateway(targets: Target[]): string {
  const explicit = process.env['LINEWATCH_HOME_GATEWAY']
  if (explicit) return explicit
  const gateway = targets.find((t) => t.scope === 'gateway')
  if (gateway) return gateway.addr
  throw new Error('No home gateway: LINEWATCH_TARGETS has no `gateway`-scoped entry — set LINEWATCH_HOME_GATEWAY')
}

const targets = parseTargets(process.env['LINEWATCH_TARGETS'])

export const config: Config = {
  port: Number(process.env['LINEWATCH_PORT'] ?? 7731),
  dbPath: process.env['LINEWATCH_DB'] ?? './data/linewatch.db',
  probeCycleSeconds: Number(process.env['LINEWATCH_PROBE_CYCLE_S'] ?? 30),
  pingCount: Number(process.env['LINEWATCH_PING_COUNT'] ?? 20),
  pingIntervalSeconds: Number(process.env['LINEWATCH_PING_INTERVAL_S'] ?? 0.2),
  speedtestCron: process.env['LINEWATCH_SPEEDTEST_CRON'] ?? '0 * * * *',
  speedtestMinIntervalS: Number(process.env['LINEWATCH_SPEEDTEST_MIN_INTERVAL_S'] ?? SPEEDTEST_MIN_INTERVAL_S),
  targets,
  homeGatewayAddr: resolveHomeGateway(targets),
  degradedLossPct: Number(process.env['LINEWATCH_DEGRADED_LOSS_PCT'] ?? DEGRADED_LOSS_PCT),
  token: resolveToken(),
}

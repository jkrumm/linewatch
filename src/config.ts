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

export interface Config {
  /**
   * The interface the API binds. Loopback by default: the Caddy door is the only
   * way in. The container needs
   * `0.0.0.0` to be reachable through its published port — docker-compose.yml sets
   * `LINEWATCH_HOST` for exactly that, and the native job must never inherit it.
   */
  host: string
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
  targets: Target[]
  /**
   * The gateway that *is* the home line. A cycle whose default route points
   * anywhere else did not measure this line, however healthy its probes look —
   * see `probe_cycle.on_home_line`.
   */
  homeGatewayAddr: string
  /** Per-cycle loss share (0–100) at or above which a cycle counts as degraded. */
  degradedLossPct: number
  /**
   * Base URL of the local OTLP/HTTP agent (docs/DESIGN.md "Export"). Unset or empty
   * = the export is off and nothing else changes. Loopback only by design: the agent
   * on this host owns durability and the key.
   */
  otlpEndpoint: string | null
  /** `deployment.environment.name` on every exported point: `prod` only when asked for, else `dev`. */
  deploymentEnv: 'prod' | 'dev'
  /**
   * How many days of high-volume samples SQLite keeps (`LINEWATCH_RETENTION_DAYS`).
   * Null = the daily retention job is off. Anything under 30 is refused at run time.
   */
  retentionDays: number | null
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
  throw new Error(
    'No home gateway: LINEWATCH_TARGETS has no `gateway`-scoped entry — set LINEWATCH_HOME_GATEWAY',
  )
}

const targets = parseTargets(process.env['LINEWATCH_TARGETS'])

function optionalEnv(name: string): string | null {
  const raw = process.env[name]?.trim()
  return raw ? raw : null
}

function optionalPositiveInt(name: string): number | null {
  const raw = optionalEnv(name)
  if (raw === null) return null
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export const config: Config = {
  host: process.env['LINEWATCH_HOST'] ?? '127.0.0.1',
  port: Number(process.env['LINEWATCH_PORT'] ?? 7731),
  dbPath: process.env['LINEWATCH_DB'] ?? './data/linewatch.db',
  probeCycleSeconds: Number(process.env['LINEWATCH_PROBE_CYCLE_S'] ?? 30),
  pingCount: Number(process.env['LINEWATCH_PING_COUNT'] ?? 20),
  pingIntervalSeconds: Number(process.env['LINEWATCH_PING_INTERVAL_S'] ?? 0.2),
  speedtestCron: process.env['LINEWATCH_SPEEDTEST_CRON'] ?? '0 * * * *',
  targets,
  homeGatewayAddr: resolveHomeGateway(targets),
  degradedLossPct: Number(process.env['LINEWATCH_DEGRADED_LOSS_PCT'] ?? DEGRADED_LOSS_PCT),
  otlpEndpoint: optionalEnv('LINEWATCH_OTLP_ENDPOINT'),
  deploymentEnv: process.env['LINEWATCH_DEPLOYMENT_ENV'] === 'prod' ? 'prod' : 'dev',
  retentionDays: optionalPositiveInt('LINEWATCH_RETENTION_DAYS'),
  token: resolveToken(),
}

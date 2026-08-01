import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Cron } from 'croner'

/**
 * Router-poller configuration.
 *
 * The password comes from `LINEWATCH_ROUTER_PASSWORD` or
 * `~/.config/linewatch/router-password` (chmod 600), deliberately *not* from the
 * machine's secrets cache: monitoring must not stop working because a cache is
 * unseeded, the same rationale as `~/.config/linewatch/token`.
 *
 * In the container only the environment variable can win — `homedir()` there is
 * `/app` (the image's `app` user is created with `--home-dir /app`) and nothing
 * is mounted at `/app/.config`. `make env` closes that gap the way the bearer
 * token already does: it reads the host file and writes the value into `.env`,
 * which compose loads via `env_file`. That is the whole deployment path; there
 * is no bind mount of a credential into the image.
 *
 * Resolution never throws. A missing password disables the poller and leaves the
 * API serving — a monitoring service that refuses to boot because an optional
 * subsystem is unconfigured is worse than one that logs it and carries on. The
 * same applies to a malformed cron pattern: it falls back to the default rather
 * than throwing out of `new Cron` and taking the process with it.
 */
export interface RouterConfig {
  enabled: boolean
  baseUrl: string
  user: string
  password: string | null
  /**
   * croner pattern. Every 10 minutes: one fresh login per poll (see the
   * `RouterClient` module doc), which is 72 logins/day, and measured sync rates
   * do not move fast enough for finer resolution to record anything more.
   */
  pollCron: string
  /** Milliseconds between two consecutive runs of `pollCron`, derived from the pattern itself. */
  pollIntervalMs: number
  /**
   * Age at which a stored router reading stops being served as current
   * (`GET /api/router`). Two poll intervals: one missed poll is ordinary jitter,
   * two means the reading is no longer describing now.
   */
  staleAfterMs: number
  requestTimeoutMs: number
  /** LAN address of the host running the native collector — the vantage to corroborate. */
  collectorHostIp: string
  /** Why the poller is off, when it is off. */
  disabledReason: string | null
  /**
   * Whether this process may write to the router at all
   * (`LINEWATCH_ROUTER_WRITE=1`). Off by default and independent of everything
   * above, including of whether a watchdog exists: with it unset the action
   * routes answer 403 and the executor is the one that sends nothing, so a bug
   * anywhere upstream still cannot reach the device.
   *
   * A second switch rather than a mode of `enabled` on purpose — the poller
   * being on is not consent to write, and the two are turned on by different
   * people at different times for different reasons.
   */
  writeEnabled: boolean
  /**
   * A setting that was accepted but not honoured — currently only an
   * unparseable cron pattern. Separate from `disabledReason` because the poller
   * is degraded, not off, and silently running on a different schedule than
   * asked for is the kind of quiet substitution this service exists not to make.
   */
  configWarning: string | null
}

const PASSWORD_FILE = join(homedir(), '.config', 'linewatch', 'router-password')
const DEFAULT_CRON = '*/10 * * * *'
const FALLBACK_INTERVAL_MS = 10 * 60 * 1000

/** How many poll intervals a reading may age before `GET /api/router` marks it stale. */
const STALE_AFTER_INTERVALS = 2

function resolvePassword(env: NodeJS.ProcessEnv): { password: string | null; reason: string | null } {
  const fromEnv = env['LINEWATCH_ROUTER_PASSWORD']
  if (fromEnv !== undefined && fromEnv.trim() !== '') return { password: fromEnv.trim(), reason: null }

  const path = env['LINEWATCH_ROUTER_PASSWORD_FILE'] ?? PASSWORD_FILE
  if (!existsSync(path)) {
    return {
      password: null,
      reason: `no router password: set LINEWATCH_ROUTER_PASSWORD (\`make env\` copies it from ~/.config/linewatch/router-password into .env) or write one to ${path} (chmod 600)`,
    }
  }
  const fromFile = readFileSync(path, 'utf-8').trim()
  if (fromFile === '') return { password: null, reason: `router password file ${path} is empty` }
  return { password: fromFile, reason: null }
}

/**
 * The pattern's own period, measured by asking croner for the next two runs
 * rather than by parsing it. An unparseable pattern would throw here *and* later
 * in the scheduler, so it is caught once and reported as a fallback.
 */
export function resolvePollCron(pattern: string): { cron: string; intervalMs: number; reason: string | null } {
  try {
    const runs = new Cron(pattern).nextRuns(2)
    const [first, second] = runs
    if (first === undefined || second === undefined) {
      return { cron: DEFAULT_CRON, intervalMs: FALLBACK_INTERVAL_MS, reason: `cron pattern '${pattern}' never runs twice — using ${DEFAULT_CRON}` }
    }
    return { cron: pattern, intervalMs: second.getTime() - first.getTime(), reason: null }
  } catch (error) {
    return {
      cron: DEFAULT_CRON,
      intervalMs: FALLBACK_INTERVAL_MS,
      reason: `invalid cron pattern '${pattern}' (${error instanceof Error ? error.message : String(error)}) — using ${DEFAULT_CRON}`,
    }
  }
}

/** Exported for tests: the same construction, over an injected environment. */
export function buildRouterConfig(env: NodeJS.ProcessEnv): RouterConfig {
  const { password, reason } = resolvePassword(env)
  // Explicit off switch, checked after the password so `make check` on a machine
  // that happens to have the file still reports the honest reason.
  const switchedOff = env['LINEWATCH_ROUTER_POLL'] === '0'
  const cron = resolvePollCron(env['LINEWATCH_ROUTER_CRON'] ?? DEFAULT_CRON)
  return {
    enabled: password !== null && !switchedOff,
    baseUrl: env['LINEWATCH_ROUTER_URL'] ?? 'http://192.168.1.1',
    // Not "admin": this firmware's login payload and MD5 hash both use "user".
    user: env['LINEWATCH_ROUTER_USER'] ?? 'user',
    password,
    pollCron: cron.cron,
    pollIntervalMs: cron.intervalMs,
    staleAfterMs: cron.intervalMs * STALE_AFTER_INTERVALS,
    requestTimeoutMs: Number(env['LINEWATCH_ROUTER_TIMEOUT_MS'] ?? 10_000),
    collectorHostIp: env['LINEWATCH_COLLECTOR_HOST_IP'] ?? '192.168.1.100',
    // Requires the password too: a write capability with no way to log in is
    // not a capability, and reporting it as one would misdescribe the system.
    writeEnabled: env['LINEWATCH_ROUTER_WRITE'] === '1' && password !== null,
    disabledReason: switchedOff ? 'LINEWATCH_ROUTER_POLL=0' : reason,
    configWarning: cron.reason,
  }
}

export const routerConfig: RouterConfig = buildRouterConfig(process.env)

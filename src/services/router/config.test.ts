import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRouterConfig, resolvePollCron } from './config.js'

/**
 * Every case pins `LINEWATCH_ROUTER_PASSWORD_FILE` at a path under a fresh temp
 * directory. Without it the default is the *real* `~/.config/linewatch/router-password`,
 * which exists on the machine this runs on — the suite would then pass or fail
 * depending on whose laptop it ran on, and would read a live credential to do it.
 */
function withPasswordFile(contents: string | null): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'linewatch-router-cfg-'))
  const path = join(dir, 'router-password')
  if (contents !== null) writeFileSync(path, contents, { mode: 0o600 })
  return {
    env: { LINEWATCH_ROUTER_PASSWORD_FILE: path },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('buildRouterConfig', () => {
  it('enables the poller from LINEWATCH_ROUTER_PASSWORD — the only path that reaches the container', () => {
    const { env, cleanup } = withPasswordFile(null)
    try {
      // Inside the image `homedir()` is /app and nothing is mounted at
      // /app/.config, so the file branch can never fire there. `make env` puts
      // the host file's contents into this variable via .env + compose env_file.
      const config = buildRouterConfig({ ...env, LINEWATCH_ROUTER_PASSWORD: 'secret-from-env' })
      expect(config.enabled).toBe(true)
      expect(config.password).toBe('secret-from-env')
      expect(config.disabledReason).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('trims the environment value — compose passes the .env line through verbatim', () => {
    const { env, cleanup } = withPasswordFile(null)
    try {
      expect(buildRouterConfig({ ...env, LINEWATCH_ROUTER_PASSWORD: '  padded  ' }).password).toBe('padded')
    } finally {
      cleanup()
    }
  })

  it('stays disabled with a reason naming both ways in, and never throws', () => {
    const { env, cleanup } = withPasswordFile(null)
    try {
      const config = buildRouterConfig(env)
      expect(config.enabled).toBe(false)
      expect(config.password).toBeNull()
      expect(config.disabledReason).toContain('LINEWATCH_ROUTER_PASSWORD')
      expect(config.disabledReason).toContain('make env')
    } finally {
      cleanup()
    }
  })

  it('reads the host file when it exists (the native `bun run` path)', () => {
    const { env, cleanup } = withPasswordFile('secret-from-file\n')
    try {
      const config = buildRouterConfig(env)
      expect(config.enabled).toBe(true)
      expect(config.password).toBe('secret-from-file')
    } finally {
      cleanup()
    }
  })

  it('treats an empty password file as unconfigured, not as an empty password', () => {
    const { env, cleanup } = withPasswordFile('   \n')
    try {
      const config = buildRouterConfig(env)
      expect(config.enabled).toBe(false)
      expect(config.password).toBeNull()
      expect(config.disabledReason).toContain('is empty')
    } finally {
      cleanup()
    }
  })

  it('honours the explicit off switch even with a password present', () => {
    const { env, cleanup } = withPasswordFile('secret-from-file')
    try {
      const config = buildRouterConfig({ ...env, LINEWATCH_ROUTER_POLL: '0' })
      expect(config.enabled).toBe(false)
      expect(config.disabledReason).toBe('LINEWATCH_ROUTER_POLL=0')
    } finally {
      cleanup()
    }
  })

  it('derives the poll interval and the staleness bound from the cron pattern', () => {
    const { env, cleanup } = withPasswordFile('secret-from-file')
    try {
      // The default cadence: one fresh login per poll, 72 logins a day.
      const byDefault = buildRouterConfig(env)
      expect(byDefault.pollCron).toBe('*/10 * * * *')
      expect(byDefault.pollIntervalMs).toBe(10 * 60 * 1000)
      expect(byDefault.staleAfterMs).toBe(20 * 60 * 1000)

      const hourly = buildRouterConfig({ ...env, LINEWATCH_ROUTER_CRON: '0 * * * *' })
      expect(hourly.pollIntervalMs).toBe(60 * 60 * 1000)
      expect(hourly.staleAfterMs).toBe(2 * 60 * 60 * 1000)
    } finally {
      cleanup()
    }
  })

  it('takes the cadence from the environment, so it is configuration and not a literal', () => {
    const { env, cleanup } = withPasswordFile('secret-from-file')
    try {
      // The scheduler builds its Cron from `pollCron` and nothing else, so this
      // is the whole cadence contract: change the pattern, change the schedule.
      const config = buildRouterConfig({ ...env, LINEWATCH_ROUTER_CRON: '*/2 * * * *' })
      expect(config.pollCron).toBe('*/2 * * * *')
      expect(config.pollIntervalMs).toBe(2 * 60 * 1000)
      expect(config.staleAfterMs).toBe(4 * 60 * 1000)
      expect(config.configWarning).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('falls back on an unparseable cron instead of throwing the process down at boot', () => {
    const { env, cleanup } = withPasswordFile('secret-from-file')
    try {
      const config = buildRouterConfig({ ...env, LINEWATCH_ROUTER_CRON: 'every five minutes please' })
      // Still polling — degraded, not off. `new Cron` in the scheduler would
      // otherwise throw out of startRouterPoller and take the API with it.
      expect(config.enabled).toBe(true)
      expect(config.pollCron).toBe('*/10 * * * *')
      expect(config.pollIntervalMs).toBe(10 * 60 * 1000)
      expect(config.disabledReason).toBeNull()
      expect(config.configWarning).toContain('invalid cron pattern')
    } finally {
      cleanup()
    }
  })
})

describe('resolvePollCron', () => {
  it('measures the period from the pattern rather than parsing it', () => {
    expect(resolvePollCron('*/5 * * * *')).toMatchObject({ cron: '*/5 * * * *', intervalMs: 300_000, reason: null })
    expect(resolvePollCron('*/30 * * * * *')).toMatchObject({ intervalMs: 30_000, reason: null })
  })
})

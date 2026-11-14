import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * End to end, as launchd runs it: the real `heartbeat.ts` in a subprocess
 * against two local servers. The API never answers (the hung call), the "Kuma"
 * records what reaches it. The claim under test is the acceptance criterion of
 * the bounding work: a hung check fails by itself and the push still goes out,
 * naming it, inside the run's deadline.
 */

const SCRIPT = join(import.meta.dir, 'heartbeat.ts')
const servers: Array<{ stop: (force?: boolean) => void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe('heartbeat.ts with a hung API', () => {
  test('fails the API check at its timeout and still pushes `down` naming it', async () => {
    const hung = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    const pushes: URL[] = []
    const kuma = Bun.serve({
      port: 0,
      fetch: (request) => {
        pushes.push(new URL(request.url))
        return new Response('ok')
      },
    })
    servers.push(hung, kuma)

    const started = Date.now()
    const proc = Bun.spawn(['bun', 'run', SCRIPT], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        LINEWATCH_API_URL: `http://127.0.0.1:${hung.port}`,
        LINEWATCH_KUMA_PUSH_URL: `http://127.0.0.1:${kuma.port}/api/push/token`,
        LINEWATCH_HEARTBEAT_API_TIMEOUT_MS: '400',
        LINEWATCH_HEARTBEAT_LOG_PATH: join(import.meta.dir, '.nonexistent-heartbeat.log'),
      },
    })
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.searchParams.get('status')).toBe('down')
    expect(pushes[0]?.searchParams.get('msg')).toContain('linewatch API unreachable')
  })
})

describe('heartbeat.ts when the push is not delivered', () => {
  async function exitCodeWithKuma(kumaFetch: () => Response | Promise<Response>): Promise<number> {
    const hung = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    const kuma = Bun.serve({ port: 0, fetch: kumaFetch })
    servers.push(hung, kuma)
    const proc = Bun.spawn(['bun', 'run', SCRIPT], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        LINEWATCH_API_URL: `http://127.0.0.1:${hung.port}`,
        LINEWATCH_KUMA_PUSH_URL: `http://127.0.0.1:${kuma.port}/api/push/token`,
        LINEWATCH_HEARTBEAT_API_TIMEOUT_MS: '200',
        LINEWATCH_HEARTBEAT_PUSH_TIMEOUT_MS: '400',
        LINEWATCH_HEARTBEAT_LOG_PATH: join(import.meta.dir, '.nonexistent-heartbeat.log'),
      },
    })
    return proc.exited
  }

  test('exits 75 (EX_TEMPFAIL) when Kuma answers 502', async () => {
    expect(await exitCodeWithKuma(() => new Response('bad gateway', { status: 502 }))).toBe(75)
  })

  test('exits 75 when the push times out', async () => {
    expect(await exitCodeWithKuma(() => new Promise<Response>(() => {}))).toBe(75)
  })
})

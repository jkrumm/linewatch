import { afterAll, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'

/**
 * Route-level tests for the manual speed-test trigger, over real HTTP.
 *
 * This route is the one write path with **no** bearer — deliberately: it is a
 * dashboard button with no token to present, and its only abuse (saturating the
 * line) is capped by a rate limit read from the newest `speed_test` row rather
 * than an in-process timer, so restarting the container cannot reset the
 * budget. Both halves of that sentence are asserted here, because the OpenAPI
 * description claimed a bearer on this route for a while after it was removed.
 *
 * A real run moves 250 MB–1 GB. `speedtest` is therefore made unresolvable for
 * the duration (PATH), which exercises the whole trigger → runner → row path —
 * `runOoklaSpeedtest` records a failed run as data — without touching the line.
 */

const TOKEN = 'test-token-not-the-real-one'

process.env['LINEWATCH_DB'] = ':memory:'
process.env['LINEWATCH_TOKEN'] = TOKEN
process.env['LINEWATCH_SPEEDTEST_MIN_INTERVAL_S'] = '300'

const { speedtestsRoutes } = await import('./speedtests.js')
const { db } = await import('../db/client.js')
const { speedTest } = await import('../db/schema.js')

const app = new Elysia().use(speedtestsRoutes)
const realPath = process.env['PATH']

function run(headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request('http://localhost/api/speedtests/run', { method: 'POST', headers }))
}

/** Waits for the background run to land its row, so the limiter has something to read. */
async function waitForRow(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (db.select().from(speedTest).all().length > 0) return
    await Bun.sleep(10)
  }
  throw new Error('the triggered run never recorded a speed_test row')
}

afterAll(() => {
  if (realPath !== undefined) process.env['PATH'] = realPath
})

describe('POST /api/speedtests/run', () => {
  test('the first call triggers a run, the second is rate-limited', async () => {
    // No `speedtest` binary reachable: the run fails fast and is recorded as a
    // failed run, which is exactly what the limiter reads.
    process.env['PATH'] = '/nonexistent'

    const first = await run()
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, triggered: true })

    await waitForRow()

    const second = await run()
    expect(second.status).toBe(429)
    const body = (await second.json()) as { error: string; secondsUntilNext: number; minIntervalS: number; lastRunTs: number }
    expect(body.error).toBe('rate_limited')
    expect(body.minIntervalS).toBe(300)
    // Not just "some number": it has to be a usable countdown.
    expect(body.secondsUntilNext).toBeGreaterThan(0)
    expect(body.secondsUntilNext).toBeLessThanOrEqual(300)
    expect(body.lastRunTs).toBe(db.select().from(speedTest).all()[0]?.ts ?? -1)
  })

  test('the limit is read from the database, so a restart cannot reset the budget', async () => {
    // A second app instance stands in for a restarted container: no in-process
    // state carries over, only the row.
    const restarted = new Elysia().use(speedtestsRoutes)
    const res = await restarted.handle(new Request('http://localhost/api/speedtests/run', { method: 'POST' }))

    expect(res.status).toBe(429)
  })

  test('no bearer is required — the OpenAPI contract must not claim one', async () => {
    // A 401 here would mean the dashboard button cannot work; the route is open
    // on the tailnet and rate-limited instead.
    const anonymous = await run()
    const withToken = await run({ authorization: `Bearer ${TOKEN}` })

    expect(anonymous.status).not.toBe(401)
    expect(withToken.status).toBe(anonymous.status)
  })

  test('the failed run is kept as data, not swallowed', async () => {
    const rows = db.select().from(speedTest).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ok).toBe(false)
    expect(rows[0]?.error).not.toBeNull()
  })
})

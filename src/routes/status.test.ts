import { beforeAll, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'

/**
 * The three fields on this route that exist for an automated reader rather than
 * for the dashboard, and the reason each is tested rather than trusted.
 *
 * `up` is a statement about the `outage` table, not about the line. No ingest
 * means no outage row can open, so a dead collector leaves `up: true` standing
 * forever — the failure `collector/heartbeat-verdict.ts` exists to catch.
 * `newestSampleTs` is what lets any reader check that before believing it.
 *
 * `speedtestRunning` and `vantage.linkWatchS` back two watchdog preconditions
 * that were unreachable while this route did not carry them: the ladder named
 * `speedtest_running` and `link_coverage_incomplete` as blockers, and no
 * evidence path could ever set either. A precondition that cannot fire is worse
 * than a missing one, because the failure-mode table counts it as mitigation.
 */

process.env['LINEWATCH_DB'] = ':memory:'

const { statusRoute } = await import('./status.js')
const { db } = await import('../db/client.js')
const { probeSample, probeCycle } = await import('../db/schema.js')

const app = new Elysia().use(statusRoute)

// `LINEWATCH_DB=:memory:` is one database per *process*, not per file, and bun
// runs the suite in one process — so whichever route test imported the client
// first owns it and its rows are visible here. Start from a known-empty state
// rather than assuming one.
beforeAll(() => {
  db.delete(probeSample).run()
  db.delete(probeCycle).run()
})

type Status = {
  up: boolean
  newestSampleTs: number | null
  speedtestRunning: boolean
  vantage: { linkWatchS: number | null; onHomeLine: boolean | null } | null
}

async function get(): Promise<Status> {
  const response = await app.handle(new Request('http://localhost/api/status'))
  expect(response.status).toBe(200)
  return (await response.json()) as Status
}

describe('GET /api/status', () => {
  test('an empty database reports no freshness rather than a fresh zero', async () => {
    const body = await get()
    // `up: true` with nothing measured is exactly the state that must not read
    // as a healthy line, so the freshness field has to be honestly absent.
    expect(body.up).toBe(true)
    expect(body.newestSampleTs).toBeNull()
    expect(body.vantage).toBeNull()
  })

  test('speedtestRunning is false while nothing is saturating the line', async () => {
    expect((await get()).speedtestRunning).toBe(false)
  })

  test('newestSampleTs is the newest sample, not the newest of any one target', async () => {
    const base = Date.now() - 60_000
    db.insert(probeSample)
      .values([
        { ts: base, target: 'gateway', addr: '192.168.1.1', sent: 20, received: 20, lossPct: 0, medMs: 1, jitterMs: 0.1 },
        { ts: base + 30_000, target: 'cloudflare', addr: '1.1.1.1', sent: 20, received: 20, lossPct: 0, medMs: 5, jitterMs: 0.2 },
      ])
      .run()

    expect((await get()).newestSampleTs).toBe(base + 30_000)
  })

  test('link coverage is carried through, and null stays null', async () => {
    const ts = Date.now()
    db.insert(probeCycle).values({ ts, pathIf: 'en0', pathClass: 'ethernet', onHomeLine: 1, linkWatchS: null }).run()
    // Null means nothing watched the link. Coalescing it to 0 would read as
    // "watched, saw nothing", which is the opposite claim.
    expect((await get()).vantage?.linkWatchS).toBeNull()

    db.insert(probeCycle).values({ ts: ts + 30_000, pathIf: 'en0', pathClass: 'ethernet', onHomeLine: 1, linkWatchS: 29 }).run()
    expect((await get()).vantage?.linkWatchS).toBe(29)
  })
})

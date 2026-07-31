import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'

/**
 * Route-level tests for the range summary attached to `GET /api/outages` — the
 * honesty layer that a bare outage list cannot supply on its own.
 *
 * These run over real HTTP because the two things being asserted are both
 * things a unit test cannot see: the response passes Elysia's own schema
 * validation (a `coveragePct` the schema rejects is a 422, not a summary), and
 * the route hands `rangeSummary` the WAN target *scope* rather than letting it
 * guess from names.
 */

process.env['LINEWATCH_DB'] = ':memory:'
process.env['LINEWATCH_TOKEN'] = 'test-token-not-the-real-one'

const { outagesRoutes } = await import('./outages.js')
const { db } = await import('../db/client.js')
const { outage, probeSample } = await import('../db/schema.js')

const app = new Elysia().use(outagesRoutes)

const CYCLE_MS = 30_000
// Far from the timestamps the other route tests use: `bun test` may share one
// process, and therefore one in-memory database, across files.
let nextTs = 1_600_000_000_000

function freshTs(): number {
  nextTs += 24 * 60 * 60 * 1000
  return nextTs
}

const ADDRS: Record<string, string> = {
  gateway: '192.168.1.1',
  cloudflare: '1.1.1.1',
  google: '8.8.8.8',
  quad9: '9.9.9.9',
}

/** One cycle: every configured target, with per-target loss. */
function seedCycle(ts: number, lossByTarget: Record<string, number> = {}): void {
  db.insert(probeSample)
    .values(
      Object.entries(ADDRS).map(([target, addr]) => {
        const lossPct = lossByTarget[target] ?? 0
        const received = Math.round(20 * (1 - lossPct / 100))
        return {
          ts,
          target,
          addr,
          sent: 20,
          received,
          lossPct,
          minMs: received > 0 ? 4 : null,
          medMs: received > 0 ? 5 : null,
          maxMs: received > 0 ? 6 : null,
          avgMs: received > 0 ? 5 : null,
          jitterMs: null,
          samples: null,
        }
      }),
    )
    .run()
}

/** One materialised outage row. `endedAt` null is an ongoing outage. */
function seedOutage(startedAt: number, endedAt: number | null): number {
  const row = db
    .insert(outage)
    .values({
      scope: 'wan',
      startedAt,
      endedAt,
      durationS: endedAt === null ? null : Math.round((endedAt - startedAt) / 1000),
      cycles: 1,
      evidence: JSON.stringify(['cloudflare', 'google', 'quad9']),
    })
    .returning({ id: outage.id })
    .get()
  return row.id
}

async function outageIds(from: number, to: number): Promise<number[]> {
  const res = await app.handle(new Request(`http://localhost/api/outages?from=${from}&to=${to}`))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { outages: { id: number }[] }
  return body.outages.map((row) => row.id)
}

interface Summary {
  recordedCycles: number
  expectedCycles: number
  coveragePct: number | null
  degradedCycles: number
}

async function summary(from: number, to: number): Promise<Summary> {
  const res = await app.handle(new Request(`http://localhost/api/outages?from=${from}&to=${to}`))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { summary: Summary | null }
  if (body.summary === null) throw new Error('expected a summary for an explicit range')
  return body.summary
}

describe('GET /api/outages — degraded cycles are a WAN quorum, not the worst target', () => {
  test('every anchor degraded with a clean gateway counts', async () => {
    const ts = freshTs()
    seedCycle(ts, { cloudflare: 60, google: 60, quad9: 60 })

    expect((await summary(ts - CYCLE_MS, ts + CYCLE_MS)).degradedCycles).toBe(1)
  })

  test('one anchor deprioritising ICMP does not', async () => {
    const ts = freshTs()
    seedCycle(ts, { quad9: 100 })

    expect((await summary(ts - CYCLE_MS, ts + CYCLE_MS)).degradedCycles).toBe(0)
  })

  test('a gateway-only loss is local and does not count as a home-line degradation', async () => {
    const ts = freshTs()
    seedCycle(ts, { gateway: 100 })

    expect((await summary(ts - CYCLE_MS, ts + CYCLE_MS)).degradedCycles).toBe(0)
  })

  test('an all-four degradation counts exactly once', async () => {
    const ts = freshTs()
    seedCycle(ts, { gateway: 80, cloudflare: 80, google: 80, quad9: 80 })
    seedCycle(ts + CYCLE_MS, { cloudflare: 80 })

    expect((await summary(ts - CYCLE_MS, ts + 2 * CYCLE_MS)).degradedCycles).toBe(1)
  })
})

describe('GET /api/outages — coverage of a range too short to hold a cycle', () => {
  test('a fully measured 2 ms window reports unknown coverage, not 0%', async () => {
    const ts = freshTs()
    seedCycle(ts)

    // The reproduction from the report: recordedCycles 1, expectedCycles 0,
    // coveragePct 0 — "none of this range was measured" about a range that was
    // measured completely. It has to serialize as null, and the response schema
    // has to accept that (a rejected value is a 422, not a fixed summary).
    const body = await summary(ts - 1, ts + 1)
    expect(body.recordedCycles).toBe(1)
    expect(body.expectedCycles).toBe(0)
    expect(body.coveragePct).toBeNull()
  })

  test('a normal range still reports a number', async () => {
    const ts = freshTs()
    seedCycle(ts)
    seedCycle(ts + CYCLE_MS)

    const body = await summary(ts, ts + 10 * CYCLE_MS)
    expect(body.expectedCycles).toBe(10)
    expect(body.coveragePct).toBe(20)
  })
})

describe('GET /api/outages — the range filter is an overlap, not a containment', () => {
  test('an outage that started before the window and ran into it is in the window', async () => {
    // The exact row the old `startedAt >= from` predicate dropped whole: 30 min
    // of it predates the range and three hours of it are inside, and it went
    // missing from both the table and the downtime sum.
    const from = freshTs()
    const to = from + 24 * 60 * 60 * 1000
    const id = seedOutage(from - 30 * 60 * 1000, from + 3 * 60 * 60 * 1000)

    expect(await outageIds(from, to)).toContain(id)
  })

  test('an outage that started inside the window and ended after it is too', async () => {
    const from = freshTs()
    const to = from + 24 * 60 * 60 * 1000
    const id = seedOutage(to - 10 * 60 * 1000, to + 2 * 60 * 60 * 1000)

    expect(await outageIds(from, to)).toContain(id)
  })

  test('an outage still ongoing from before the window is the most relevant row of all', async () => {
    const from = freshTs()
    const to = from + 24 * 60 * 60 * 1000
    const id = seedOutage(from - 60 * 60 * 1000, null)

    expect(await outageIds(from, to)).toContain(id)
  })

  test('an outage that ended before the window is not in it', async () => {
    const from = freshTs()
    const to = from + 24 * 60 * 60 * 1000
    const id = seedOutage(from - 2 * 60 * 60 * 1000, from - 60 * 60 * 1000)

    expect(await outageIds(from, to)).not.toContain(id)
  })

  test('an outage that started after the window is not in it', async () => {
    const from = freshTs()
    const to = from + 24 * 60 * 60 * 1000
    const id = seedOutage(to + 60 * 60 * 1000, to + 2 * 60 * 60 * 1000)

    expect(await outageIds(from, to)).not.toContain(id)
  })
})

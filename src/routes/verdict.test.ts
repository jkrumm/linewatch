import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'

/**
 * Route-level tests for `GET /api/verdicts`. The rules and their SQL are
 * covered in `src/lib/verdict*.test.ts`; what only real HTTP can show is that
 * the response survives Elysia's own schema validation — a verdict shape the
 * schema rejects is a 422, not a dashboard — and that a window is mandatory.
 */

process.env['LINEWATCH_DB'] = ':memory:'
process.env['LINEWATCH_TOKEN'] = 'test-token-not-the-real-one'

const { verdictRoutes } = await import('./verdict.js')
const { db } = await import('../db/client.js')
const { probeSample } = await import('../db/schema.js')

const app = new Elysia().use(verdictRoutes)

// Far from the timestamps the other route tests use: `bun test` may share one
// process, and therefore one in-memory database, across files.
const TS = 1_900_000_000_000

interface Body {
  verdicts: { id: string; severity: string; conclusion: string; evidence: { label: string; value: string }[]; uncertainty: string | null }[]
  window: { from: number; to: number }
}

describe('GET /api/verdicts', () => {
  test('serves verdicts that pass the response schema, each citing its numbers', async () => {
    db.insert(probeSample)
      .values({ ts: TS, target: 'cloudflare', addr: '1.1.1.1', sent: 20, received: 20, lossPct: 0, minMs: 4, medMs: 4, maxMs: 5, avgMs: 4, jitterMs: null, samples: null })
      .run()

    const from = TS - 60 * 60 * 1000
    const res = await app.handle(new Request(`http://localhost/api/verdicts?from=${from}&to=${TS}`))
    expect(res.status).toBe(200)

    const body = (await res.json()) as Body
    expect(body.window).toEqual({ from, to: TS })
    // One cycle in an hour-long window is a coverage verdict, and a collector
    // that stopped a long time ago is a silence verdict.
    expect(body.verdicts.map((v) => v.id)).toContain('probe_coverage_low')
    for (const verdict of body.verdicts) expect(verdict.evidence.length).toBeGreaterThan(0)
  })

  test('refuses a request with no window — a coverage figure needs one', async () => {
    const res = await app.handle(new Request(`http://localhost/api/verdicts?from=${TS - 1000}`))
    expect(res.status).toBe(422)
  })
})

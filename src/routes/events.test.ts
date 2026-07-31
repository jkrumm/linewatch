import { beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'

/**
 * Route-level tests for the timeline overlay, over real HTTP.
 *
 * The two things pinned here are the two an empty `events` array cannot say on
 * its own: which observation produced a row (a 1 s sampler reading and a 30 s
 * snapshot diff are not the same claim) and whether anything was watching at
 * all. `linkSamplingSince` is the second one, and it is the difference between
 * "no transition happened" and "nobody looked".
 */

// Set before the route module is pulled in: src/config.ts and src/db/client.ts
// read the environment at import time, and the production database lives in a
// Docker volume the host cannot open at all (docs/storage.md).
process.env['LINEWATCH_DB'] = ':memory:'
process.env['LINEWATCH_TOKEN'] ??= 'test-token-not-the-real-one'

const { eventsRoutes } = await import('./events.js')
const { db } = await import('../db/client.js')
const { event, probeCycle } = await import('../db/schema.js')

const app = new Elysia().use(eventsRoutes)

const BASE = 1_700_000_000_000

interface EventRow {
  id: number
  ts: number
  kind: string
  source: string | null
  detail: unknown
}

async function get(query: string): Promise<{ events: EventRow[]; linkSamplingSince: number | null }> {
  const res = await app.handle(new Request(`http://localhost/api/events?${query}`))
  expect(res.status).toBe(200)
  return (await res.json()) as { events: EventRow[]; linkSamplingSince: number | null }
}

beforeEach(() => {
  db.delete(event).run()
  db.delete(probeCycle).run()
})

describe('GET /api/events', () => {
  test('lifts detail.source out of each writer, and leaves an unsourced row unlabelled', async () => {
    db.insert(event)
      .values([
        {
          ts: BASE,
          kind: 'link_change',
          detail: JSON.stringify({ source: 'vantage-diff', changed: { linkMbit: { before: 1000, after: 100 } } }),
        },
        { ts: BASE + 1000, kind: 'link_change', detail: JSON.stringify({ source: 'link-sampler', state: 'down', iface: 'en0' }) },
        { ts: BASE + 2000, kind: 'link_change', detail: JSON.stringify({ source: 'router-poller', reason: 'line_resync' }) },
        // A row written before `vantage-diff` was stamped. It is left null rather
        // than back-filled with the source it most likely had.
        { ts: BASE + 3000, kind: 'link_change', detail: JSON.stringify({ changed: {} }) },
      ])
      .run()

    const { events } = await get(`from=${BASE}&to=${BASE + 10_000}`)
    expect(events.map((row) => row.source)).toEqual([null, 'router-poller', 'link-sampler', 'vantage-diff'])
  })

  test('linkSamplingSince is null when cycles exist but none reported link_watch_s', async () => {
    db.insert(probeCycle)
      .values([
        { ts: BASE, pathIf: 'en0', linkWatchS: null },
        { ts: BASE + 30_000, pathIf: 'en0', linkWatchS: null },
      ])
      .run()

    const { events, linkSamplingSince } = await get(`from=${BASE}&to=${BASE + 60_000}`)
    // The pairing that matters: zero events AND nothing watching. A reader that
    // took the empty array for stability would be reading silence as evidence.
    expect(events).toEqual([])
    expect(linkSamplingSince).toBeNull()
  })

  test('linkSamplingSince is the earliest watched cycle, not the earliest cycle', async () => {
    db.insert(probeCycle)
      .values([
        { ts: BASE, linkWatchS: null },
        { ts: BASE + 30_000, linkWatchS: 0 },
        { ts: BASE + 60_000, linkWatchS: 30 },
      ])
      .run()

    const { linkSamplingSince } = await get(`from=${BASE}&to=${BASE + 90_000}`)
    // Skips the `0` cycle. The sentence this value feeds is "Link sampling has COVERED this window
    // since <ts>", and a cycle that watched zero seconds covered nothing — `drain()` reports 0 when
    // every ifconfig read in the cycle failed, which is what a yanked adapter looks like. Reporting
    // it as the start of coverage would claim observation from the one cycle that observed least.
    expect(linkSamplingSince).toBe(BASE + 60_000)
  })

  test('a window the sampler watched for zero seconds reports no coverage at all', async () => {
    db.insert(probeCycle)
      .values([
        { ts: BASE, linkWatchS: 0 },
        { ts: BASE + 30_000, linkWatchS: 0 },
      ])
      .run()

    const { events, linkSamplingSince } = await get(`from=${BASE}&to=${BASE + 60_000}`)
    // The failure this guards: a sampler present but blind for the whole window. Reported as
    // coverage, the timeline prints "no transitions since <ts>" off zero seconds of observation —
    // silence dressed as a measurement, which is the one thing this codebase refuses to do.
    expect(events).toEqual([])
    expect(linkSamplingSince).toBeNull()
  })

  test('linkSamplingSince ignores watched cycles outside the requested window', async () => {
    db.insert(probeCycle)
      .values([
        { ts: BASE, linkWatchS: 30 },
        { ts: BASE + 600_000, linkWatchS: 30 },
      ])
      .run()

    const { linkSamplingSince } = await get(`from=${BASE + 300_000}&to=${BASE + 900_000}`)
    expect(linkSamplingSince).toBe(BASE + 600_000)
  })
})

import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { parsePingOutput } from '../../collector/ping-parser.js'
import { deriveOnHomeLine, type Vantage } from '../../collector/vantage.js'

/**
 * Route-level tests: the ingest contract as the collector actually meets it,
 * over real HTTP through the real Elysia app.
 *
 * The gap these close is not hypothetical. The previous round shipped a
 * collector that sends `on_home_line` as `0 | 1` into a `z.boolean()` — every
 * cycle 422'd, every batch spooled, and not one row was ingested. Both sides
 * had passing unit tests; nothing tested the seam. So the vantage here is typed
 * as the collector's own `Vantage` and its verdict comes from the collector's
 * own `deriveOnHomeLine`, and the samples are built from real `ping` output
 * through the collector's own parser. The two can no longer drift silently:
 * a change to either shape breaks this file at typecheck or at the 200.
 */

const TOKEN = 'test-token-not-the-real-one'
const HOME_GW = '192.168.1.1'

// Set before the route module is pulled in, because src/config.ts and
// src/db/client.ts read the environment at import time. `:memory:` keeps the
// test off any real database — the production one lives in a Docker volume the
// host cannot open at all (docs/storage.md).
process.env['LINEWATCH_DB'] = ':memory:'
process.env['LINEWATCH_TOKEN'] = TOKEN
process.env['LINEWATCH_HOME_GATEWAY'] = HOME_GW

const { probesRoutes } = await import('./probes.js')
const { db } = await import('../db/client.js')
const { event, probeCycle, probeSample } = await import('../db/schema.js')

const app = new Elysia().use(probesRoutes)

// Verbatim macOS `ping` output, same provenance as collector/ping-parser.test.ts.
const CLEAN = `PING 1.1.1.1 (1.1.1.1): 56 data bytes
64 bytes from 1.1.1.1: icmp_seq=0 ttl=58 time=10.998 ms
64 bytes from 1.1.1.1: icmp_seq=1 ttl=58 time=4.129 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=58 time=2.804 ms

--- 1.1.1.1 ping statistics ---
3 packets transmitted, 3 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 2.804/5.977/10.998/3.591 ms
`

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const lower = sorted[mid - 1] ?? 0
  const upper = sorted[mid] ?? 0
  return sorted.length % 2 === 0 ? (lower + upper) / 2 : upper
}

/**
 * One sample in exactly the shape collector/probe.ts's `pingTarget` returns —
 * built from the collector's parser rather than a hand-written literal, so a
 * field the parser starts reporting shows up here too. (`TargetSample` itself
 * is not exported from probe.ts, which is why this mirrors it instead of
 * importing it; exporting it would make the anchor total.)
 */
function sample(target: string, addr: string, output = CLEAN) {
  const parsed = parsePingOutput(output)
  const rtts = parsed.rtts
  const hasData = rtts.length > 0
  return {
    target,
    addr,
    sent: parsed.sent,
    received: parsed.received,
    lossPct: parsed.lossPct,
    minMs: hasData ? Math.min(...rtts) : null,
    medMs: hasData ? median(rtts) : null,
    maxMs: hasData ? Math.max(...rtts) : null,
    avgMs: hasData ? rtts.reduce((sum, v) => sum + v, 0) / rtts.length : null,
    jitterMs: hasData ? 3.591 : null,
    samples: hasData ? rtts : null,
    duplicates: parsed.duplicates,
    outOfWaitTime: parsed.outOfWaitTime,
  }
}

/** Every target of one cycle, as the collector sends them. */
function samples() {
  return [
    sample('gateway', HOME_GW),
    sample('cloudflare', '1.1.1.1'),
    sample('google', '8.8.8.8'),
    sample('quad9', '9.9.9.9'),
  ]
}

/** The collector's own vantage for a healthy Ethernet cycle. */
const ETHERNET: Vantage = {
  pathIf: 'en0',
  pathClass: 'ethernet',
  linkMedia: '1000baseT',
  linkMbit: 1000,
  linkDuplex: 'full',
  gatewayAddr: HOME_GW,
  ifIerrs: 0,
  ifOerrs: 0,
  ifColl: 0,
  onHomeLine: deriveOnHomeLine({ pathClass: 'ethernet', gatewayAddr: HOME_GW, expectedGateway: HOME_GW }),
}

interface Batch {
  ts: number
  samples: ReturnType<typeof samples>
  cycle?: Vantage
}

function post(body: unknown, token: string | null = TOKEN): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/probes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
  )
}

function batch(ts: number, cycle?: Vantage): Batch {
  return { ts, samples: samples(), ...(cycle === undefined ? {} : { cycle }) }
}

function cycleRow(ts: number) {
  return db
    .select()
    .from(probeCycle)
    .all()
    .find((row) => row.ts === ts)
}

function samplesAt(ts: number) {
  return db
    .select()
    .from(probeSample)
    .all()
    .filter((row) => row.ts === ts)
}

// The app holds one database for the whole file, so every test takes its own
// timestamp. The step is far wider than a probe cycle on purpose: a test that
// posts a follow-up cycle at `ts + 30_000` must not land on the next test's.
let nextTs = 1_700_000_000_000

function freshTs(): number {
  nextTs += 600_000
  return nextTs
}

describe('POST /api/probes — the collector wire format', () => {
  test('accepts a batch in exactly the shape collector/probe.ts emits', async () => {
    const ts = freshTs()
    const res = await post(batch(ts, ETHERNET))

    // 422 here is the regression that already happened once: a Zod schema that
    // disagrees with the collector rejects the batch, the collector spools it,
    // and the record silently stops growing.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, inserted: 4, skipped: false, linkChange: false })
    expect(samplesAt(ts)).toHaveLength(4)
  })

  test('the collector sends on_home_line as 0/1, and the row lands as 1', async () => {
    const ts = freshTs()
    // Not a literal `1`: whatever the collector's own derivation returns.
    expect(ETHERNET.onHomeLine).toBe(1)

    await post(batch(ts, ETHERNET))
    expect(cycleRow(ts)?.onHomeLine).toBe(1)
  })

  test('a batch with no cycle at all still ingests — an older collector must not 422', async () => {
    const ts = freshTs()
    const res = await post(batch(ts))

    expect(res.status).toBe(200)
    expect(samplesAt(ts)).toHaveLength(4)
    // No claim about the vantage is better than a fabricated one.
    expect(cycleRow(ts)).toBeUndefined()
  })

  test('the raw round-trip samples survive the round trip', async () => {
    const ts = freshTs()
    await post(batch(ts, ETHERNET))

    const stored = samplesAt(ts).find((row) => row.target === 'cloudflare')
    expect(JSON.parse(stored?.samples ?? 'null')).toEqual([10.998, 4.129, 2.804])
    expect(stored?.duplicates).toBe(0)
    expect(stored?.outOfWaitTime).toBe(0)
  })
})

describe('POST /api/probes — the home line cannot be claimed by the collector alone', () => {
  test('a cellular cycle with a NULL gateway is not stored as the home line', async () => {
    const ts = freshTs()
    // The failover shape that reached a live server and was stored as the home
    // line: a named cellular path, no gateway on the default route, and a
    // collector verdict of 1 (a stale one — the collector's own rule now says 0).
    const cellular: Vantage = {
      pathIf: 'en11',
      pathClass: 'cellular',
      linkMedia: null,
      linkMbit: null,
      linkDuplex: null,
      gatewayAddr: null,
      ifIerrs: null,
      ifOerrs: null,
      ifColl: null,
      onHomeLine: 1,
    }

    const res = await post(batch(ts, cellular))
    expect(res.status).toBe(200)
    expect(cycleRow(ts)?.onHomeLine).toBe(0)
    expect(cycleRow(ts)?.pathClass).toBe('cellular')
  })

  test('Wi-Fi with a null gateway is not the home line either', async () => {
    const ts = freshTs()
    const wifi: Vantage = { ...ETHERNET, pathIf: 'en1', pathClass: 'wifi', gatewayAddr: null, linkMbit: null, onHomeLine: 1 }

    await post(batch(ts, wifi))
    expect(cycleRow(ts)?.onHomeLine).toBe(0)
  })

  test('an all-null vantage — the link-down cycle — is unknown, neither 1 nor 0', async () => {
    const ts = freshTs()
    const noPath: Vantage = {
      pathIf: null,
      pathClass: null,
      linkMedia: null,
      linkMbit: null,
      linkDuplex: null,
      gatewayAddr: null,
      ifIerrs: null,
      ifOerrs: null,
      ifColl: null,
      onHomeLine: null,
    }

    await post(batch(ts, noPath))
    // Scoring this 0 would let a read path filtering on on_home_line throw away
    // the outage the collector exists to record.
    expect(cycleRow(ts)?.onHomeLine).toBeNull()
  })

  test('Ethernet through a foreign gateway is not the home line, whatever the collector claims', async () => {
    const ts = freshTs()
    const foreign: Vantage = { ...ETHERNET, gatewayAddr: '10.0.0.1', onHomeLine: 1 }

    await post(batch(ts, foreign))
    expect(cycleRow(ts)?.onHomeLine).toBe(0)
  })
})

describe('POST /api/probes — spool replay', () => {
  test('replaying an ingested batch is a no-op: no rows, no vantage, no event', async () => {
    const ts = freshTs()
    await post(batch(ts, ETHERNET))
    // A link change on the next cycle, so there is an event that a replay could
    // duplicate if the guard were missing.
    const changed = await post(batch(ts + 30_000, { ...ETHERNET, linkMedia: '100baseTX', linkMbit: 100 }))
    expect(await changed.json()).toMatchObject({ linkChange: true })

    const eventsBefore = db.select().from(event).all().length
    const replay = await post(batch(ts + 30_000, { ...ETHERNET, linkMedia: '100baseTX', linkMbit: 100 }))

    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ ok: true, inserted: 0, skipped: true, linkChange: false })
    expect(samplesAt(ts + 30_000)).toHaveLength(4)
    expect(db.select().from(probeCycle).all().filter((row) => row.ts === ts + 30_000)).toHaveLength(1)
    expect(db.select().from(event).all().length).toBe(eventsBefore)
  })
})

describe('POST /api/probes — bearer', () => {
  test('no Authorization header is 401 and writes nothing', async () => {
    const ts = freshTs()
    const res = await post(batch(ts, ETHERNET), null)

    expect(res.status).toBe(401)
    expect(samplesAt(ts)).toHaveLength(0)
    expect(cycleRow(ts)).toBeUndefined()
  })

  test('a wrong token is 401 — the one route that can forge the record', async () => {
    const ts = freshTs()
    const res = await post(batch(ts, ETHERNET), 'not-the-token')

    expect(res.status).toBe(401)
    expect(samplesAt(ts)).toHaveLength(0)
  })
})

describe('GET /api/probes — the vantage reaches the read path', () => {
  test('a cellular cycle reads back as `none`, never folded into the home line', async () => {
    const ts = freshTs()
    await post(batch(ts, { ...ETHERNET, pathIf: 'en11', pathClass: 'cellular', gatewayAddr: null, onHomeLine: 1 }))

    const res = await app.handle(new Request(`http://localhost/api/probes?from=${ts - 1000}&to=${ts + 1000}&bucket=3600`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { vantage: { onHomeLine: string; offHomeLineCycles: number }[] }
    expect(body.vantage[0]?.onHomeLine).toBe('none')
    expect(body.vantage[0]?.offHomeLineCycles).toBe(1)
  })
})

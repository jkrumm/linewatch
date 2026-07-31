import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { parsePingOutput } from '../../collector/ping-parser.js'
import type { LinkTransition } from '../../collector/link-sampler.js'
import { deriveOnHomeLine, type Vantage } from '../../collector/vantage.js'
import type { WifiSampleInput } from '../../collector/wifi.js'

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
const { event, probeCycle, probeSample, wifiSample } = await import('../db/schema.js')

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
  linkMaxMbit: 1000,
  dhcpBoundAt: 1_785_419_309_000,
  // The collector has no link sampler yet, so it sends null — "unknown", not 0.
  linkWatchS: null,
}

interface Batch {
  ts: number
  samples: ReturnType<typeof samples>
  cycle?: Vantage
  linkEvents?: LinkTransition[]
  wifi?: WifiSampleInput
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

function batch(ts: number, cycle?: Vantage, linkEvents?: LinkTransition[]): Batch {
  return {
    ts,
    samples: samples(),
    ...(cycle === undefined ? {} : { cycle }),
    ...(linkEvents === undefined ? {} : { linkEvents }),
  }
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
    expect(await res.json()).toEqual({ ok: true, inserted: 4, skipped: false, linkChange: false, cycleStored: true })
    expect(samplesAt(ts)).toHaveLength(4)
  })

  test('the whole vantage lands, ceiling and lease included', async () => {
    // Not decoration: `linkMaxMbit` is what separates "the NIC can only do 100"
    // from "it can do 1000 and negotiated 100", and a field the route drops
    // silently reads downstream as "unknown" forever.
    const ts = freshTs()
    await post(batch(ts, { ...ETHERNET, linkMbit: 100, linkMedia: '100baseTX' }))

    const row = cycleRow(ts)
    expect(row?.linkMbit).toBe(100)
    expect(row?.linkMaxMbit).toBe(1000)
    expect(row?.dhcpBoundAt).toBe(1_785_419_309_000)
    // Null, not 0: this collector runs no link sampler, and 0 would claim a
    // cycle that watched the link and saw nothing.
    expect(row?.linkWatchS).toBeNull()
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
    // …and the server says so, rather than letting "no cycle sent" look the
    // same as "cycle sent and stored".
    expect(await res.json()).toMatchObject({ cycleStored: false })
  })

  test('a cycle field this API does not know is ignored, and the batch still ingests', async () => {
    // The other direction of the independent-deploy contract: a collector ahead
    // of the API. Lenient parse on purpose — rejecting the batch would lose four
    // real probe samples over one unknown field.
    const ts = freshTs()
    const res = await post({ ...batch(ts, ETHERNET), cycle: { ...ETHERNET, somethingTheApiHasNeverSeen: 42 } })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ cycleStored: true })
    expect(cycleRow(ts)?.linkMaxMbit).toBe(1000)
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
      linkMaxMbit: null,
      dhcpBoundAt: null,
      linkWatchS: null,
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
      linkMaxMbit: null,
      dhcpBoundAt: null,
      linkWatchS: null,
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
    // `cycleStored: false` alongside `skipped: true` is the correct answer, not
    // a dropped vantage: this ts stored its vantage on the first ingest. The
    // collector only warns when `skipped` is false, and this pair is why.
    expect(await replay.json()).toEqual({ ok: true, inserted: 0, skipped: true, linkChange: false, cycleStored: false })
    expect(samplesAt(ts + 30_000)).toHaveLength(4)
    expect(db.select().from(probeCycle).all().filter((row) => row.ts === ts + 30_000)).toHaveLength(1)
    expect(db.select().from(event).all().length).toBe(eventsBefore)
  })
})

describe('POST /api/probes — sub-cycle link transitions', () => {
  /** Every `link_change` written by the 1 Hz sampler at exactly this ts. */
  function samplerEventsAt(ts: number) {
    return db
      .select()
      .from(event)
      .all()
      .filter((row) => row.ts === ts && row.kind === 'link_change')
      .map((row) => ({ ...row, detail: JSON.parse(row.detail) as { source?: string; state?: string; iface?: string | null } }))
      .filter((row) => row.detail.source === 'link-sampler')
  }

  test('a cable pull mid-cycle lands as two events tagged with their source', async () => {
    const ts = freshTs()
    // The shape the sampler drains for a flap inside one 30 s cycle: the
    // vantage diff cannot see this at all — both snapshots read 1000baseT.
    const downAt = ts + 8_000
    const upAt = ts + 22_300
    const res = await post(batch(ts, { ...ETHERNET, linkWatchS: 30 }, [{ ts: downAt, state: 'down' }, { ts: upAt, state: 'up' }]))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ linkChange: true, cycleStored: true })

    // Timestamped at the second the sampler saw them, not folded onto the
    // cycle's ts — that resolution is the entire point of the sampler.
    expect(samplerEventsAt(downAt).map((row) => row.detail)).toEqual([{ source: 'link-sampler', state: 'down', iface: 'en0' }])
    expect(samplerEventsAt(upAt).map((row) => row.detail)).toEqual([{ source: 'link-sampler', state: 'up', iface: 'en0' }])
    // …and the coverage counter that makes "no transitions" readable reaches
    // the column, rather than staying null and reading as "nothing watched".
    expect(cycleRow(ts)?.linkWatchS).toBe(30)
  })

  test('the iface is null when the cycle reported no default route, never a plausible one', async () => {
    const ts = freshTs()
    const downAt = ts + 3_000
    const noPath: Vantage = { ...ETHERNET, pathIf: null, pathClass: null, gatewayAddr: null, linkMbit: null, onHomeLine: null, linkWatchS: 30 }

    await post(batch(ts, noPath, [{ ts: downAt, state: 'down' }]))
    expect(samplerEventsAt(downAt)[0]?.detail.iface).toBeNull()
  })

  test('reposting an identical batch writes the link events exactly once', async () => {
    const ts = freshTs()
    const downAt = ts + 5_000
    const events = [{ ts: downAt, state: 'down' as const }]

    await post(batch(ts, ETHERNET, events))
    const replay = await post(batch(ts, ETHERNET, events))

    // The spool replays batches verbatim, and `event.ts` has no unique index to
    // fall back on — it must not gain one, because interventions legitimately
    // share a timestamp.
    expect(await replay.json()).toMatchObject({ skipped: true, linkChange: false })
    expect(samplerEventsAt(downAt)).toHaveLength(1)
  })

  test('a later batch re-sending an already-recorded transition does not duplicate it', async () => {
    const ts = freshTs()
    const downAt = ts + 5_000
    await post(batch(ts, ETHERNET, [{ ts: downAt, state: 'down' }]))

    // The case the `skipped` branch does not cover: a *different* cycle whose
    // sampling window overlaps one already ingested. Only the explicit
    // ts+kind guard stops this one.
    await post(batch(ts + 30_000, ETHERNET, [{ ts: downAt, state: 'down' }, { ts: ts + 35_000, state: 'up' }]))

    expect(samplerEventsAt(downAt)).toHaveLength(1)
    expect(samplerEventsAt(ts + 35_000)).toHaveLength(1)
  })

  test('a batch with no linkEvents key ingests unchanged — a collector without a sampler', async () => {
    const ts = freshTs()
    const res = await post(batch(ts, ETHERNET))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ linkChange: false })
    // Null, not 0: no sampler ran, so link state for this cycle is unknown.
    expect(cycleRow(ts)?.linkWatchS).toBeNull()
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

describe('POST /api/probes — the Wi-Fi radio sample', () => {
  // Exactly what collector/wifi.ts returns on this host: an alternate radio
  // path currently attached, associated and reachable. Not "the standby path"
  // — the configured next hop above Wi-Fi here is a cellular hotspot.
  const WIFI: WifiSampleInput = {
    iface: 'en1',
    status: 'Connected',
    phyMode: '802.11ax',
    channel: 3,
    band: '2GHz',
    widthMhz: 20,
    rssiDbm: -45,
    noiseDbm: -83,
    txRateMbps: 229,
    mcsIndex: 9,
    rttMedMs: 9.99,
    lossPct: 0,
  }

  function wifiRowsAt(ts: number) {
    return db
      .select()
      .from(wifiSample)
      .all()
      .filter((row) => row.ts === ts)
  }

  test('stores the radio sample that rode along with the cycle', async () => {
    const ts = freshTs()
    const res = await post({ ...batch(ts, ETHERNET), wifi: WIFI })

    expect(res.status).toBe(200)
    const [row] = wifiRowsAt(ts)
    expect(row).toMatchObject({ iface: 'en1', status: 'Connected', rssiDbm: -45, txRateMbps: 229, rttMedMs: 9.99 })
  })

  test('a cycle without a Wi-Fi sample writes no row — nine cycles in ten', async () => {
    const ts = freshTs()
    await post(batch(ts, ETHERNET))
    expect(wifiRowsAt(ts)).toHaveLength(0)
  })

  test('a replayed batch cannot duplicate the row', async () => {
    // The spool replays batches verbatim. `wifi_sample.ts` is UNIQUE and the
    // insert is onConflictDoNothing, so a replay that gets past the
    // already-ingested check still cannot write a second radio sample for one
    // instant.
    const ts = freshTs()
    await post({ ...batch(ts, ETHERNET), wifi: WIFI })
    await post({ ...batch(ts, ETHERNET), wifi: { ...WIFI, rssiDbm: -70 } })

    const rows = wifiRowsAt(ts)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.rssiDbm).toBe(-45)
  })

  test('an all-null radio sample is stored as the finding it is', async () => {
    // What a churned `system_profiler` produces: the sample happened, the radio
    // state is unknown. A row of nulls says that; dropping the row would say
    // "no sample was taken", which is a different and false statement.
    const ts = freshTs()
    const nulls: WifiSampleInput = {
      iface: 'en1',
      status: null,
      phyMode: null,
      channel: null,
      band: null,
      widthMhz: null,
      rssiDbm: null,
      noiseDbm: null,
      txRateMbps: null,
      mcsIndex: null,
      rttMedMs: null,
      lossPct: 100,
    }
    await post({ ...batch(ts, ETHERNET), wifi: nulls })

    const [row] = wifiRowsAt(ts)
    expect(row).toMatchObject({ iface: 'en1', status: null, rssiDbm: null, rttMedMs: null, lossPct: 100 })
  })

  test('a collector that omits fields entirely still ingests', async () => {
    // Collector and API deploy independently: every field is optional on the
    // wire, and an omitted one lands as null rather than 422ing a batch that
    // also carries four real probe samples.
    const ts = freshTs()
    const res = await post({ ...batch(ts, ETHERNET), wifi: { iface: 'en1', rssiDbm: -50 } })

    expect(res.status).toBe(200)
    expect(wifiRowsAt(ts)[0]).toMatchObject({ iface: 'en1', rssiDbm: -50, phyMode: null, txRateMbps: null })
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

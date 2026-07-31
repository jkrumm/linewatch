import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import type { WifiSampleInput } from '../../collector/wifi.js'

/**
 * Route-level tests for the Wi-Fi history, over real HTTP.
 *
 * Rows are inserted in the collector's own `WifiSampleInput` shape rather than
 * as hand-written literals, so a field the collector starts or stops reporting
 * breaks this file at typecheck instead of drifting silently — the same
 * discipline probes.test.ts applies to the ingest contract.
 *
 * What is pinned here is mostly what the route refuses to do: average a channel
 * or a band into a value the radio was never on, invent an SNR out of a
 * half-measured sample, or hand back raw rows for a long range.
 */

// Set before the route module is pulled in: src/config.ts and src/db/client.ts
// read the environment at import time, and the production database lives in a
// Docker volume the host cannot open at all (docs/storage.md).
process.env['LINEWATCH_DB'] = ':memory:'
process.env['LINEWATCH_TOKEN'] ??= 'test-token-not-the-real-one'

const { wifiRoutes } = await import('./wifi.js')
const { db } = await import('../db/client.js')
const { wifiSample } = await import('../db/schema.js')

const app = new Elysia().use(wifiRoutes)

// Day-aligned, so the SQL grouping key `(ts / bucketMs) * bucketMs` starts a
// bucket exactly here and the assertions below count samples rather than
// boundary offsets.
const BASE = 1_700_000_000_000 - (1_700_000_000_000 % 86_400_000)

/** A connected 2.4 GHz sample, in the exact shape collector/wifi.ts returns. */
function sample(overrides: Partial<WifiSampleInput> = {}): WifiSampleInput {
  return {
    iface: 'en1',
    status: 'Connected',
    phyMode: '802.11ax',
    channel: 3,
    band: '2GHz',
    widthMhz: 20,
    rssiDbm: -45,
    noiseDbm: -85,
    txRateMbps: 229,
    mcsIndex: 9,
    rttMedMs: 9.99,
    lossPct: 0,
    ...overrides,
  }
}

function insert(ts: number, overrides: Partial<WifiSampleInput> = {}): void {
  db.insert(wifiSample).values({ ts, ...sample(overrides) }).run()
}

interface WifiBucket {
  bucket: number
  samples: number
  connectedSamples: number
  bands: string[]
  phyModes: string[]
  statuses: string[]
  channelMax: number | null
  widthMhzMax: number | null
  rssiDbmAvg: number | null
  noiseDbmAvg: number | null
  snrDbAvg: number | null
  txRateMbpsAvg: number | null
  rttMedMsAvg: number | null
  lossPctAvg: number | null
}

async function get(query: string): Promise<{ buckets: WifiBucket[] }> {
  const response = await app.handle(new Request(`http://localhost/api/wifi?${query}`))
  expect(response.status).toBe(200)
  return (await response.json()) as { buckets: WifiBucket[] }
}

describe('GET /api/wifi', () => {
  test('buckets in SQL: a range covering every row returns one row per bucket', async () => {
    db.delete(wifiSample).run()
    // Two hours of the real cadence — one sample every 5 minutes.
    for (let i = 0; i < 24; i++) insert(BASE + i * 300_000, { rssiDbm: -40 - i })

    const hourly = await get(`from=${BASE}&to=${BASE + 2 * 3600_000}&bucket=3600`)
    expect(hourly.buckets).toHaveLength(2)
    expect(hourly.buckets[0]?.samples).toBe(12)
    expect(hourly.buckets[1]?.samples).toBe(12)
    // The aggregate really is an aggregate, not the first row repeated.
    expect(hourly.buckets[0]?.rssiDbmAvg).toBe(-45.5)
  })

  test('a bucket spanning a band change reports both, never an average', async () => {
    db.delete(wifiSample).run()
    insert(BASE, { band: '2GHz', channel: 3, widthMhz: 20, phyMode: '802.11ax' })
    insert(BASE + 300_000, { band: '5GHz', channel: 44, widthMhz: 80, phyMode: '802.11ac' })

    const [bucket] = (await get(`from=${BASE}&to=${BASE + 3600_000}&bucket=3600`)).buckets
    expect(bucket?.bands).toEqual(['2GHz', '5GHz'])
    expect(bucket?.phyModes).toEqual(['802.11ac', '802.11ax'])
    // Channels are labels: the mean of 3 and 44 is a channel nothing was on.
    expect(bucket?.channelMax).toBe(44)
    expect(bucket?.widthMhzMax).toBe(80)
  })

  test('a disconnected sample is counted, not hidden', async () => {
    db.delete(wifiSample).run()
    insert(BASE)
    // What the collector writes when the radio is associated with nothing: a
    // status and no radio values at all.
    insert(BASE + 300_000, {
      status: 'Not Connected',
      phyMode: null,
      channel: null,
      band: null,
      widthMhz: null,
      rssiDbm: null,
      noiseDbm: null,
      txRateMbps: null,
      mcsIndex: null,
      rttMedMs: null,
      lossPct: null,
    })

    const [bucket] = (await get(`from=${BASE}&to=${BASE + 3600_000}&bucket=3600`)).buckets
    expect(bucket?.samples).toBe(2)
    expect(bucket?.connectedSamples).toBe(1)
    expect(bucket?.statuses).toEqual(['Connected', 'Not Connected'])
    // The averages describe the one sample that measured anything — they are
    // not diluted toward zero by the sample that measured nothing.
    expect(bucket?.rssiDbmAvg).toBe(-45)
    expect(bucket?.txRateMbpsAvg).toBe(229)
  })

  test('snr is derived only from samples that measured both sides', async () => {
    db.delete(wifiSample).run()
    insert(BASE, { rssiDbm: -45, noiseDbm: -85 })
    // Half-measured: a noise floor the OS did not report. Reading this as an
    // SNR of 45 dB against an assumed 0 dBm floor would be fabrication.
    insert(BASE + 300_000, { rssiDbm: -45, noiseDbm: null })

    const [bucket] = (await get(`from=${BASE}&to=${BASE + 3600_000}&bucket=3600`)).buckets
    expect(bucket?.snrDbAvg).toBe(40)
    expect(bucket?.noiseDbmAvg).toBe(-85)
  })

  test('no sample measured a value at all leaves it null, never 0', async () => {
    db.delete(wifiSample).run()
    insert(BASE, { rssiDbm: null, noiseDbm: null, txRateMbps: null, rttMedMs: null, lossPct: null })

    const [bucket] = (await get(`from=${BASE}&to=${BASE + 3600_000}&bucket=3600`)).buckets
    expect(bucket?.samples).toBe(1)
    expect(bucket?.rssiDbmAvg).toBeNull()
    expect(bucket?.snrDbAvg).toBeNull()
    expect(bucket?.txRateMbpsAvg).toBeNull()
    expect(bucket?.rttMedMsAvg).toBeNull()
    expect(bucket?.lossPctAvg).toBeNull()
  })

  test('a 30-day range comes back as buckets, not as rows', async () => {
    db.delete(wifiSample).run()
    const thirtyDays = 30 * 24 * 3600_000
    // A month of the real cadence would be 8640 rows; a hundredth of it is
    // enough to show the shape without the insert cost.
    for (let i = 0; i < 288; i++) insert(BASE + i * 300_000 * 30)

    const { buckets } = await get(`from=${BASE}&to=${BASE + thirtyDays}&bucket=86400`)
    expect(buckets.length).toBeLessThanOrEqual(31)
    expect(buckets.reduce((total, b) => total + b.samples, 0)).toBe(288)
  })
})

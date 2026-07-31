import { describe, expect, test } from 'bun:test'
import { createTestDb } from '../db/test-db.js'
import { event, outage, probeCycle, probeSample, routerLineSample, speedTest } from '../db/schema.js'
import { collectVerdictInput } from './verdict-queries.js'
import { deriveVerdicts } from './verdict.js'

/**
 * The SQL half, against the real migrations.
 *
 * `verdict.test.ts` proves the rules; this proves the queries that feed them —
 * that they run, that they map onto the shapes the rules expect, and above all
 * that a null in the database arrives as a null rather than as a zero. A rule
 * that correctly refuses a null term is worthless if the query layer invents one
 * on the way in.
 */

const T0 = Date.UTC(2026, 6, 30, 12, 0, 0)
const CYCLE_MS = 30_000
const CYCLES = 21
const FROM = T0
const TO = T0 + 60 * 60 * 1000
const NOW = TO

const GATEWAY = 'gateway'
const ANCHORS = ['cloudflare', 'google', 'quad9']
const ADDRS: Record<string, string> = { gateway: '192.168.1.1', cloudflare: '1.1.1.1', google: '8.8.8.8', quad9: '9.9.9.9' }

const STALL_CYCLE = 10
const GATEWAY_OUTAGE_CYCLE = 12
const SYMMETRIC_CYCLES = [14, 15]

const PARAMS = {
  from: FROM,
  to: TO,
  now: NOW,
  probeCycleSeconds: 30,
  degradedLossPct: 20,
  wanTargets: ANCHORS,
  gatewayTarget: GATEWAY,
  expectedTargetCount: 4,
  router: { enabled: true, disabledReason: null, pollIntervalMs: 300_000 },
}

/** One target's row for a cycle. `medMs`/`maxMs` null is 100% loss, as the collector writes it. */
function sample(ts: number, target: string, lossPct: number, medMs: number | null, maxMs: number | null) {
  const received = Math.round(20 * (1 - lossPct / 100))
  return { ts, target, addr: ADDRS[target] ?? '0.0.0.0', sent: 20, received, lossPct, minMs: medMs, medMs, maxMs, avgMs: medMs, jitterMs: null, samples: null }
}

function seed() {
  const db = createTestDb()

  for (let k = 0; k < CYCLES; k += 1) {
    const ts = T0 + k * CYCLE_MS
    db.insert(probeCycle)
      .values({
        ts,
        pathIf: 'en0',
        pathClass: 'ethernet',
        linkMedia: '100baseTX',
        linkMbit: 100,
        linkDuplex: 'full',
        gatewayAddr: ADDRS[GATEWAY] ?? null,
        ifIerrs: 100 + k,
        ifOerrs: 200 + k,
        ifColl: 0,
        onHomeLine: 1,
        linkMaxMbit: 1000,
        dhcpBoundAt: null,
        // Only one cycle was backed by the link sampler. Every other cycle is
        // null — the state the record is actually in — and must not sum as 0.
        linkWatchS: k === STALL_CYCLE ? 30 : null,
      })
      .run()

    if (k === STALL_CYCLE) {
      // Every target's worst round trip 15× its own median, zero loss.
      db.insert(probeSample)
        .values([GATEWAY, ...ANCHORS].map((target) => sample(ts, target, 0, 4, 60)))
        .run()
      continue
    }
    if (k === GATEWAY_OUTAGE_CYCLE) {
      db.insert(probeSample)
        .values([sample(ts, GATEWAY, 100, null, null), ...ANCHORS.map((target) => sample(ts, target, 0, 60, 70))])
        .run()
      continue
    }
    if (SYMMETRIC_CYCLES.includes(k)) {
      db.insert(probeSample)
        .values([sample(ts, GATEWAY, 80, 1.4, 3), ...ANCHORS.map((target) => sample(ts, target, 70, 5, 9))])
        .run()
      continue
    }
    db.insert(probeSample)
      .values([GATEWAY, ...ANCHORS].map((target) => sample(ts, target, 0, 4, 8)))
      .run()
  }

  db.insert(outage)
    .values([
      // Overlaps the derived showtime instant at T0 — the resync attribution
      // candidate.
      { scope: 'wan', startedAt: T0 - 60_000, endedAt: T0 + 10_000, durationS: 70, cycles: 3, evidence: JSON.stringify(ANCHORS) },
      {
        scope: 'gateway',
        startedAt: T0 + GATEWAY_OUTAGE_CYCLE * CYCLE_MS,
        endedAt: T0 + (GATEWAY_OUTAGE_CYCLE + 1) * CYCLE_MS,
        durationS: 30,
        cycles: 1,
        evidence: JSON.stringify([GATEWAY]),
      },
    ])
    .run()

  db.insert(speedTest)
    .values({
      ts: T0 + 600_000,
      backend: 'ookla',
      ok: true,
      downloadMbps: 93.5,
      uploadMbps: 40,
      bytesDown: 712_140_000,
      durationS: 24.9,
    })
    .run()

  // Three polls hours apart agreeing on `ts − showtime_start_s × 1000`, plus a
  // recent one so the sync reading still describes `now`.
  for (const [ts, showtimeStartS] of [
    [T0 + 600_000, 600],
    [T0 + 900_000, 900],
    [T0 + 1_200_000, 1200],
    [TO - 300_000, 3300],
  ] as const) {
    db.insert(routerLineSample).values({ ts, carrier: 'gfast', status: 'Up', downSyncKbps: 803_140, showtimeStartS }).run()
  }

  // Carrier-side, not host-side: this must not count towards the host link gate.
  db.insert(event)
    .values({ ts: T0 + 60_000, kind: 'link_change', detail: JSON.stringify({ source: 'router-poller', changed: {} }) })
    .run()

  return db
}

const db = seed()
const input = collectVerdictInput(db, PARAMS)

describe('collectVerdictInput — nullability survives the trip out of SQL', () => {
  test('link sampling sums only the cycles that reported it', () => {
    expect(input.linkState.watchedS).toBe(30)
    expect(input.linkState.windowS).toBe(3600)
  })

  test('a router-poller link_change is not a host link transition', () => {
    expect(input.linkState.transitions).toBe(0)
    expect(input.linkChangeEvents).toBe(1)
  })

  test('a window with no sampled cycle in it reports null coverage, not zero', () => {
    // The ±2 min gate around the derived resync instant covers only cycles that
    // never reported `link_watch_s`.
    expect(input.resyncClusters[0]?.linkState.watchedS).toBeNull()
  })
})

describe('collectVerdictInput — the per-rule inputs', () => {
  test('speed tests carry the range maximum link speed, not a nearest reading', () => {
    expect(input.throughput).toHaveLength(1)
    expect(input.throughput[0]?.maxLinkMbit).toBe(100)
    expect(input.throughput[0]?.vantageCycles).toBe(CYCLES)
    expect(input.throughput[0]?.wireMbps).toBeCloseTo(228.8, 1)
  })

  test('the newest link, sync and download readings come back together', () => {
    expect(input.linkVsSync).toMatchObject({
      linkMbit: 100,
      linkMaxMbit: 1000,
      linkMedia: '100baseTX',
      linkDuplex: 'full',
      pathIf: 'en0',
      downSyncKbps: 803_140,
      downloadMbps: 93.5,
      distinctLinkMbits: 1,
      vantageCycles: CYCLES,
      homeLineCycles: CYCLES,
    })
  })

  test('agreeing showtime instants cluster into one resync with its overlapping outage', () => {
    expect(input.resyncClusters).toHaveLength(1)
    expect(input.resyncClusters[0]?.upAt).toBe(T0)
    expect(input.resyncClusters[0]?.samples).toBe(4)
    expect(input.resyncClusters[0]?.spreadMs).toBe(0)
    expect(input.resyncClusters[0]?.outage).toMatchObject({ endedAt: T0 + 10_000, durationS: 70 })
  })

  test('the stalled cycle arrives with its per-target medians and its sampling coverage', () => {
    expect(input.pathStalls).toHaveLength(1)
    expect(input.pathStalls[0]).toMatchObject({ ts: T0 + STALL_CYCLE * CYCLE_MS, targetCount: 4, minRatio: 15, maxLossPct: 0, linkWatchS: 30 })
    expect(input.pathStalls[0]?.perTarget).toHaveLength(4)
  })

  test('the gateway outage arrives with the vantage that could suppress it', () => {
    expect(input.gatewayOutages).toHaveLength(1)
    expect(input.gatewayOutages[0]).toMatchObject({
      ts: T0 + GATEWAY_OUTAGE_CYCLE * CYCLE_MS,
      gatewaySent: 20,
      gatewayReceived: 0,
      wanAliveCount: 3,
      wanMedMs: 60,
      onHomeLine: 1,
      gatewayAddr: ADDRS[GATEWAY],
      previousGatewayAddr: ADDRS[GATEWAY],
    })
  })

  test('symmetric loss counts its cycles and the NIC counter movement across them', () => {
    expect(input.symmetricLoss).toMatchObject({
      cycles: 2,
      firstTs: T0 + 14 * CYCLE_MS,
      lastTs: T0 + 15 * CYCLE_MS,
      wanTargetCount: 3,
      // Cumulative counters, so the movement is last − first over the window.
      ifIerrsDelta: 1,
      ifOerrsDelta: 1,
      ifCollDelta: 0,
    })
    expect(input.symmetricLoss?.exampleTargets).toHaveLength(4)
  })

  test('carrier-side coverage counts due polls and the worst gap between them', () => {
    expect(input.router).toMatchObject({ polls: 4, expectedPolls: 13, worstGapMs: 2_100_000 })
  })
})

describe('the whole layer over a seeded window', () => {
  test('fires the rules the data supports and no others', () => {
    const ids = deriveVerdicts(input).map((v) => v.id)
    expect(ids).toContain('throughput_exceeds_link')
    expect(ids).toContain('link_below_carrier_sync')
    expect(ids).toContain('probe_coverage_low')
    expect(ids).toContain('router_coverage_low')
    expect(ids).toContain('carrier_resync_dated')
    expect(ids).toContain('sub_cycle_path_stall')
    expect(ids).toContain('gateway_outage_uncorroborated')
    expect(ids).toContain('symmetric_loss_not_line')
  })

  test('the gated rules withhold their attribution, because the sampler covered almost none of this window', () => {
    const verdicts = deriveVerdicts(input)
    const gated = verdicts.filter((v) => ['carrier_resync_dated', 'gateway_outage_uncorroborated', 'symmetric_loss_not_line'].includes(v.id))
    expect(gated).toHaveLength(3)
    for (const v of gated) expect(v.uncertainty).not.toBeNull()
    expect(verdicts.find((v) => v.id === 'gateway_outage_uncorroborated')?.severity).toBe('info')
    expect(verdicts.find((v) => v.id === 'carrier_resync_dated')?.conclusion).not.toContain('was the line')
  })
})

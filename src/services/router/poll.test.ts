import { describe, expect, it } from 'bun:test'
import { createTestDb } from '../../db/test-db.js'
import { event, probeCycle, routerEthPort, routerHost, routerIntfSample, routerLineSample } from '../../db/schema.js'
import {
  RouterBusyError,
  RouterOidError,
  RouterSessionLostError,
  RouterUnreachableError,
  type RouterOperation,
} from './client.js'
import {
  ADT_WAN_ROWS,
  DSL_LINE_STATS_ROW,
  ETH_INTF_ROWS,
  FAST_LINE_ROW,
  HOSTS_ROW,
  HOST_ENTRY_ROWS,
  IP_INTF_ROWS,
  IP_INTF_STATS_ROWS,
} from './fixtures.js'
import { readRouterSnapshot, RouterPoller, type RouterReader } from './poll.js'
import { redactRow } from './redact.js'

type RawRows = Array<Record<string, string>>

function defaultResponses(): Record<string, RawRows> {
  return {
    DEV2_FAST_LINE: [FAST_LINE_ROW],
    DEV2_DSL_LINE_STATS: [DSL_LINE_STATS_ROW],
    DEV2_ADT_WAN: ADT_WAN_ROWS,
    DEV2_IP_INTF: IP_INTF_ROWS,
    DEV2_IP_INTF_STATS: IP_INTF_STATS_ROWS,
    DEV2_ETH_INTF: ETH_INTF_ROWS,
    DEV2_HOSTS: [HOSTS_ROW],
    DEV2_HOST_ENTRY: HOST_ENTRY_ROWS,
  }
}

/** Stands in for the router. Responses go through the real redactor, as they do live. */
class FakeRouter implements RouterReader {
  readonly calls: Array<{ oid: string; operation: RouterOperation }> = []

  constructor(
    private responses: Record<string, RawRows> = defaultResponses(),
    private readonly errors: Record<string, Error> = {},
  ) {}

  read(oid: string, operation: RouterOperation): Promise<Array<Record<string, string>>> {
    this.calls.push({ oid, operation })
    const error = this.errors[oid]
    if (error !== undefined) return Promise.reject(error)
    return Promise.resolve((this.responses[oid] ?? []).map(redactRow))
  }

  replace(oid: string, rows: RawRows): void {
    this.responses = { ...this.responses, [oid]: rows }
  }
}

function makePoller(client: RouterReader, now: () => number) {
  const db = createTestDb()
  const poller = new RouterPoller({
    db,
    client,
    collectorHostIp: '192.168.1.100',
    now,
    sleep: () => Promise.resolve(),
  })
  return { db, poller }
}

/** The host-side vantage the collector would have written for this cycle. */
function writeHostVantage(
  db: ReturnType<typeof createTestDb>,
  ts: number,
  overrides: Partial<typeof probeCycle.$inferInsert> = {},
) {
  db.insert(probeCycle)
    .values({
      ts,
      pathIf: 'en0',
      pathClass: 'ethernet',
      linkMedia: '1000baseT',
      linkMbit: 1000,
      linkDuplex: 'full',
      gatewayAddr: '192.168.1.1',
      onHomeLine: 1,
      ...overrides,
    })
    .run()
}

describe('RouterPoller', () => {
  it('reads the host list with `gl`, never `go`', () => {
    const client = new FakeRouter()
    const { poller } = makePoller(client, () => 1_000)
    return poller.poll().then(() => {
      const hostEntry = client.calls.find((call) => call.oid === 'DEV2_HOST_ENTRY')
      // `go` on this list returns exactly one instance and no error at all.
      expect(hostEntry?.operation).toBe('gl')
    })
  })

  it('records one line sample with margins already converted to dB', async () => {
    const { db, poller } = makePoller(new FakeRouter(), () => 1_000)
    await poller.poll()

    const rows = db.select().from(routerLineSample).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      ts: 1_000,
      carrier: 'gfast',
      status: 'Up',
      downSyncKbps: 803140,
      downNoiseMarginDb: 6.1,
      downAttenuationDb: 8.5,
      showtimeStartS: 3589,
    })
  })

  it('persists only the live WAN and the LAN bridge, not the idle WAN profiles', async () => {
    const { db, poller } = makePoller(new FakeRouter(), () => 1_000)
    await poller.poll()

    const rows = db.select().from(routerIntfSample).all()
    expect(rows.map((row) => `${row.name}:${row.role}`).sort()).toEqual(['br0:lan', 'ppp0:wan'])
    expect(rows.find((row) => row.role === 'wan')?.rxKbps).toBe(436)
  })

  it('persists every port but only the hosts that are actually connected', async () => {
    const { db, poller } = makePoller(new FakeRouter(), () => 1_000)
    await poller.poll()

    expect(db.select().from(routerEthPort).all()).toHaveLength(ETH_INTF_ROWS.length)
    const hosts = db.select().from(routerHost).all()
    // The third fixture host is an inactive DHCP lease, not a connection.
    expect(hosts.map((host) => host.ip)).toEqual(['192.168.1.100', '192.168.1.104'])
  })

  it('warns when a list is shorter than the count the firmware reports', async () => {
    const client = new FakeRouter()
    client.replace('DEV2_HOST_ENTRY', [HOST_ENTRY_ROWS[0]!])
    const { db, poller } = makePoller(client, () => 1_000)

    const summary = await poller.poll()
    expect(summary.warnings.join(' ')).toContain('the "go" truncation shape')
    // Still recorded: the mismatch is the alarm, not a reason to drop the poll.
    expect(db.select().from(routerHost).all()).toHaveLength(1)
  })

  it('degrades to a warning when one OID is refused and records the rest', async () => {
    const client = new FakeRouter(defaultResponses(), {
      DEV2_ETH_INTF: new RouterOidError('DEV2_ETH_INTF', '9005'),
    })
    const { db, poller } = makePoller(client, () => 1_000)

    const summary = await poller.poll()
    expect(summary.warnings[0]).toContain('DEV2_ETH_INTF')
    expect(db.select().from(routerEthPort).all()).toHaveLength(0)
    expect(db.select().from(routerLineSample).all()).toHaveLength(1)
  })

  it('treats a busy device as a per-OID problem, not a failed poll', async () => {
    const client = new FakeRouter(defaultResponses(), {
      DEV2_HOST_ENTRY: new RouterBusyError('DEV2_HOST_ENTRY'),
    })
    const { db, poller } = makePoller(client, () => 1_000)

    const summary = await poller.poll()
    expect(summary.warnings[0]).toContain('406')
    expect(db.select().from(routerLineSample).all()).toHaveLength(1)
  })

  it('abandons the poll when the router cannot be reached, rather than recording absences', async () => {
    // The failure mode this guards: eight reads each failing individually would
    // otherwise "succeed" as a poll that wrote nothing, which reads like a
    // healthy router with nothing to say.
    const client = new FakeRouter(defaultResponses(), {
      DEV2_FAST_LINE: new RouterUnreachableError('connect timeout'),
    })
    const { db, poller } = makePoller(client, () => 1_000)

    await expect(poller.poll()).rejects.toThrow(RouterUnreachableError)
    expect(client.calls).toHaveLength(1)
    expect(db.select().from(routerEthPort).all()).toHaveLength(0)
  })

  it('writes nothing at all when the session is lost mid-poll', async () => {
    const client = new FakeRouter(defaultResponses(), {
      DEV2_ADT_WAN: new RouterSessionLostError('socket closed'),
    })
    const { db, poller } = makePoller(client, () => 1_000)

    await expect(poller.poll()).rejects.toThrow(RouterSessionLostError)
    expect(db.select().from(routerLineSample).all()).toHaveLength(0)
    expect(db.select().from(routerIntfSample).all()).toHaveLength(0)
  })

  it('records a resync when showtime seconds go backwards between polls', async () => {
    const client = new FakeRouter()
    let now = 1_000
    const { db, poller } = makePoller(client, () => now)

    await poller.poll()
    client.replace('DEV2_DSL_LINE_STATS', [{ ...DSL_LINE_STATS_ROW, showtimeStart: '17' }])
    now = 301_000
    const summary = await poller.poll()

    expect(summary.resync).toBe(true)
    const events = db.select().from(event).all()
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.detail)).toMatchObject({
      source: 'router-poller',
      reason: 'line_resync',
      showtimeStartS: 17,
      previousShowtimeStartS: 3589,
    })
  })

  it('records a host/router disagreement once, then its resolution once', async () => {
    const client = new FakeRouter()
    let now = 1_000
    const { db, poller } = makePoller(client, () => now)

    // The host reports the link it negotiated; the router reports 1000/Full.
    writeHostVantage(db, now, { linkMbit: 100, linkMedia: '100baseTX' })
    await poller.poll()
    now = 60_000
    writeHostVantage(db, now, { linkMbit: 100, linkMedia: '100baseTX' })
    await poller.poll()

    let events = db.select().from(event).all()
    expect(events).toHaveLength(1)
    const detail = JSON.parse(events[0]!.detail) as { reason: string; disagreements: unknown[] }
    expect(detail.reason).toBe('vantage_disagreement')
    expect(detail.disagreements).toEqual([
      { field: 'link_speed', host: '100 Mbit', router: '1000 Mbit on LAN1' },
    ])

    now = 120_000
    writeHostVantage(db, now)
    await poller.poll()

    events = db.select().from(event).all()
    expect(events).toHaveLength(2)
    expect(JSON.parse(events[1]!.detail)).toMatchObject({ reason: 'vantage_agreement_restored' })
  })

  it('does not compare against a host vantage older than one poll interval', async () => {
    const client = new FakeRouter()
    const now = 10 * 60 * 1000
    const { db, poller } = makePoller(client, () => now)
    // A collector that stopped 9 minutes ago: comparing a live router reading
    // against a dead host reading would invent a disagreement.
    writeHostVantage(db, now - 9 * 60 * 1000, { linkMbit: 100 })

    const summary = await poller.poll()
    expect(summary.disagreements).toEqual([])
    expect(db.select().from(event).all()).toHaveLength(0)
  })

  it('stays quiet when the host already knows it was not on the home line', async () => {
    const client = new FakeRouter()
    const { db, poller } = makePoller(client, () => 1_000)
    writeHostVantage(db, 1_000, {
      pathIf: 'en11',
      pathClass: 'cellular',
      linkMbit: null,
      linkDuplex: null,
      gatewayAddr: '192.168.12.1',
      onHomeLine: 0,
    })

    const summary = await poller.poll()
    expect(summary.disagreements).toEqual([])
    expect(db.select().from(event).all()).toHaveLength(0)
  })
})

describe('readRouterSnapshot', () => {
  const COLLECTOR_IP = '192.168.1.100'
  /** Two 5-minute poll intervals, i.e. `routerConfig.staleAfterMs` in production. */
  const STALE_AFTER_MS = 10 * 60 * 1000

  /**
   * The WAN outage as the router actually reports it: every `DEV2_ADT_WAN`
   * instance disconnected, so `parseLiveWan` finds no live connection and no
   * interface can be given the `wan` role. `DEV2_IP_INTF_STATS` still answers
   * for the LAN bridge, so the LAN half of the record keeps advancing while the
   * WAN half stops — the exact divergence that made a 15-minute-old throughput
   * figure read as current.
   */
  function wanDownRows(): Array<Record<string, string>> {
    return ADT_WAN_ROWS.map((row) => ({ ...row, connStatusV4: 'Disconnected', connStatusV6: 'Disconnected' }))
  }

  it('is empty, not zero, before the first poll', () => {
    const db = createTestDb()
    const snapshot = readRouterSnapshot(db, { collectorHostIp: COLLECTOR_IP, staleAfterMs: STALE_AFTER_MS, now: 1_000 })
    expect(snapshot.line).toBeNull()
    expect(snapshot.wan).toBeNull()
    expect(snapshot.lan).toBeNull()
    expect(snapshot.collector).toBeNull()
    expect(snapshot.ports).toBeNull()
  })

  it('serves a fresh poll as current', async () => {
    const now = 1_000_000
    const { db, poller } = makePoller(new FakeRouter(), () => now)
    await poller.poll()

    const snapshot = readRouterSnapshot(db, { collectorHostIp: COLLECTOR_IP, staleAfterMs: STALE_AFTER_MS, now })
    expect(snapshot.wan).toMatchObject({ observedAt: now, ageMs: 0, stale: false })
    expect(snapshot.wan?.value.name).toBe('ppp0')
    expect(snapshot.lan).toMatchObject({ ageMs: 0, stale: false })
    expect(snapshot.line).toMatchObject({ ageMs: 0, stale: false })
    expect(snapshot.ports).toMatchObject({ ageMs: 0, stale: false })
    expect(snapshot.ports?.value).toHaveLength(3)
    expect(snapshot.collector?.value.ip).toBe(COLLECTOR_IP)
  })

  it('marks the WAN reading stale through an outage while the LAN half stays current', async () => {
    const client = new FakeRouter()
    let now = 1_000_000
    const { db, poller } = makePoller(client, () => now)

    // One healthy poll, then the line goes down and three more polls land.
    await poller.poll()
    client.replace('DEV2_ADT_WAN', wanDownRows())
    for (const minutes of [5, 10, 15]) {
      now = 1_000_000 + minutes * 60_000
      const summary = await poller.poll()
      // Reproduces the reported symptom: no WAN row is written at all.
      expect(summary.wanIfName).toBeNull()
      expect(summary.wanRxKbps).toBeNull()
      expect(summary.intfRows).toBe(1)
    }

    const snapshot = readRouterSnapshot(db, { collectorHostIp: COLLECTOR_IP, staleAfterMs: STALE_AFTER_MS, now })

    // The WAN number is still served — "last seen 15 minutes ago" is the
    // finding — but it can no longer be mistaken for a current reading.
    expect(snapshot.wan?.observedAt).toBe(1_000_000)
    expect(snapshot.wan?.ageMs).toBe(15 * 60_000)
    expect(snapshot.wan?.stale).toBe(true)

    // Everything the router did answer for is current, and says so.
    expect(snapshot.lan?.ageMs).toBe(0)
    expect(snapshot.lan?.stale).toBe(false)
    expect(snapshot.line?.stale).toBe(false)
    expect(snapshot.ports?.stale).toBe(false)
    expect(snapshot.now).toBe(now)
    expect(snapshot.staleAfterMs).toBe(STALE_AFTER_MS)
  })

  it('does not call a value stale until it is older than the bound', async () => {
    const now = 1_000_000
    const { db, poller } = makePoller(new FakeRouter(), () => now)
    await poller.poll()

    const atBound = readRouterSnapshot(db, {
      collectorHostIp: COLLECTOR_IP,
      staleAfterMs: STALE_AFTER_MS,
      now: now + STALE_AFTER_MS,
    })
    expect(atBound.wan?.stale).toBe(false)

    const pastBound = readRouterSnapshot(db, {
      collectorHostIp: COLLECTOR_IP,
      staleAfterMs: STALE_AFTER_MS,
      now: now + STALE_AFTER_MS + 1,
    })
    expect(pastBound.wan?.stale).toBe(true)
  })
})

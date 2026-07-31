import { describe, expect, test } from 'bun:test'
import { createTestDb } from '../db/test-db.js'
import { event, probeCycle } from '../db/schema.js'
import { type CycleVantage, type LinkChangeDetail, recordCycleVantage, resolveOnHomeLine } from './cycle-vantage.js'

const HOME_GW = '192.168.1.1'
const T0 = 1_000_000
const CYCLE_MS = 30_000

const ETHERNET: CycleVantage = {
  pathIf: 'en0',
  pathClass: 'ethernet',
  linkMedia: '1000baseT',
  linkMbit: 1000,
  linkDuplex: 'full',
  gatewayAddr: HOME_GW,
  ifIerrs: 0,
  ifOerrs: 0,
  ifColl: 0,
}

function events(db: ReturnType<typeof createTestDb>) {
  return db
    .select()
    .from(event)
    .all()
    .map((row) => ({ ts: row.ts, kind: row.kind, detail: JSON.parse(row.detail) as LinkChangeDetail }))
}

describe('resolveOnHomeLine', () => {
  test('Ethernet through the configured gateway is the home line', () => {
    expect(resolveOnHomeLine(ETHERNET, HOME_GW)).toBe(true)
  })

  test('Wi-Fi through the same gateway is NOT the home line', () => {
    expect(resolveOnHomeLine({ ...ETHERNET, pathClass: 'wifi', pathIf: 'en1' }, HOME_GW)).toBe(false)
  })

  test('cellular failover is not the home line — the case the whole column exists for', () => {
    // en11 is the LTE hotspot, en10 is iPhone USB tethering. Both are ahead of
    // Wi-Fi in the service order, so either can carry the default route silently.
    expect(resolveOnHomeLine({ pathClass: 'cellular', pathIf: 'en11', gatewayAddr: '192.168.2.1' }, HOME_GW)).toBe(false)
    expect(resolveOnHomeLine({ pathClass: 'cellular', pathIf: 'en10', gatewayAddr: '172.20.10.1' }, HOME_GW)).toBe(false)
  })

  test('Ethernet through an unexpected gateway is not the home line', () => {
    expect(resolveOnHomeLine({ ...ETHERNET, gatewayAddr: '10.0.0.1' }, HOME_GW)).toBe(false)
  })

  test('an unreported vantage is unknown, never true', () => {
    expect(resolveOnHomeLine({}, HOME_GW)).toBeNull()
    // Facts present but incomplete: a gateway with no class cannot prove Ethernet.
    expect(resolveOnHomeLine({ gatewayAddr: HOME_GW }, HOME_GW)).toBeNull()
    // Ethernet with no gateway is unknown, not false: a default route can
    // legitimately carry none (PPPoE, a VPN owning the route), and scoring it
    // false would throw away the real home line.
    expect(resolveOnHomeLine({ pathClass: 'ethernet' }, HOME_GW)).toBeNull()
  })

  test('a collector verdict alone cannot assert the home line, but can deny it', () => {
    // Asymmetric on purpose. "Which gateway is home" is server configuration,
    // so a bare `1` with nothing to check it against is unknown — the hole that
    // let a cellular cycle with no gateway be stored as the home line.
    expect(resolveOnHomeLine({ onHomeLine: true }, HOME_GW)).toBeNull()
    // A `0` needs no corroboration: it is disqualifying evidence.
    expect(resolveOnHomeLine({ onHomeLine: false }, HOME_GW)).toBe(false)
  })

  test('disagreement resolves to false — either party saying "not the home line" disqualifies the cycle', () => {
    expect(resolveOnHomeLine({ ...ETHERNET, onHomeLine: false }, HOME_GW)).toBe(false)
    expect(resolveOnHomeLine({ ...ETHERNET, pathClass: 'wifi', onHomeLine: true }, HOME_GW)).toBe(false)
  })

  // The regression that shipped: requiring *both* pathClass and gatewayAddr
  // before deriving anything meant a cycle that reported only a disqualifying
  // path class fell through to the collector's own claim. A cellular cycle with
  // no gateway was stored as the home line — reproduced against a live server.
  describe('a missing gateway never rescues a disqualified path', () => {
    test('cellular with a null gateway and a collector `1` is NOT the home line', () => {
      expect(resolveOnHomeLine({ pathIf: 'en11', pathClass: 'cellular', gatewayAddr: null, onHomeLine: 1 }, HOME_GW)).toBe(false)
    })

    test('Wi-Fi with a null gateway and a collector `1` is NOT the home line', () => {
      expect(resolveOnHomeLine({ pathIf: 'en1', pathClass: 'wifi', gatewayAddr: null, onHomeLine: 1 }, HOME_GW)).toBe(false)
    })

    test('any known non-Ethernet class is false with no gateway reported at all', () => {
      expect(resolveOnHomeLine({ pathClass: 'cellular' }, HOME_GW)).toBe(false)
      expect(resolveOnHomeLine({ pathClass: 'wifi' }, HOME_GW)).toBe(false)
      expect(resolveOnHomeLine({ pathClass: 'other' }, HOME_GW)).toBe(false)
    })

    test('a foreign gateway is false even when the path class is unknown', () => {
      expect(resolveOnHomeLine({ gatewayAddr: '10.0.0.1', onHomeLine: 1 }, HOME_GW)).toBe(false)
    })

    test('the three states are each reachable', () => {
      expect(resolveOnHomeLine(ETHERNET, HOME_GW)).toBe(true)
      expect(resolveOnHomeLine({ ...ETHERNET, pathClass: 'cellular' }, HOME_GW)).toBe(false)
      expect(resolveOnHomeLine({}, HOME_GW)).toBeNull()
    })
  })
})

describe('recordCycleVantage', () => {
  test('persists the vantage and stores on_home_line as 1', () => {
    const db = createTestDb()
    const result = recordCycleVantage(db, { ts: T0, vantage: ETHERNET, homeGatewayAddr: HOME_GW })

    expect(result.inserted).toBe(true)
    const rows = db.select().from(probeCycle).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ts).toBe(T0)
    expect(rows[0]?.pathIf).toBe('en0')
    expect(rows[0]?.linkMbit).toBe(1000)
    expect(rows[0]?.onHomeLine).toBe(1)
  })

  test('a cellular cycle with no gateway stores on_home_line 0, even when the collector claimed 1', () => {
    const db = createTestDb()
    recordCycleVantage(db, {
      ts: T0,
      vantage: { pathIf: 'en11', pathClass: 'cellular', gatewayAddr: null, onHomeLine: 1 },
      homeGatewayAddr: HOME_GW,
    })

    expect(db.select().from(probeCycle).all()[0]?.onHomeLine).toBe(0)
  })

  test('an unreported vantage stores null on_home_line, not 0 and not 1', () => {
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: {}, homeGatewayAddr: HOME_GW })

    expect(db.select().from(probeCycle).all()[0]?.onHomeLine).toBeNull()
  })

  test('the first cycle ever recorded emits no link_change', () => {
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: ETHERNET, homeGatewayAddr: HOME_GW })

    expect(events(db)).toHaveLength(0)
  })

  test('an unchanged cycle emits no link_change', () => {
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: ETHERNET, homeGatewayAddr: HOME_GW })
    recordCycleVantage(db, { ts: T0 + CYCLE_MS, vantage: ETHERNET, homeGatewayAddr: HOME_GW })

    expect(events(db)).toHaveLength(0)
  })

  test('a renegotiated link speed emits a link_change carrying before and after', () => {
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: ETHERNET, homeGatewayAddr: HOME_GW })
    const result = recordCycleVantage(db, {
      ts: T0 + CYCLE_MS,
      vantage: { ...ETHERNET, linkMedia: '100baseTX', linkMbit: 100 },
      homeGatewayAddr: HOME_GW,
    })

    expect(result.linkChangeEventId).not.toBeNull()
    const rows = events(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('link_change')
    expect(rows[0]?.ts).toBe(T0 + CYCLE_MS)
    expect(rows[0]?.detail.changed).toEqual({ linkMbit: { before: 1000, after: 100 } })
  })

  test('a failover to cellular reports every changed field at once', () => {
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: ETHERNET, homeGatewayAddr: HOME_GW })
    recordCycleVantage(db, {
      ts: T0 + CYCLE_MS,
      vantage: { pathIf: 'en11', pathClass: 'cellular', linkMbit: 300, linkDuplex: 'full', gatewayAddr: '192.168.2.1' },
      homeGatewayAddr: HOME_GW,
    })

    const [row] = events(db)
    expect(row?.detail.changed).toEqual({
      pathIf: { before: 'en0', after: 'en11' },
      pathClass: { before: 'ethernet', after: 'cellular' },
      linkMbit: { before: 1000, after: 300 },
    })
    // The vantage itself is what makes the failover legible, not just the event.
    expect(db.select().from(probeCycle).all()[1]?.onHomeLine).toBe(0)
  })

  test('a half-duplex renegotiation is a link change', () => {
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: ETHERNET, homeGatewayAddr: HOME_GW })
    recordCycleVantage(db, { ts: T0 + CYCLE_MS, vantage: { ...ETHERNET, linkDuplex: 'half' }, homeGatewayAddr: HOME_GW })

    expect(events(db)[0]?.detail.changed).toEqual({ linkDuplex: { before: 'full', after: 'half' } })
  })

  test('null -> value is a collector upgrade, not a link change', () => {
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: {}, homeGatewayAddr: HOME_GW })
    recordCycleVantage(db, { ts: T0 + CYCLE_MS, vantage: ETHERNET, homeGatewayAddr: HOME_GW })

    expect(events(db)).toHaveLength(0)
  })

  test('a changed NIC ceiling is a link change — different hardware in the path', () => {
    // linkMaxMbit reframes every linkMbit reading after it: 100 negotiated on a
    // NIC that supports 1000 is a cable, on a NIC that supports 100 it is the
    // adapter. So the ceiling moving is itself a transition worth an event.
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: { ...ETHERNET, linkMaxMbit: 1000 }, homeGatewayAddr: HOME_GW })
    recordCycleVantage(db, { ts: T0 + CYCLE_MS, vantage: { ...ETHERNET, linkMaxMbit: 2500 }, homeGatewayAddr: HOME_GW })

    expect(events(db)[0]?.detail.changed).toEqual({ linkMaxMbit: { before: 1000, after: 2500 } })
  })

  test('null -> 1000 on linkMaxMbit is the collector gaining the field, not a NIC swap', () => {
    // The collector is native under launchd and the API is in Docker, so the
    // day the collector starts reporting the ceiling every host would otherwise
    // emit a fabricated "the NIC changed" event on its very next cycle.
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: ETHERNET, homeGatewayAddr: HOME_GW })
    recordCycleVantage(db, { ts: T0 + CYCLE_MS, vantage: { ...ETHERNET, linkMaxMbit: 1000 }, homeGatewayAddr: HOME_GW })

    expect(events(db)).toHaveLength(0)
    expect(db.select().from(probeCycle).all()[1]?.linkMaxMbit).toBe(1000)
  })

  test('a moved DHCP lease and a changed link_watch_s emit no event', () => {
    // Deliberately unwatched. dhcpBoundAt moves on every ordinary lease renewal
    // and linkWatchS is a per-cycle coverage counter; an event on either would
    // fire constantly and bury the real transitions. Both are still stored.
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: { ...ETHERNET, dhcpBoundAt: T0 - 3600_000, linkWatchS: 30 }, homeGatewayAddr: HOME_GW })
    recordCycleVantage(db, { ts: T0 + CYCLE_MS, vantage: { ...ETHERNET, dhcpBoundAt: T0, linkWatchS: 12 }, homeGatewayAddr: HOME_GW })

    expect(events(db)).toHaveLength(0)
    const rows = db.select().from(probeCycle).all()
    expect(rows[1]?.dhcpBoundAt).toBe(T0)
    expect(rows[1]?.linkWatchS).toBe(12)
  })

  test('an unreported link_watch_s stores null, never 0', () => {
    // 0 is a measurement — "the sampler ran and covered no seconds". Null is
    // the absence of one, and the verdict layer must refuse rather than assume.
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: ETHERNET, homeGatewayAddr: HOME_GW })

    const row = db.select().from(probeCycle).all()[0]
    expect(row?.linkWatchS).toBeNull()
    expect(row?.linkMaxMbit).toBeNull()
    expect(row?.dhcpBoundAt).toBeNull()
  })

  test('value -> null is the collector going quiet, not a link change', () => {
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: ETHERNET, homeGatewayAddr: HOME_GW })
    recordCycleVantage(db, { ts: T0 + CYCLE_MS, vantage: {}, homeGatewayAddr: HOME_GW })

    expect(events(db)).toHaveLength(0)
  })

  test('a replayed cycle is a no-op: no duplicate row, no duplicate event', () => {
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: ETHERNET, homeGatewayAddr: HOME_GW })
    recordCycleVantage(db, { ts: T0 + CYCLE_MS, vantage: { ...ETHERNET, linkMbit: 100 }, homeGatewayAddr: HOME_GW })

    // The spool replays the whole batch verbatim.
    const replay = recordCycleVantage(db, { ts: T0 + CYCLE_MS, vantage: { ...ETHERNET, linkMbit: 100 }, homeGatewayAddr: HOME_GW })

    expect(replay.inserted).toBe(false)
    expect(replay.linkChangeEventId).toBeNull()
    expect(db.select().from(probeCycle).all()).toHaveLength(2)
    expect(events(db)).toHaveLength(1)
  })

  test('an out-of-order replay is diffed against its own predecessor, not the newest cycle', () => {
    const db = createTestDb()
    recordCycleVantage(db, { ts: T0, vantage: ETHERNET, homeGatewayAddr: HOME_GW })
    recordCycleVantage(db, { ts: T0 + 2 * CYCLE_MS, vantage: { ...ETHERNET, linkMbit: 100 }, homeGatewayAddr: HOME_GW })
    expect(events(db)).toHaveLength(1)

    // A spooled cycle from between the two arrives late, still at 1000 Mbit: its
    // predecessor is T0, which was also 1000, so it changed nothing.
    recordCycleVantage(db, { ts: T0 + CYCLE_MS, vantage: ETHERNET, homeGatewayAddr: HOME_GW })

    expect(events(db)).toHaveLength(1)
    expect(db.select().from(probeCycle).all()).toHaveLength(3)
  })
})

describe('resolveOnHomeLine — wire spellings', () => {
  // collector/vantage.ts sends 0/1, mirroring the SQLite column. Rejecting that
  // spelling would 400 the whole batch and lose four real probe samples.
  test('accepts the collector 0/1 spelling as well as booleans', () => {
    // 0 must not be swallowed by a `?? null` and read as "unknown".
    expect(resolveOnHomeLine({ onHomeLine: 0 }, HOME_GW)).toBe(false)
    expect(resolveOnHomeLine({ onHomeLine: 0 }, HOME_GW)).not.toBeNull()
    expect(resolveOnHomeLine({ ...ETHERNET, onHomeLine: 0 }, HOME_GW)).toBe(false)
    expect(resolveOnHomeLine({ ...ETHERNET, onHomeLine: 1 }, HOME_GW)).toBe(true)
    expect(resolveOnHomeLine({ ...ETHERNET, onHomeLine: true }, HOME_GW)).toBe(true)
  })
})

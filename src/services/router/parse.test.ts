import { describe, expect, it } from 'bun:test'
import {
  ADT_WAN_ROWS,
  DSL_LINE_STATS_ROW,
  ETH_INTF_ROWS,
  FAST_LINE_ROW,
  HOSTS_ROW,
  HOST_ENTRY_ROWS,
  HOST_NAME_CANARY,
  IP_INTF_ROWS,
  IP_INTF_STATS_ROWS,
} from './fixtures.js'
import {
  checkListLength,
  parseEthPorts,
  parseHostCount,
  parseHosts,
  parseIntfSamples,
  parseLineSample,
  parseLiveWan,
  resolveHostPort,
} from './parse.js'
import { redactRow } from './redact.js'

// Fixtures go through the redactor first, exactly as a live response does.
const fastLine = redactRow(FAST_LINE_ROW)
const lineStats = redactRow(DSL_LINE_STATS_ROW)
const adtWan = ADT_WAN_ROWS.map(redactRow)
const ipIntf = IP_INTF_ROWS.map(redactRow)
const ipIntfStats = IP_INTF_STATS_ROWS.map(redactRow)
const ethIntf = ETH_INTF_ROWS.map(redactRow)
const hostEntry = HOST_ENTRY_ROWS.map(redactRow)

describe('parseLineSample', () => {
  it('reads carrier health from DEV2_FAST_LINE and showtime from DEV2_DSL_LINE_STATS', () => {
    const line = parseLineSample({ fastLine, lineStats })
    expect(line.carrier).toBe('gfast')
    expect(line.status).toBe('Up')
    expect(line.downSyncKbps).toBe(803140)
    expect(line.upSyncKbps).toBe(225452)
    expect(line.showtimeStartS).toBe(3589)
  })

  it('converts tenths of a dB into real dB', () => {
    const line = parseLineSample({ fastLine, lineStats })
    expect(line.downNoiseMarginDb).toBe(6.1)
    expect(line.upNoiseMarginDb).toBe(5.6)
    expect(line.downAttenuationDb).toBe(8.5)
  })

  it('takes the current rate from DEV2_FAST_LINE, not the same-named DSL field', () => {
    const line = parseLineSample({ fastLine, lineStats })
    // 804707 on FAST_LINE (a line rate) vs 3641 on DSL_LINE_STATS. Same name,
    // three orders of magnitude apart.
    expect(line.downCurrKbps).toBe(804707)
    expect(line.upCurrKbps).toBe(226413)
  })

  it('leaves error counters null rather than claiming a measured zero', () => {
    const line = parseLineSample({ fastLine, lineStats })
    expect(line.erroredSecs).toBeNull()
    expect(line.severelyErroredSecs).toBeNull()
    // This firmware exposes `allowedProfiles` but not the active profile.
    expect(line.profile).toBeNull()
  })

  it('survives either OID being missing', () => {
    expect(parseLineSample({ fastLine: undefined, lineStats }).showtimeStartS).toBe(3589)
    expect(parseLineSample({ fastLine: undefined, lineStats }).carrier).toBeNull()
    expect(parseLineSample({ fastLine, lineStats: undefined }).status).toBe('Up')
  })
})

describe('parseLiveWan', () => {
  it('selects the live connection by status, not by index', () => {
    const wan = parseLiveWan(adtWan)
    expect(wan?.ifName).toBe('ppp0')
    // Index 0 is the first instance and is disconnected; picking by position
    // would have chosen it.
    expect(wan?.connStatusV4).toBe('Connecting')
  })

  it('accepts `Connecting` — the steady state of this DS-Lite line', () => {
    const wan = parseLiveWan(adtWan)
    expect(wan?.connStatusV6).toBe('Connected')
  })

  it('returns null when nothing is connected and there is nothing to carry forward', () => {
    const allDown = adtWan.map((row) => ({ ...row, connStatusV4: 'Disconnected', connStatusV6: 'Disconnected' }))
    expect(parseLiveWan(allDown)).toBeNull()
  })

  it('takes the connection stack, which is not the interface stack', () => {
    // The trap: DEV2_IP_INTF's ppp0 is stack 4, this connection is stack 3.
    // Anything addressing the connection needs this one.
    expect(parseLiveWan(adtWan)?.stack).toBe('3,0,0,0,0,0')
  })

  it('reads the DS-Lite state and both session uptimes', () => {
    const wan = parseLiveWan(adtWan)
    expect(wan).toMatchObject({
      connType: 'PPPoE',
      accessMode: 'VDSL',
      dsliteEnabled: 1,
      // The v4 stack is disabled, so its uptime is pinned at 0 and its status
      // reads Connecting forever. Preserved as measured, not normalised away —
      // a consumer that reads 0 as "just came up" is the bug this documents.
      connIpv4Enabled: 0,
      uptimeV4S: 0,
      connIpv6Enabled: 1,
      uptimeV6S: 4761,
      lastConnError: 'ERROR_NONE',
      selectedBy: 'status',
    })
  })

  /**
   * The failure the fallback exists for. With every instance disconnected,
   * status-based selection yields nothing — so no WAN row is written, no
   * interface is given the `wan` role, and `ppp0`'s byte counters stop being
   * recorded at exactly the moment they diagnose the fault. Those counters
   * resetting to zero are what identified the 2026-08-01 incident.
   */
  it('carries the previous connection forward when the router disconnects them all', () => {
    const allDown = adtWan.map((row) => ({ ...row, connStatusV4: 'Disconnected', connStatusV6: 'Disconnected' }))
    const wan = parseLiveWan(allDown, { previousName: 'ipoe_ptm_0_0_d' })
    expect(wan?.ifName).toBe('ppp0')
    expect(wan?.connStatusV4).toBe('Disconnected')
    // And says so, so nothing reads as a connection the router vouched for.
    expect(wan?.selectedBy).toBe('continuity')
  })

  it('does not carry forward a name the router no longer lists', () => {
    expect(parseLiveWan([], { previousName: 'ipoe_ptm_0_0_d' })).toBeNull()
  })

  it('prefers a live connection over the remembered one', () => {
    const wan = parseLiveWan(adtWan, { previousName: 'pppoe_40_2' })
    expect(wan?.name).toBe('ipoe_ptm_0_0_d')
    expect(wan?.selectedBy).toBe('status')
  })
})

describe('parseIntfSamples', () => {
  it('joins rates to names by stack and resolves the role by name', () => {
    const samples = parseIntfSamples({ intf: ipIntf, stats: ipIntfStats, wanIfName: 'ppp0' })
    const wan = samples.find((s) => s.name === 'ppp0')
    const lan = samples.find((s) => s.name === 'br0')
    expect(wan).toEqual({
      name: 'ppp0',
      stack: 4,
      role: 'wan',
      rxKbps: 436,
      txKbps: 1823,
      bytesRx: 1680923801,
      bytesTx: 1073813360,
    })
    expect(lan?.role).toBe('lan')
    expect(lan?.rxKbps).toBe(1814)
  })

  it('drops interfaces the firmware reports without a name', () => {
    const samples = parseIntfSamples({ intf: ipIntf, stats: ipIntfStats, wanIfName: 'ppp0' })
    expect(samples).toHaveLength(2)
  })

  it('marks the WAN `other` when the live connection could not be resolved', () => {
    const samples = parseIntfSamples({ intf: ipIntf, stats: ipIntfStats, wanIfName: null })
    expect(samples.find((s) => s.name === 'ppp0')?.role).toBe('other')
    // The LAN bridge still resolves — the router labels it itself.
    expect(samples.find((s) => s.name === 'br0')?.role).toBe('lan')
  })
})

describe('parseEthPorts and resolveHostPort', () => {
  it('reads the negotiated link per port', () => {
    const ports = parseEthPorts(ethIntf)
    expect(ports[0]).toEqual({
      name: 'eth0',
      alias: 'LAN1',
      status: 'Up',
      maxBitRate: 1000,
      duplexMode: 'Full',
      stack: 1,
    })
  })

  it("follows the host's own layer1Interface pointer instead of guessing a port", () => {
    const ports = parseEthPorts(ethIntf)
    const hosts = parseHosts(hostEntry)
    const port = resolveHostPort({ host: hosts[0], ports })
    // LAN1 (1000) and LAN2 (100) are both Up: "the first port that is up" would
    // have been right by luck here and wrong for any host on LAN2.
    expect(port?.alias).toBe('LAN1')
    expect(port?.maxBitRate).toBe(1000)
  })

  it('resolves nothing for a host that is not on an ethernet port', () => {
    const ports = parseEthPorts(ethIntf)
    const hosts = parseHosts(hostEntry)
    expect(resolveHostPort({ host: hosts[1], ports })).toBeNull()
    expect(resolveHostPort({ host: undefined, ports })).toBeNull()
  })
})

describe('parseHosts', () => {
  it('reads address, attachment and activity', () => {
    const hosts = parseHosts(hostEntry)
    expect(hosts[0]).toEqual({
      ip: '192.168.1.100',
      interfaceType: 'Ethernet',
      active: 1,
      clientType: 'Other',
      layer1Interface: 'Device.Ethernet.Interface.1.',
    })
    expect(hosts[2]?.active).toBe(0)
  })

  // The device name is the one field on this OID that must not survive parsing:
  // this router's vendor defaults are a MAC with the separators stripped, and
  // the column that used to hold them is gone. The raw rows still carry it under
  // two spellings, so the assertion is against the whole parsed object.
  it('carries no device name out of a row that has one', () => {
    // Against the raw rows, not the redacted ones: the parser has to drop the
    // name on its own rather than inherit the redactor's blanking.
    expect(JSON.stringify(HOST_ENTRY_ROWS)).toContain(HOST_NAME_CANARY)
    const hosts = parseHosts(HOST_ENTRY_ROWS)
    expect(JSON.stringify(hosts)).not.toContain(HOST_NAME_CANARY)
    for (const host of hosts) {
      expect(Object.keys(host).some((key) => /name/i.test(key))).toBe(false)
    }
  })
})

describe('checkListLength', () => {
  it('accepts a list that matches the firmware count', () => {
    expect(
      checkListLength({
        oid: 'DEV2_HOST_ENTRY',
        rows: parseHosts(hostEntry),
        expected: parseHostCount([redactRow(HOSTS_ROW)]),
      }),
    ).toBeNull()
  })

  it('names the silent-truncation shape when a list comes back with one row', () => {
    const message = checkListLength({ oid: 'DEV2_HOST_ENTRY', rows: [{}], expected: 8 })
    expect(message).toContain('returned 1 instances')
    expect(message).toContain('the "go" truncation shape')
  })

  it('says nothing when the firmware offers no count to check against', () => {
    expect(checkListLength({ oid: 'DEV2_ETH_INTF', rows: [{}], expected: null })).toBeNull()
  })
})

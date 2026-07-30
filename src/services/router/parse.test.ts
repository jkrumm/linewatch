import { describe, expect, it } from 'bun:test'
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

  it('returns null when nothing is connected', () => {
    const allDown = adtWan.map((row) => ({ ...row, connStatusV4: 'Disconnected', connStatusV6: 'Disconnected' }))
    expect(parseLiveWan(allDown)).toBeNull()
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
      hostName: 'fixture-host',
      layer1Interface: 'Device.Ethernet.Interface.1.',
    })
    expect(hosts[2]?.active).toBe(0)
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

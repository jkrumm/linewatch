import { describe, expect, it } from 'bun:test'
import { ADT_WAN_ROWS, ETH_INTF_ROWS, HOST_ENTRY_ROWS, HOST_NAME_CANARY } from './fixtures.js'
import { redactRow, redactValue } from './redact.js'

const PPPOE_CONNECTION = ADT_WAN_ROWS[1]!

describe('redactValue', () => {
  it('redacts credentials, identities and serials by key', () => {
    expect(redactValue('PPPPassword', 'hunter2')).toBe('<redacted:secret>')
    expect(redactValue('serialNumber', 'ABC123')).toBe('<redacted:secret>')
    expect(redactValue('X_TP_SerialNumber', 'ABC123')).toBe('<redacted:secret>')
    expect(redactValue('PPPUserName', 'someone@isp')).toBe('<redacted:identity>')
    expect(redactValue('customConnName', 'Some ISP Product')).toBe('<redacted:identity>')
    expect(redactValue('X_TP_DsliteAftrServer', 'aftr.isp.example')).toBe('<redacted:identity>')
  })

  /**
   * A device name is an identity too, and on this router it is often literally a
   * MAC: the vendor default is a three-letter prefix plus the 12 hex digits of
   * the address, which the MAC pattern below cannot match because it requires
   * separators. `router_host` therefore stores no name at all; this keeps a raw
   * row from carrying one into a log.
   */
  it('redacts device names under either spelling, including the MAC-shaped default', () => {
    expect(redactValue('hostName', 'ABC001122334455')).toBe('<redacted:identity>')
    expect(redactValue('X_TP_HostName', 'ABC001122334455')).toBe('<redacted:identity>')
    expect(redactValue('deviceName', 'anything')).toBe('<redacted:identity>')
    expect(redactValue('X_TP_NickName', 'anything')).toBe('<redacted:identity>')
  })

  it('keeps the fields the poller actually reads', () => {
    for (const [key, value] of [
      ['status', 'Up'],
      ['name', 'ppp0'],
      ['ifName', 'ppp0'],
      ['interfaceType', 'Ethernet'],
      ['hostNumberOfEntries', '3'],
      ['X_TP_IfNameAlias', 'LAN1'],
      ['maxBitRate', '1000'],
      ['duplexMode', 'Full'],
      ['downstreamNoiseMargin', '61'],
      ['X_TP_RxThroughput', '1814'],
      ['connStatusV4', 'Connecting'],
    ] as const) {
      expect(redactValue(key, value)).toBe(value)
    }
  })

  it('keeps private addresses and drops public ones', () => {
    expect(redactValue('IPAddress', '192.168.1.100')).toBe('192.168.1.100')
    expect(redactValue('connIPv4Gateway', '10.0.0.1')).toBe('10.0.0.1')
    expect(redactValue('connIPv4Address', '203.0.113.7')).toBe('<redacted:public-ip>')
    expect(redactValue('connIPv6Address', '2001:db8:1234::1')).toBe('<redacted:public-ip>')
    expect(redactValue('connIPv6Prefix', '2001:db8:1234::/56')).toBe('<redacted:public-ip>')
    expect(redactValue('connIPv6Gateway', 'fe80::5a00:bbff:fe09:f9fa')).toBe(
      'fe80::5a00:bbff:fe09:f9fa',
    )
  })

  it('keeps the OUI of a MAC and drops the device-unique half', () => {
    expect(redactValue('MACAddress', 'AC:A7:F1:0A:0B:0C')).toBe('AC:A7:F1:XX:XX:XX')
  })

  it('drops nested values rather than flattening a secret out of one', () => {
    expect(redactValue('whatever', { PPPPassword: 'hunter2' })).toBe('<dropped:nested>')
  })
})

describe('redactRow', () => {
  /**
   * The canary. A previous grep-based sweep of this device's output returned a
   * false all-clear, so the test first proves the assertion *can* fail: the
   * fixture really does contain the credential, and the raw row really is
   * detectable by the same search that is then run against the redacted row.
   */
  it('removes a credential that is provably present in the input', () => {
    const canary = 'FIXTURE-CANARY-NOT-A-REAL-PASSWORD'
    expect(JSON.stringify(PPPOE_CONNECTION)).toContain(canary)

    const redacted = redactRow(PPPOE_CONNECTION)
    expect(JSON.stringify(redacted)).not.toContain(canary)
    expect(redacted['PPPPassword']).toBe('<redacted:secret>')
    expect(redacted['PPPUserName']).toBe('<redacted:identity>')
    expect(redacted['serialNumber']).toBe('<redacted:secret>')
    expect(redacted['connIPv6Address']).toBe('<redacted:public-ip>')
    expect(redacted['customConnName']).toBe('<redacted:identity>')
  })

  it('leaves the live-WAN selection fields intact', () => {
    const redacted = redactRow(PPPOE_CONNECTION)
    expect(redacted['ifName']).toBe('ppp0')
    expect(redacted['connStatusV4']).toBe('Connecting')
    expect(redacted['connStatusV6']).toBe('Connected')
  })

  it('drops empty fields', () => {
    expect(redactRow({ name: 'eth0', alias: '', missing: undefined })).toEqual({ name: 'eth0' })
  })

  it('redacts every MAC the port and host lists carry', () => {
    const ports = ETH_INTF_ROWS.map(redactRow)
    const hosts = HOST_ENTRY_ROWS.map(redactRow)
    for (const row of [...ports, ...hosts]) {
      for (const value of Object.values(row)) {
        expect(value).not.toMatch(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/)
      }
    }
  })

  // Same canary discipline as the credential above: prove the name is in the
  // input before asserting it is not in the output.
  it('removes the device name every host entry carries', () => {
    expect(JSON.stringify(HOST_ENTRY_ROWS)).toContain(HOST_NAME_CANARY)
    expect(JSON.stringify(HOST_ENTRY_ROWS.map(redactRow))).not.toContain(HOST_NAME_CANARY)
  })
})

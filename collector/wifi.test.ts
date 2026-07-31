import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureWifi, parseAirportInfo, type WifiSampleInput } from './wifi.js'

/**
 * Fixtures follow the structure of this Mac mini's real `system_profiler
 * SPAirPortDataType` output (macOS 26, 2026-07-30) with every identifier
 * replaced: MAC addresses come from the documentation range, and the network
 * names are invented. The real output prints the SSID as `<redacted>` only
 * because Location Services is off — a side effect that can reverse — so the
 * fixtures carry *readable* names instead, which is the only way an assertion
 * can prove the parser never reads one.
 *
 * The MAC addresses are deliberately kept (unlike link-sampler.test.ts, which
 * deletes the line): the guarantee under test is that no MAC-shaped string
 * reaches a field, and a fixture without one would assert nothing.
 */

/**
 * The connected shape. Neighbour networks below `Other Local Wi-Fi Networks`
 * carry values chosen to be unmistakable if they ever leaked into a field —
 * a 5 GHz 80 MHz channel and a far weaker signal than the connected network's.
 */
const AIRPORT_CONNECTED = `Wi-Fi:

      Software Versions:
          CoreWLAN: 16.0 (1657)
          CoreWLANKit: 16.0 (1657)
          Menu Extra: 1.0 (19150.2)
          IO80211 Family: 12.0 (1200.13.1)
      Interfaces:
        en1:
          Card Type: Wi-Fi  (0x14E4, 0x4388)
          Firmware Version: wl0: Feb  2 2026 19:17:59 version 23.50.20.0.41.51.208
          MAC Address: 00:11:22:33:44:55
          Locale: ETSI
          Country Code: XX
          Supported PHY Modes: 802.11 a/b/g/n/ac/ax
          Supported Channels: 1 (2GHz), 6 (2GHz), 36 (5GHz), 149 (5GHz), 1 (6GHz)
          Wake On Wireless: Supported
          AirDrop: Supported
          Auto Unlock: Supported
          Status: Connected
          Current Network Information:
            example-network:
              PHY Mode: 802.11ax
              Channel: 3 (2GHz, 20MHz)
              Country Code: XX
              Network Type: Infrastructure
              Security: WPA2 Personal
              Signal / Noise: -45 dBm / -83 dBm
              Transmit Rate: 229
              MCS Index: 9
          Other Local Wi-Fi Networks:
            example-neighbour-one:
              PHY Mode: 802.11a/n/ac
              Channel: 44 (5GHz, 80MHz)
              Network Type: Infrastructure
              Security: None
              Signal / Noise: -91 dBm / -87 dBm
            example-neighbour-two:
              PHY Mode: 802.11b/g/n
              Channel: 11 (2GHz, 40MHz)
              Network Type: Infrastructure
              Security: WPA2/WPA3 Personal
        awdl0:
          MAC Address: 66:77:88:99:aa:bb
          Supported Channels: 1 (2GHz), 36 (5GHz)
          Current Network Information:
              Channel: 149 (5GHz, 160MHz)
              Network Type: Infrastructure
`

// The radio associated with nothing. Derived from the capture above: macOS
// prints the status and no `Current Network Information` block at all.
const AIRPORT_NOT_CONNECTED = `Wi-Fi:

      Interfaces:
        en1:
          Card Type: Wi-Fi  (0x14E4, 0x4388)
          MAC Address: 00:11:22:33:44:55
          Supported PHY Modes: 802.11 a/b/g/n/ac/ax
          Status: Not Connected
`

/**
 * A shape this parser does not understand. Not hypothetical: `airport` was
 * removed from this macOS and `wdutil` now requires sudo, so this surface has
 * already churned once and will again.
 */
const AIRPORT_SHAPE_CHANGED = `{
  "SPAirPortDataType": [
    { "spairport_wireless_interfaces": [ { "_name": "en1", "spairport_status_information": "spairport_status_connected" } ] }
  ]
}
`

const ALL_NULL = {
  iface: null,
  status: null,
  phyMode: null,
  channel: null,
  band: null,
  widthMhz: null,
  rssiDbm: null,
  noiseDbm: null,
  txRateMbps: null,
  mcsIndex: null,
}

const MAC_SHAPED = /([0-9a-f]{2}:){5}[0-9a-f]{2}/i

describe('parseAirportInfo', () => {
  test('reads the connected interface and nothing else', () => {
    expect(parseAirportInfo(AIRPORT_CONNECTED)).toEqual({
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
    })
  })

  test('stops at Other Local Wi-Fi Networks — no neighbour data, no MAC, no network name', () => {
    // The guarantee that makes this table safe in a public repo. The raw output
    // enumerates every neighbour network with channel, PHY mode and security,
    // and prints en1's and awdl0's MAC addresses in the clear.
    const values = Object.values(parseAirportInfo(AIRPORT_CONNECTED))

    for (const value of values) {
      expect(typeof value === 'string' ? MAC_SHAPED.test(value) : false).toBe(false)
    }
    // Network names — the connected one included — have no path into a field.
    expect(values).not.toContain('example-network')
    expect(values).not.toContain('example-neighbour-one')
    expect(values).not.toContain('example-neighbour-two')
    // Neighbour radio values, each distinct from the connected network's.
    expect(values).not.toContain(44)
    expect(values).not.toContain(80)
    expect(values).not.toContain(-91)
    expect(values).not.toContain('5GHz')
    expect(values).not.toContain('802.11a/n/ac')
    // Whitelisted keys only: `Security` and `Country Code` are not read even
    // inside the connected network's own block.
    expect(values).not.toContain('WPA2 Personal')
    expect(values).not.toContain('XX')
  })

  test('never reads awdl0, which has its own Current Network Information block', () => {
    // awdl0 (AirDrop) prints a current-network block and no `Status:` line, so
    // it can never be selected. Its `Channel:` line here is synthesised — the
    // real block prints only `Network Type` — precisely so this assertion can
    // fail loudly if interface scoping regresses.
    const parsed = parseAirportInfo(AIRPORT_CONNECTED)
    expect(parsed.iface).toBe('en1')
    expect(parsed.channel).toBe(3)
    expect(parsed.widthMhz).toBe(20)
  })

  test('records Not Connected as the finding it is', () => {
    // Status is what was measured; every radio field genuinely has no value.
    expect(parseAirportInfo(AIRPORT_NOT_CONNECTED)).toEqual({
      ...ALL_NULL,
      iface: 'en1',
      status: 'Not Connected',
    })
  })

  test('an output shape it does not understand is all nulls, not a throw', () => {
    // Degrading is the whole contract: this surface has churned once already,
    // and a parser that throws would take the probe cycle down with it.
    expect(parseAirportInfo(AIRPORT_SHAPE_CHANGED)).toEqual(ALL_NULL)
    expect(parseAirportInfo('')).toEqual(ALL_NULL)
    expect(parseAirportInfo('system_profiler: unknown datatype SPAirPortDataType\n')).toEqual(ALL_NULL)
  })

  test('a field that will not parse is null, never a plausible number', () => {
    const withBrokenValues = AIRPORT_CONNECTED.replace('Channel: 3 (2GHz, 20MHz)', 'Channel: auto')
      .replace('Signal / Noise: -45 dBm / -83 dBm', 'Signal / Noise: not measured')
      .replace('Transmit Rate: 229', 'Transmit Rate: n/a')
      .replace('MCS Index: 9', 'MCS Index: -')
    expect(parseAirportInfo(withBrokenValues)).toEqual({
      ...ALL_NULL,
      iface: 'en1',
      status: 'Connected',
      phyMode: '802.11ax',
    })
  })

  test('a channel with no band clause keeps the channel and nulls the band', () => {
    // Partial evidence stays partial in both directions: the number is there,
    // the band is not, and neither is inferred from the other.
    const noBand = AIRPORT_CONNECTED.replace('Channel: 3 (2GHz, 20MHz)', 'Channel: 3')
    const parsed = parseAirportInfo(noBand)
    expect(parsed.channel).toBe(3)
    expect(parsed.band).toBeNull()
    expect(parsed.widthMhz).toBeNull()
  })
})

describe('captureWifi', () => {
  /**
   * Runs the real `captureWifi` in a child process whose PATH puts stub
   * `system_profiler` and `ping` binaries ahead of the system ones — the same
   * device vantage.test.ts uses, and for the same reason: `Bun.spawn` resolves
   * against the PATH captured at startup, so mutating this process's PATH would
   * silently run the real commands and "pass" against live radio state.
   */
  async function withStubbedCommands(stubs: {
    airport: string
    airportExit?: number
    ping: string
    pingExit?: number
    iface?: string
  }): Promise<WifiSampleInput | null> {
    const dir = mkdtempSync(join(tmpdir(), 'linewatch-wifi-'))
    try {
      // Canned output goes in a file the stub cats rather than inline in the
      // script — `printf '%s'` does not expand the escapes that come back from
      // JSON.stringify, which would collapse these fixtures onto one line.
      for (const [name, body, exit] of [
        ['system_profiler', stubs.airport, stubs.airportExit ?? 0],
        ['ping', stubs.ping, stubs.pingExit ?? 0],
      ] as const) {
        writeFileSync(join(dir, `${name}.out`), body)
        writeFileSync(join(dir, name), `#!/bin/sh\ncat ${JSON.stringify(join(dir, `${name}.out`))}\nexit ${exit}\n`)
        chmodSync(join(dir, name), 0o755)
      }
      const script = join(dir, 'capture.ts')
      writeFileSync(
        script,
        `import { captureWifi } from ${JSON.stringify(join(import.meta.dir, 'wifi.ts'))}\n` +
          `console.log(JSON.stringify(await captureWifi({ iface: ${JSON.stringify(stubs.iface ?? 'en1')}, pingTarget: '1.1.1.1', timeoutMs: 5000 })))\n`,
      )
      const proc = Bun.spawn(['bun', 'run', script], {
        stdout: 'pipe',
        stderr: 'ignore',
        env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}` },
      })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      return JSON.parse(out) as WifiSampleInput | null
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const PING_OK = `PING 1.1.1.1 (1.1.1.1): 56 data bytes
64 bytes from 1.1.1.1: icmp_seq=0 ttl=58 time=9.921 ms
64 bytes from 1.1.1.1: icmp_seq=1 ttl=58 time=9.990 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=58 time=12.040 ms

--- 1.1.1.1 ping statistics ---
3 packets transmitted, 3 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 9.921/10.650/12.040/0.982 ms
`

  // 100% loss: macOS ping exits 2 and prints no round-trip summary line.
  const PING_TOTAL_LOSS = `PING 1.1.1.1 (1.1.1.1): 56 data bytes
Request timeout for icmp_seq 0
Request timeout for icmp_seq 1

--- 1.1.1.1 ping statistics ---
5 packets transmitted, 0 packets received, 100.0% packet loss
`

  test('combines the radio state with an interface-bound round trip', async () => {
    const sample = await withStubbedCommands({ airport: AIRPORT_CONNECTED, ping: PING_OK })
    expect(sample).toEqual({
      iface: 'en1',
      status: 'Connected',
      phyMode: '802.11ax',
      channel: 3,
      band: '2GHz',
      widthMhz: 20,
      rssiDbm: -45,
      noiseDbm: -83,
      // The negotiated PHY rate — 229 Mbit alongside a 9.99 ms round trip.
      // Nothing may read the first number as throughput or as "faster".
      txRateMbps: 229,
      mcsIndex: 9,
      rttMedMs: 9.99,
      lossPct: 0,
    })
  })

  test('100% loss is a measurement, not a failure — the exit code is never consulted', async () => {
    const sample = await withStubbedCommands({ airport: AIRPORT_CONNECTED, ping: PING_TOTAL_LOSS, pingExit: 2 })
    expect(sample?.lossPct).toBe(100)
    // Null, not 0: no reply was timed, so there is no round trip to report.
    expect(sample?.rttMedMs).toBeNull()
    // The radio half is unaffected — an unreachable target says nothing about
    // whether the interface is associated.
    expect(sample?.rssiDbm).toBe(-45)
  })

  test('both commands failing produces no sample at all, rather than a row of nulls', async () => {
    // A row of nulls has to keep meaning "we looked at the radio and learned
    // nothing". "Neither command ran" is a different statement and gets no row.
    expect(await withStubbedCommands({ airport: '', airportExit: 1, ping: '', pingExit: 1 })).toBeNull()
  })

  test('a radio block describing another interface is dropped, not merged', async () => {
    // The ping is bound to the requested interface, so pairing it with a
    // different interface's radio would describe no single thing.
    const sample = await withStubbedCommands({ airport: AIRPORT_CONNECTED, ping: PING_OK, iface: 'en9' })
    expect(sample).toEqual({
      ...ALL_NULL,
      iface: 'en9',
      rttMedMs: 9.99,
      lossPct: 0,
    })
  })

  test('a shape-changed system_profiler still yields the reachability half', async () => {
    const sample = await withStubbedCommands({ airport: AIRPORT_SHAPE_CHANGED, ping: PING_OK })
    expect(sample).toEqual({
      ...ALL_NULL,
      iface: 'en1',
      rttMedMs: 9.99,
      lossPct: 0,
    })
  })
})

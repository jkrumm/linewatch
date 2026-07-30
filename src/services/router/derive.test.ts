import { describe, expect, it } from 'bun:test'
import {
  compareVantage,
  detectResync,
  disagreementSignature,
  type HostVantage,
  type RouterVantage,
} from './derive.js'

const onEthernet: HostVantage = {
  ts: 1_000,
  pathClass: 'ethernet',
  linkMbit: 1000,
  linkDuplex: 'full',
  onHomeLine: 1,
}

const routerAgrees: RouterVantage = {
  port: { name: 'eth0', alias: 'LAN1', status: 'Up', maxBitRate: 1000, duplexMode: 'Full' },
  host: { ip: '192.168.1.100', interfaceType: 'Ethernet', active: 1 },
}

describe('compareVantage', () => {
  it('finds nothing when both vantages agree', () => {
    expect(compareVantage(onEthernet, routerAgrees)).toEqual([])
  })

  it('reports a link-speed disagreement without picking a winner', () => {
    const disagreements = compareVantage(
      { ...onEthernet, linkMbit: 100 },
      routerAgrees,
    )
    expect(disagreements).toEqual([
      { field: 'link_speed', host: '100 Mbit', router: '1000 Mbit on LAN1' },
    ])
  })

  it('reports a duplex disagreement', () => {
    expect(compareVantage({ ...onEthernet, linkDuplex: 'half' }, routerAgrees)).toEqual([
      { field: 'link_duplex', host: 'half', router: 'Full' },
    ])
  })

  it('reports the host being absent from the router while it claims ethernet', () => {
    const disagreements = compareVantage(onEthernet, { ...routerAgrees, host: null })
    expect(disagreements.map((d) => d.field)).toEqual(['host_presence'])
  })

  it('reports a path-class disagreement when the router sees the host on Wi-Fi', () => {
    const disagreements = compareVantage(onEthernet, {
      ...routerAgrees,
      host: { ip: '192.168.1.100', interfaceType: 'Wi-Fi', active: 1 },
    })
    expect(disagreements.map((d) => d.field)).toEqual(['path_class'])
  })

  it('reports a down port as a status contradiction, not a 1000-vs-0 speed mismatch', () => {
    const disagreements = compareVantage(onEthernet, {
      ...routerAgrees,
      port: { name: 'eth0', alias: 'LAN1', status: 'Down', maxBitRate: 0, duplexMode: 'Half' },
    })
    expect(disagreements.map((d) => d.field)).toEqual(['port_status'])
  })

  it('treats an unreported field as unknown, never as a match or a mismatch', () => {
    const unknownHost: HostVantage = {
      ts: 1_000,
      pathClass: null,
      linkMbit: null,
      linkDuplex: null,
      onHomeLine: null,
    }
    expect(compareVantage(unknownHost, routerAgrees)).toEqual([])
    expect(
      compareVantage(onEthernet, {
        port: { name: null, alias: null, status: null, maxBitRate: null, duplexMode: null },
        host: { ip: '192.168.1.100', interfaceType: null, active: 1 },
      }),
    ).toEqual([])
  })

  it('compares an older collector that never reported on_home_line', () => {
    // null is "unknown", which is not a licence to skip the check.
    const disagreements = compareVantage(
      { ...onEthernet, onHomeLine: null, linkMbit: 100 },
      routerAgrees,
    )
    expect(disagreements.map((d) => d.field)).toEqual(['link_speed'])
  })

  it('says nothing about a cycle the host already knows was not the home line', () => {
    // Failover to cellular: the router's view of a LAN port describes a cable,
    // not the path the probes took, and probe_cycle already records the failover.
    const cellular: HostVantage = {
      ts: 1_000,
      pathClass: 'cellular',
      linkMbit: null,
      linkDuplex: null,
      onHomeLine: 0,
    }
    expect(compareVantage(cellular, routerAgrees)).toEqual([])
  })
})

describe('disagreementSignature', () => {
  it('is stable for the same disagreements and changes when they do', () => {
    const first = compareVantage({ ...onEthernet, linkMbit: 100 }, routerAgrees)
    const same = compareVantage({ ...onEthernet, linkMbit: 100 }, routerAgrees)
    const other = compareVantage({ ...onEthernet, linkDuplex: 'half' }, routerAgrees)
    expect(disagreementSignature(first)).toBe(disagreementSignature(same))
    expect(disagreementSignature(first)).not.toBe(disagreementSignature(other))
    expect(disagreementSignature([])).toBe('')
  })
})

describe('detectResync', () => {
  it('fires only when showtime seconds go backwards', () => {
    expect(detectResync(3589, 3889)).toBe(false)
    expect(detectResync(3589, 12)).toBe(true)
    expect(detectResync(null, 12)).toBe(false)
    expect(detectResync(3589, null)).toBe(false)
  })
})

import { describe, expect, it } from 'bun:test'
import {
  compareVantage,
  detectResync,
  detectRestart,
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
  const at = (ts: number, seconds: number | null) => ({ ts, seconds })

  it('fires when showtime seconds go backwards', () => {
    expect(detectResync(at(0, 3589), at(300_000, 3889))).toBe(false)
    expect(detectResync(at(0, 3589), at(300_000, 12))).toBe(true)
  })

  it('treats a missing reading on either side as unknown', () => {
    expect(detectResync(null, at(0, 12))).toBe(false)
    expect(detectResync(at(0, null), at(300_000, 12))).toBe(false)
    expect(detectResync(at(0, 3589), at(300_000, null))).toBe(false)
  })

  /**
   * 2026-08-01, and the reason this compares epochs rather than counters. The
   * line resynced at 10:09:38 and again at 10:29:37; the 10:10:01 and 10:30:00
   * polls both read `showtimeStart = 23`. Under `current < previous` the second
   * resync produced no event at all and had to be back-solved by hand from the
   * 10:40 / 10:50 / 11:00 readings — the one event of the incident that the
   * record simply did not contain.
   */
  it('sees two resyncs that were read at the identical showtime counter', () => {
    const firstPoll = at(Date.UTC(2026, 7, 1, 10, 10, 1), 23)
    const secondPoll = at(Date.UTC(2026, 7, 1, 10, 30, 0), 23)
    expect(detectResync(firstPoll, secondPoll)).toBe(true)
  })

  it('does not fire across an ordinary interval on one unbroken showtime', () => {
    const firstPoll = at(Date.UTC(2026, 7, 1, 10, 10, 1), 23)
    const laterPoll = at(Date.UTC(2026, 7, 1, 10, 20, 1), 623)
    expect(detectResync(firstPoll, laterPoll)).toBe(false)
  })

  it('absorbs the second or two between a poll timestamp and its reads', () => {
    expect(detectResync(at(0, 100), at(600_000, 703))).toBe(false)
  })
})

describe('detectRestart on a session counter', () => {
  const at = (ts: number, seconds: number | null) => ({ ts, seconds })

  /**
   * The guard that keeps a DS-Lite line from reporting a WAN restart every ten
   * minutes forever. `X_TP_Uptime` measures the v4 stack, which is disabled on
   * this line (`connIPv4Enabled = 0`), so it reads 0 on every poll — and a
   * back-solved start epoch of "now" advances with every poll.
   */
  it('reads a counter pinned at zero as not running, not as restarting', () => {
    expect(detectRestart(at(0, 0), at(600_000, 0))).toBe(false)
    expect(detectRestart(at(600_000, 0), at(1_200_000, 0))).toBe(false)
  })

  /** Zero is "not running" only while it stays zero. A stack that came up in between did restart. */
  it('still sees a stack that came up, or went down, either side of a zero', () => {
    expect(detectRestart(at(0, 0), at(600_000, 42))).toBe(true)
    expect(detectRestart(at(0, 4761), at(600_000, 0))).toBe(true)
  })

  it('sees a session re-established between two polls', () => {
    expect(detectRestart(at(0, 4761), at(600_000, 23))).toBe(true)
  })

  it('does not fire on a session that simply kept running', () => {
    expect(detectRestart(at(0, 4761), at(600_000, 5361))).toBe(false)
  })
})

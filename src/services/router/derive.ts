/**
 * Everything the poller *derives* rather than records: the comparison of the
 * host's own view of its link against the router's view of the same link, and
 * the resync detection that turns two consecutive line samples into an event.
 *
 * The comparison is the reason this poller exists. `probe_cycle` says what the
 * collector measured through, from the host side; `router_eth_port` and
 * `router_host` say what the router sees on the other end of the same cable.
 * When the two disagree, the disagreement is itself the signal — one of them is
 * wrong and which one matters. So it is recorded as an event with both readings
 * intact and neither is declared the winner.
 */

export type PathClass = 'ethernet' | 'wifi' | 'cellular' | 'other'

/** The host-side vantage, straight out of the collector's `probe_cycle` row. */
export interface HostVantage {
  ts: number
  pathClass: PathClass | null
  linkMbit: number | null
  linkDuplex: 'full' | 'half' | null
  /** 1 = ethernet + the configured home gateway, 0 = not the home line, null = unknown. */
  onHomeLine: number | null
}

/** The router-side vantage of the same host, from this poll. */
export interface RouterVantage {
  port: {
    name: string | null
    alias: string | null
    status: string | null
    maxBitRate: number | null
    duplexMode: string | null
  } | null
  host: {
    ip: string | null
    interfaceType: string | null
    active: number | null
  } | null
}

export interface Disagreement {
  field: 'host_presence' | 'path_class' | 'port_status' | 'link_speed' | 'link_duplex'
  host: string
  router: string
}

/** `Ethernet`, `Wi-Fi`, `802.11ax`… mapped onto the collector's own vocabulary. */
function classifyInterfaceType(interfaceType: string | null): PathClass | null {
  if (interfaceType === null) return null
  const value = interfaceType.toLowerCase()
  if (value.includes('ethernet')) return 'ethernet'
  if (value.includes('wi-fi') || value.includes('wifi') || value.includes('802.11')) return 'wifi'
  return 'other'
}

/**
 * Compares the two vantages and returns every disagreement found. Empty means
 * they agree *or* that one side did not report — a null is never treated as a
 * match and never as a mismatch, because "unknown" is not evidence.
 *
 * Skipped entirely when the host already knows it is not on the home line
 * (`onHomeLine === 0`): the router's view of a LAN port says nothing about a host
 * that has failed over to cellular, and the collector's own row already records
 * that failover. Null `onHomeLine` (an older collector) still gets compared —
 * unknown is not a licence to skip the check.
 */
export function compareVantage(host: HostVantage, router: RouterVantage): Disagreement[] {
  if (host.onHomeLine === 0) return []

  const found: Disagreement[] = []
  const claimsHomeLine = host.pathClass === 'ethernet'

  if (claimsHomeLine && (router.host === null || router.host.active !== 1)) {
    found.push({
      field: 'host_presence',
      host: 'default route over ethernet',
      router:
        router.host === null
          ? 'no host entry for the collector address'
          : `host entry present but active=${String(router.host.active)}`,
    })
  }

  const routerClass = classifyInterfaceType(router.host?.interfaceType ?? null)
  if (host.pathClass !== null && routerClass !== null && host.pathClass !== routerClass) {
    found.push({
      field: 'path_class',
      host: host.pathClass,
      router: router.host?.interfaceType ?? routerClass,
    })
  }

  const port = router.port
  if (port === null) return found

  // A port the router calls Down while the host reports a negotiated link is a
  // contradiction about the cable, not about its speed — report it as such and
  // do not also emit a 1000-vs-0 speed mismatch.
  if (port.status !== null && port.status.toLowerCase() !== 'up' && host.linkMbit !== null) {
    found.push({
      field: 'port_status',
      host: `${host.linkMbit} Mbit link up`,
      router: `port ${port.alias ?? port.name ?? '?'} status ${port.status}`,
    })
    return found
  }

  if (host.linkMbit !== null && port.maxBitRate !== null && host.linkMbit !== port.maxBitRate) {
    found.push({
      field: 'link_speed',
      host: `${host.linkMbit} Mbit`,
      router: `${port.maxBitRate} Mbit on ${port.alias ?? port.name ?? '?'}`,
    })
  }

  const routerDuplex = port.duplexMode?.toLowerCase() ?? null
  if (host.linkDuplex !== null && routerDuplex !== null && host.linkDuplex !== routerDuplex) {
    found.push({
      field: 'link_duplex',
      host: host.linkDuplex,
      router: port.duplexMode ?? routerDuplex,
    })
  }

  return found
}

/**
 * A signature that changes only when the set of disagreements changes, so an
 * ongoing disagreement is recorded once instead of every five minutes.
 */
export function disagreementSignature(disagreements: readonly Disagreement[]): string {
  return disagreements.map((d) => `${d.field}:${d.host}|${d.router}`).join(';')
}

/**
 * True when the line resynced between two polls. `showtimeStart` counts seconds
 * since the line reached showtime, so it only ever decreases by resyncing —
 * which makes a decrease the honest signal, and a missed poll harmless.
 */
export function detectResync(previous: number | null, current: number | null): boolean {
  if (previous === null || current === null) return false
  return current < previous
}

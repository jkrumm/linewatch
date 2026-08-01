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

/** One reading of a "seconds since X started" counter, with when it was read. */
export interface UptimeObservation {
  /** Unix ms of the poll that produced it. */
  ts: number
  /** The router's own seconds-since-start, or null when it did not report. */
  seconds: number | null
}

/**
 * Poll timestamps are taken at the start of a poll and the reads follow over the
 * next second or two, so two back-solved start epochs for the *same* event
 * differ slightly. Wide enough to absorb that, far below any real interval.
 */
const RESTART_TOLERANCE_S = 10

/**
 * True when a "seconds since X started" counter shows a **new** X between two
 * observations.
 *
 * Compares back-solved start epochs (`ts − seconds`), not the raw counters, and
 * that is the whole point. The obvious test — did the number go down — misses
 * the case that matters: on 2026-08-01 the line resynced at 10:09:38 and again
 * at 10:29:37, and both the 10:10:01 and the 10:30:00 poll read
 * `showtimeStart = 23`. A strict `current < previous` recorded the first and
 * not the second, so the resync that mattered — the one the router reboot
 * caused — is missing from the event table entirely and had to be back-solved
 * by hand from three later readings. Epochs 20 minutes apart cannot collide
 * that way.
 *
 * Two guards, both load-bearing:
 * - A counter pinned at 0 across both readings is *not running*, not
 *   restarting every poll. Without this, `X_TP_Uptime` on a DS-Lite line —
 *   permanently 0, because the v4 stack is disabled — would fire a fabricated
 *   restart on every single poll forever.
 * - A missing reading on either side is unknown, never a restart.
 */
export function detectRestart(previous: UptimeObservation | null, current: UptimeObservation): boolean {
  if (previous === null || previous.seconds === null || current.seconds === null) return false
  if (previous.seconds === 0 && current.seconds === 0) return false
  const previousStart = previous.ts - previous.seconds * 1000
  const currentStart = current.ts - current.seconds * 1000
  return currentStart > previousStart + RESTART_TOLERANCE_S * 1000
}

/**
 * True when the carrier line resynced between two polls — `detectRestart` over
 * `showtimeStart`, which counts seconds since the line reached showtime.
 */
export function detectResync(previous: UptimeObservation | null, current: UptimeObservation): boolean {
  return detectRestart(previous, current)
}

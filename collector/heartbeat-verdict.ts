/**
 * The pure half of the Uptime Kuma heartbeat: given one `GET /api/status`
 * snapshot, decide whether to report the home line up or down, and say why.
 *
 * Kuma runs on the homelab, which is on a different WAN, so it cannot probe
 * this line at all — the mini has to report on itself. That inversion is what
 * makes the monitor work rather than a limitation of it: a home-line outage
 * severs the push path, Kuma sees a missed heartbeat, and the alert leaves the
 * homelab over a WAN this outage does not touch. The push failing *is* the
 * signal.
 *
 * Which leaves exactly one thing this module must get right: the difference
 * between "the line is down" (silence, because the push cannot land) and
 * "linewatch stopped measuring" (an explicit `down` push, which can land). If
 * those two produced the same signal the monitor would be worth very little —
 * a dead collector would read as an outage and an outage as a dead collector.
 *
 * **`status.up` is not usable on its own, and that is the whole reason this
 * file exists.** It is `ongoingOutages.length === 0`, and no outage row can
 * ever open while no cycle is being ingested — so a collector that died at
 * 02:00 reports a perfectly up line forever. Freshness of the newest sample is
 * the load-bearing check; the outage list is the cheap one.
 */

export type HeartbeatStatus = 'up' | 'down'

/**
 * Ordered by how much they mean, not alphabetically: `decide` returns the first
 * that applies, and the order below is the order it evaluates.
 */
export type HeartbeatReason =
  | 'api_unreachable'
  | 'no_samples'
  | 'collector_stale'
  | 'vantage_unknown'
  | 'off_home_line'
  | 'gateway_outage'
  | 'wan_outage'
  | 'ok'

export interface HeartbeatVerdict {
  status: HeartbeatStatus
  reason: HeartbeatReason
  /** What Kuma shows in the alert. Diagnosis first, decoration last. */
  msg: string
}

export interface StatusSample {
  target: string
  scope: 'gateway' | 'wan'
  ts: number
  received: number
  lossPct: number
  medMs: number | null
}

export interface StatusOutage {
  scope: 'gateway' | 'wan'
  startedAt: number
  cycles: number
  evidence: string[]
}

export interface StatusVantage {
  /** Three-state, and never coalesced: null means the collector did not report. */
  onHomeLine: boolean | null
  pathIf: string | null
  pathClass: string | null
  linkMedia: string | null
}

export interface StatusSnapshot {
  ongoingOutages: StatusOutage[]
  lastSamples: StatusSample[]
  lastSpeedTest: { ts: number; ok: boolean; downloadMbps: number | null; uploadMbps: number | null } | null
  vantage: StatusVantage | null
}

export interface HeartbeatInput {
  /** null when the API could not be reached or did not answer usefully. */
  status: StatusSnapshot | null
  /** Why it could not be reached. Only read when `status` is null. */
  apiError: string | null
  now: number
  /**
   * How old the newest probe sample may be before the record stops counting as
   * current. Three probe cycles by default — the same 90 s the watchdog spec
   * uses, and for the same reason: two missed cycles are a hiccup, three are a
   * collector that is not running.
   */
  staleSampleMs: number
  /** Per-cycle loss share (0–100) at or above which a cycle is flagged in the message. */
  degradedLossPct: number
}

function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

function round(value: number | null, digits = 1): string {
  return value === null ? '—' : value.toFixed(digits)
}

/**
 * Worst loss across the WAN anchors in the newest cycle. Reported in the
 * message, never in the verdict: `outage-detector.ts` only opens a row when
 * *every* anchor is at zero received, and widening that here would re-import
 * the false positive the strict rule exists to avoid — 2026-08-01 09:38:34 lost
 * 40–45% across all three anchors with a clean gateway and healed in ~2 s.
 * Worth seeing in an alert body, not worth paging on.
 */
function worstWanLoss(samples: readonly StatusSample[]): number {
  const wan = samples.filter((sample) => sample.scope === 'wan')
  return wan.length === 0 ? 0 : Math.max(...wan.map((sample) => sample.lossPct))
}

function newestSampleTs(samples: readonly StatusSample[]): number | null {
  return samples.length === 0 ? null : Math.max(...samples.map((sample) => sample.ts))
}

function pathLabel(vantage: StatusVantage): string {
  return `${vantage.pathIf ?? 'none'}/${vantage.pathClass ?? 'unknown'}/${vantage.linkMedia ?? 'unknown'}`
}

export function decideHeartbeat(input: HeartbeatInput): HeartbeatVerdict {
  const { status, now, staleSampleMs } = input

  // 1. The API is the only window onto the record. Unreachable is a real fault
  //    and it is reportable, because the container being down does not stop the
  //    push from leaving the host.
  if (status === null) {
    return {
      status: 'down',
      reason: 'api_unreachable',
      msg: `linewatch API unreachable: ${input.apiError ?? 'unknown error'}`,
    }
  }

  const newest = newestSampleTs(status.lastSamples)

  // 2. An empty record is not a healthy one. Distinguished from staleness
  //    because the fixes differ: this is a collector that has never delivered.
  if (newest === null) {
    return { status: 'down', reason: 'no_samples', msg: 'no probe samples on record — the collector has never delivered' }
  }

  // 3. The check `status.up` cannot make. No ingest means no outage row can
  //    open, so an unfresh record reads as a perfectly healthy line.
  const age = now - newest
  if (age > staleSampleMs) {
    return {
      status: 'down',
      reason: 'collector_stale',
      msg: `collector stale — newest sample ${humanDuration(age)} old (API answering, so this is the collector, not the line)`,
    }
  }

  // 4/5. The monitor asserts a *measured* home line, so it cannot stay green
  //      while the mini is measuring something else — a Wi-Fi failover, a
  //      hotspot, a travel router. `onHomeLine` is three-state and null means
  //      the collector did not report, which is unknown, not yes. Coalescing it
  //      is the fabrication docs/DESIGN.md names explicitly, and it is not
  //      theoretical: of 5210 recorded cycles 5202 read 1, six read 0 during a
  //      real Wi-Fi failover, and the two nulls fall inside a router reboot.
  if (status.vantage === null) {
    return {
      status: 'down',
      reason: 'vantage_unknown',
      msg: 'no cycle vantage on record — cannot show these samples measured the home line',
    }
  }
  if (status.vantage.onHomeLine !== true) {
    const verdict = status.vantage.onHomeLine === null ? 'unknown' : 'false'
    return {
      status: 'down',
      reason: 'off_home_line',
      msg: `not measuring the home line (onHomeLine=${verdict}, path ${pathLabel(status.vantage)}) — samples describe some other uplink`,
    }
  }

  const gatewayOutage = status.ongoingOutages.find((outage) => outage.scope === 'gateway')
  const wanOutage = status.ongoingOutages.find((outage) => outage.scope === 'wan')

  // 6. Gateway before WAN: when the router itself is unreachable every WAN
  //    anchor is too, and naming the WAN would point at the wrong hop.
  if (gatewayOutage !== undefined) {
    return {
      status: 'down',
      reason: 'gateway_outage',
      msg: `gateway unreachable for ${humanDuration(now - gatewayOutage.startedAt)} (${gatewayOutage.cycles} cycles) — the router, not the line`,
    }
  }

  if (wanOutage !== undefined) {
    const gateway = status.lastSamples.find((sample) => sample.scope === 'gateway')
    const gatewayNote = gateway === undefined ? '' : `, gateway ok ${round(gateway.medMs)}ms`
    return {
      status: 'down',
      reason: 'wan_outage',
      msg: `WAN down ${humanDuration(now - wanOutage.startedAt)} (${wanOutage.cycles} cycles: ${wanOutage.evidence.join(',')})${gatewayNote}`,
    }
  }

  return { status: 'up', reason: 'ok', msg: upMessage(input, status, age) }
}

/**
 * The healthy-path message. Kuma keeps it against the heartbeat, so it doubles
 * as a cheap timeline of what the line looked like at every minute of the day —
 * which is the one thing the dashboard cannot show you from a phone.
 */
function upMessage(input: HeartbeatInput, status: StatusSnapshot, sampleAge: number): string {
  const parts: string[] = []

  const wan = status.lastSamples.filter((sample) => sample.scope === 'wan')
  const wanMedians = wan.map((sample) => sample.medMs).filter((value): value is number => value !== null)
  parts.push(`wan ${wanMedians.length === 0 ? '—' : round(Math.min(...wanMedians))}ms`)

  const gateway = status.lastSamples.find((sample) => sample.scope === 'gateway')
  if (gateway !== undefined) parts.push(`gw ${round(gateway.medMs)}ms`)

  const loss = worstWanLoss(status.lastSamples)
  if (loss >= input.degradedLossPct) parts.push(`DEGRADED ${round(loss, 0)}% loss`)
  else if (loss > 0) parts.push(`${round(loss, 0)}% loss`)

  if (status.vantage !== null) parts.push(`${status.vantage.pathIf ?? 'none'} ${status.vantage.linkMedia ?? 'unknown'}`)

  const speed = status.lastSpeedTest
  if (speed !== null && speed.ok) {
    parts.push(`${round(speed.downloadMbps, 0)}/${round(speed.uploadMbps, 0)} Mbps ${humanDuration(input.now - speed.ts)} ago`)
  } else if (speed !== null) {
    parts.push('last speed test failed')
  }

  parts.push(`sample ${humanDuration(sampleAge)} old`)
  return parts.join(' · ')
}

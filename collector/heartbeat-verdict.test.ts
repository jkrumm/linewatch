import { describe, expect, test } from 'bun:test'
import {
  decideHeartbeat,
  type HeartbeatInput,
  type StatusSample,
  type StatusSnapshot,
  type StatusVantage,
} from './heartbeat-verdict.js'

/**
 * Nothing here touches the network. The whole judgement of the heartbeat lives
 * in `decideHeartbeat`, and the half that does not — one fetch and one curl —
 * has no decisions in it.
 *
 * The case that matters most is `collector stale`: every snapshot below with an
 * empty `ongoingOutages` would make `GET /api/status`'s own `up` field true,
 * including the ones where the collector has been dead for an hour. If this
 * suite ever goes green with that case reporting `up`, the monitor has become a
 * green light wired to nothing.
 */

const NOW = 1_785_600_000_000

const HOME_VANTAGE: StatusVantage = {
  onHomeLine: true,
  pathIf: 'en0',
  pathClass: 'ethernet',
  linkMedia: '1000baseT',
}

function samples(ts: number, overrides: Partial<StatusSample>[] = []): StatusSample[] {
  const base: StatusSample[] = [
    { target: 'gateway', scope: 'gateway', ts, received: 20, lossPct: 0, medMs: 1.02 },
    { target: 'cloudflare', scope: 'wan', ts, received: 20, lossPct: 0, medMs: 4.4 },
    { target: 'google', scope: 'wan', ts, received: 20, lossPct: 0, medMs: 5.1 },
    { target: 'quad9', scope: 'wan', ts, received: 20, lossPct: 0, medMs: 6.0 },
  ]
  return base.map((sample, i) => ({ ...sample, ...(overrides[i] ?? {}) }))
}

function snapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    ongoingOutages: [],
    lastSamples: samples(NOW - 10_000),
    lastSpeedTest: { ts: NOW - 2_400_000, ok: true, downloadMbps: 552.4, uploadMbps: 205.1 },
    vantage: HOME_VANTAGE,
    ...over,
  }
}

function decide(over: Partial<HeartbeatInput> = {}) {
  return decideHeartbeat({
    status: snapshot(),
    apiError: null,
    now: NOW,
    staleSampleMs: 90_000,
    degradedLossPct: 20,
    ...over,
  })
}

describe('decideHeartbeat', () => {
  test('a healthy line reports up and carries the numbers in the message', () => {
    const verdict = decide()
    expect(verdict.status).toBe('up')
    expect(verdict.reason).toBe('ok')
    expect(verdict.msg).toContain('wan 4.4ms')
    expect(verdict.msg).toContain('gw 1.0ms')
    expect(verdict.msg).toContain('en0 1000baseT')
    expect(verdict.msg).toContain('552/205 Mbps')
  })

  test('an unreachable API is down and names the error', () => {
    const verdict = decide({ status: null, apiError: 'connect ECONNREFUSED 127.0.0.1:7731' })
    expect(verdict.status).toBe('down')
    expect(verdict.reason).toBe('api_unreachable')
    expect(verdict.msg).toContain('ECONNREFUSED')
  })

  test('an empty record is down rather than silently up', () => {
    const verdict = decide({ status: snapshot({ lastSamples: [] }) })
    expect(verdict.status).toBe('down')
    expect(verdict.reason).toBe('no_samples')
  })

  /**
   * The trap the whole module exists for. `ongoingOutages` is empty here, so
   * `GET /api/status` reports `up: true` — because no cycle is being ingested,
   * so the outage state machine has nothing to open a row from.
   */
  test('a dead collector is down even though the API reports up', () => {
    const dead = snapshot({ lastSamples: samples(NOW - 45 * 60_000), ongoingOutages: [] })
    expect(dead.ongoingOutages).toHaveLength(0)

    const verdict = decide({ status: dead })
    expect(verdict.status).toBe('down')
    expect(verdict.reason).toBe('collector_stale')
    expect(verdict.msg).toContain('45m')
    expect(verdict.msg).toContain('not the line')
  })

  test('a sample inside the staleness window is still fresh', () => {
    const verdict = decide({ status: snapshot({ lastSamples: samples(NOW - 89_000) }) })
    expect(verdict.status).toBe('up')
  })

  test('one second past it is not', () => {
    const verdict = decide({ status: snapshot({ lastSamples: samples(NOW - 91_000) }) })
    expect(verdict.reason).toBe('collector_stale')
  })

  test('measuring some other uplink is down, not up', () => {
    const verdict = decide({
      status: snapshot({ vantage: { onHomeLine: false, pathIf: 'en1', pathClass: 'wifi', linkMedia: 'autoselect' } }),
    })
    expect(verdict.status).toBe('down')
    expect(verdict.reason).toBe('off_home_line')
    expect(verdict.msg).toContain('onHomeLine=false')
  })

  /** null is unknown. Never coalesced to true — docs/DESIGN.md, and the two recorded nulls sit inside a router reboot. */
  test('an unknown home-line verdict is not treated as a yes', () => {
    const verdict = decide({
      status: snapshot({ vantage: { onHomeLine: null, pathIf: null, pathClass: null, linkMedia: null } }),
    })
    expect(verdict.status).toBe('down')
    expect(verdict.reason).toBe('off_home_line')
    expect(verdict.msg).toContain('onHomeLine=unknown')
  })

  test('no vantage at all is reported as such rather than assumed', () => {
    const verdict = decide({ status: snapshot({ vantage: null }) })
    expect(verdict.reason).toBe('vantage_unknown')
  })

  test('an ongoing WAN outage names its evidence and its duration', () => {
    const verdict = decide({
      status: snapshot({
        ongoingOutages: [
          { scope: 'wan', startedAt: NOW - 450_000, cycles: 15, evidence: ['cloudflare', 'google', 'quad9'] },
        ],
        lastSamples: samples(NOW - 10_000, [{}, { received: 0, lossPct: 100, medMs: null }, { received: 0, lossPct: 100, medMs: null }, { received: 0, lossPct: 100, medMs: null }]),
      }),
    })
    expect(verdict.status).toBe('down')
    expect(verdict.reason).toBe('wan_outage')
    expect(verdict.msg).toContain('7m30s')
    expect(verdict.msg).toContain('cloudflare,google,quad9')
    expect(verdict.msg).toContain('gateway ok 1.0ms')
  })

  /** A router that is itself unreachable takes every WAN anchor with it; naming the WAN would point at the wrong hop. */
  test('a gateway outage wins over the WAN outage it causes', () => {
    const verdict = decide({
      status: snapshot({
        ongoingOutages: [
          { scope: 'wan', startedAt: NOW - 450_000, cycles: 15, evidence: ['cloudflare', 'google', 'quad9'] },
          { scope: 'gateway', startedAt: NOW - 90_000, cycles: 3, evidence: ['gateway'] },
        ],
      }),
    })
    expect(verdict.reason).toBe('gateway_outage')
    expect(verdict.msg).toContain('the router, not the line')
  })

  /**
   * Degradation is reported, never paged on. The strict all-anchors-at-zero
   * trigger is what keeps 2026-08-01 09:38:34 — 40–45% loss on all three
   * anchors, clean gateway, healed in ~2 s — out of the alert stream.
   */
  test('heavy but partial loss stays up and says so in the message', () => {
    const verdict = decide({
      status: snapshot({
        lastSamples: samples(NOW - 10_000, [
          {},
          { received: 12, lossPct: 40, medMs: 4.4 },
          { received: 11, lossPct: 45, medMs: 4.83 },
          { received: 12, lossPct: 40, medMs: 9.87 },
        ]),
      }),
    })
    expect(verdict.status).toBe('up')
    expect(verdict.msg).toContain('DEGRADED 45% loss')
  })

  test('a failed speed test is named rather than dropped from the message', () => {
    const verdict = decide({
      status: snapshot({ lastSpeedTest: { ts: NOW - 60_000, ok: false, downloadMbps: null, uploadMbps: null } }),
    })
    expect(verdict.status).toBe('up')
    expect(verdict.msg).toContain('last speed test failed')
  })
})

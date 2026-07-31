import { describe, expect, test } from 'bun:test'
import {
  generateOutages,
  generateProbeBuckets,
  generateRouterSnapshot,
  generateStatus,
  generateVerdicts,
} from './generate'
import { PROBE_CYCLE_MS, rangeToBucket, rangeToWindow } from '../range'

/**
 * The mock is the surface the dashboard is developed against before real data accumulates, so
 * anything it cannot produce is a state the UI will never be built to handle. These tests pin the
 * absences specifically: an omitted bucket, a fully-down bucket, cycles with no vantage, and a
 * coverage figure that is null rather than 0. A mock that quietly went back to emitting a complete
 * grid would let "unmeasured" disappear from the dashboard without a single failing test.
 */

/** Bucket widths every view actually asks for — 900s is the Now sparkline's. */
const FINE_BUCKET_SECONDS = [60, 300, 900, 3_600] as const

function gridBucketCount(from: number, to: number, bucketSeconds: number): number {
  const stepMs = bucketSeconds * 1000
  let count = 0
  for (let start = Math.floor(from / stepMs) * stepMs; start < to; start += stepMs) count++
  return count
}

describe('generateProbeBuckets', () => {
  test('omits buckets outright rather than emitting them zero-valued', () => {
    const { from, to } = rangeToWindow('24h')
    const { buckets } = generateProbeBuckets('cloudflare', from, to, 300)
    const grid = gridBucketCount(from, to, 300)

    expect(buckets.length).toBeLessThan(grid)
    expect(buckets.length).toBeGreaterThan(grid * 0.7)
    // A gap is an ABSENT bucket. A present bucket with `count: 0` would be a measurement claiming
    // nothing happened, which is the lie the omission exists to avoid.
    for (const bucket of buckets) expect(bucket.count).toBeGreaterThan(0)
  })

  test('drops the same buckets for every target — a stopped collector records nothing for any', () => {
    const { from, to } = rangeToWindow('24h')
    const cloudflare = generateProbeBuckets('cloudflare', from, to, 300).buckets.map((b) => b.bucket)
    const quad9 = generateProbeBuckets('quad9', from, to, 300).buckets.map((b) => b.bucket)
    expect(quad9).toEqual(cloudflare)
  })

  test('emits at least one fully-down bucket at every fine bucket width', () => {
    for (const bucketSeconds of FINE_BUCKET_SECONDS) {
      const { from, to } = rangeToWindow(bucketSeconds === 60 ? '1h' : bucketSeconds === 3_600 ? '7d' : '24h')
      const { buckets } = generateProbeBuckets('cloudflare', from, to, bucketSeconds)
      const down = buckets.filter((b) => b.medianMs === null && b.downCycles > 0)
      expect(down.length).toBeGreaterThan(0)
    }
  })

  test('returns a vantage row for exactly the buckets it returns', () => {
    const { from, to } = rangeToWindow('7d')
    const { buckets, vantage } = generateProbeBuckets('cloudflare', from, to, rangeToBucket('7d'))
    const bucketStarts = [...new Set(buckets.map((b) => b.bucket))]
    expect(vantage.map((v) => v.bucket)).toEqual(bucketStarts)
  })

  test('reports cycles with no vantage as unknown, never as on the home line', () => {
    const { from, to } = rangeToWindow('24h')
    const { vantage } = generateProbeBuckets('cloudflare', from, to, 300)

    // The state a real deployment spends its whole pre-vantage history in — and the one the
    // container that dropped `cycle` from the ingest body produced for 106 live cycles.
    const unknown = vantage.filter((v) => v.onHomeLine === 'unknown')
    expect(unknown.length).toBeGreaterThan(0)
    for (const bucket of unknown) {
      expect(bucket.vantageCycles).toBe(0)
      expect(bucket.unknownHomeLineCycles).toBe(bucket.cycles)
    }

    // `all` is the only verdict that claims the whole bucket, and it requires every RECORDED
    // cycle to have said so — not every reporting one.
    for (const bucket of vantage) {
      if (bucket.onHomeLine === 'all') expect(bucket.homeLineCycles).toBe(bucket.cycles)
      expect(bucket.homeLineCycles + bucket.offHomeLineCycles + bucket.unknownHomeLineCycles).toBe(bucket.cycles)
    }
  })

  test('leaves linkMbits empty for Wi-Fi cycles instead of inventing a rate', () => {
    const { from, to } = rangeToWindow('24h')
    const { vantage } = generateProbeBuckets('cloudflare', from, to, 300)
    const wifiOnly = vantage.filter((v) => v.onHomeLine === 'none')
    expect(wifiOnly.length).toBeGreaterThan(0)
    for (const bucket of wifiOnly) {
      expect(bucket.pathClasses).toEqual(['wifi'])
      expect(bucket.linkMbits).toEqual([])
    }
  })
})

describe('generateOutages', () => {
  test('returns a summary whose coverage is well below 100', () => {
    const { from, to } = rangeToWindow('24h')
    const { summary } = generateOutages(from, to)
    expect(summary).not.toBeNull()
    expect(summary?.coveragePct).toBeGreaterThan(60)
    expect(summary?.coveragePct).toBeLessThan(80)
    expect(summary?.recordedCycles).toBeLessThan(summary?.expectedCycles ?? 0)
  })

  test('reports coveragePct as null — never 0 — when the range is shorter than one cycle', () => {
    const { to } = rangeToWindow('24h')
    const { summary } = generateOutages(to, to + PROBE_CYCLE_MS / 4)
    expect(summary?.expectedCycles).toBe(0)
    // 0 would claim a fully-measured window was unmeasured: the same lie, inverted.
    expect(summary?.coveragePct).toBeNull()
  })

  test('never rounds unreported cycles up into `all`', () => {
    const { from, to } = rangeToWindow('7d')
    const { summary } = generateOutages(from, to)
    expect(summary?.unknownHomeLineCycles).toBeGreaterThan(0)
    expect(summary?.onHomeLine).not.toBe('all')
  })
})

describe('generateStatus', () => {
  test('carries a vantage whose three-state onHomeLine agrees with its path class', () => {
    const vantage = generateStatus().vantage
    expect(vantage).not.toBeNull()
    if (vantage?.pathClass === 'wifi') {
      expect(vantage.onHomeLine).toBe(false)
      // No baseT token on a Wi-Fi media line — null, not a plausible number.
      expect(vantage.linkMbit).toBeNull()
    } else {
      expect(vantage?.onHomeLine).toBe(true)
      expect(vantage?.linkMbit).toBe(1000)
    }
  })
})

describe('generateRouterSnapshot', () => {
  test('ages each part independently and derives stale from that age', () => {
    const snapshot = generateRouterSnapshot()
    const parts = [snapshot.line, snapshot.wan, snapshot.lan, snapshot.collectorHost, snapshot.ports]
    for (const part of parts) {
      expect(part).not.toBeNull()
      expect(part?.ageMs).toBe(snapshot.now - (part?.observedAt ?? 0))
      expect(part?.stale).toBe((part?.ageMs ?? 0) > snapshot.staleAfterMs)
    }
    // The case the per-part envelope exists for: no `role: wan` row is written during a WAN
    // outage while the LAN bridge keeps updating.
    expect(snapshot.wan?.stale).toBe(true)
    expect(snapshot.lan?.stale).toBe(false)
  })
})

describe('generateVerdicts', () => {
  test('every verdict cites evidence, and at least one states its uncertainty', () => {
    const { from, to } = rangeToWindow('24h')
    const verdicts = generateVerdicts(from, to)
    expect(verdicts.length).toBeGreaterThan(0)
    for (const verdict of verdicts) expect(verdict.evidence.length).toBeGreaterThan(0)
    expect(verdicts.some((v) => v.uncertainty !== null)).toBe(true)
  })
})

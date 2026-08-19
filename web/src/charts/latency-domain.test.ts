import { describe, expect, test } from 'bun:test'
import type { ChartSeries } from 'basalt-ui/charts'
import { domainMax, type Point } from './latency-band-chart'
import type { ProbeBucket } from '../lib/types'

/**
 * The one piece of this chart the framework does not own.
 *
 * `CartesianChart`'s own `'auto'` domain reads every visible series' `getValue`, and this chart's
 * `getValue` is the MEDIAN — so `'auto'` would size the axis to the medians and clip the p5–p95
 * band and the worst-ping envelope drawn around them, which are most of what the chart is. A
 * render test cannot see that: a clipped mark still renders, just outside the plot rect. So the
 * domain function is tested directly, as a function.
 */

const PRIMARY = 'internet'
const OVERLAY = 'internet-overlay'

function bucket(patch: Partial<ProbeBucket> = {}): ProbeBucket {
  return {
    bucket: 0,
    target: 'cloudflare',
    medianMs: 10,
    p5Ms: 8,
    p95Ms: 20,
    minMs: 7,
    maxMs: 40,
    maxLossPct: 0,
    lossPct: 0,
    downCycles: 0,
    count: 10,
    ...patch,
  }
}

function point(patch: Partial<Point> = {}): Point {
  return { key: '2026-08-18T00:00:00.000Z', bucketStart: 0, bucket: null, vantage: null, overlayMs: null, ...patch }
}

/** Only `key` is read by `domainMax`'s callers; the accessors are never invoked here. */
function series(key: string): ChartSeries<Point> {
  return { key, label: key, color: 'var(--vx-line)', mark: 'line', getValue: () => null }
}

describe('domainMax', () => {
  test('sizes to the ENVELOPE, not the median — the whole reason it exists', () => {
    const data = [point({ bucket: bucket({ medianMs: 10, p95Ms: 20, maxMs: 400 }) })]
    // 400 * 1.15. An `'auto'` domain over `getValue` would have stopped at 11.
    expect(domainMax(data, [series(PRIMARY)], PRIMARY, OVERLAY)).toBeCloseTo(460)
  })

  test('folds the overlay in, so a router faster than the band is not clipped off the bottom', () => {
    const data = [point({ bucket: bucket({ p95Ms: 20, maxMs: 30 }), overlayMs: 900 })]
    expect(domainMax(data, [series(PRIMARY), series(OVERLAY)], PRIMARY, OVERLAY)).toBeCloseTo(1035)
  })

  /** The legend-toggle seam: hiding a series must SHRINK the axis, not leave a gap where its
   * spikes used to be. This is why the domain is a function of `visible` rather than a tuple. */
  test('a hidden series leaves the domain', () => {
    const data = [point({ bucket: bucket({ p95Ms: 20, maxMs: 30 }), overlayMs: 900 })]
    expect(domainMax(data, [series(PRIMARY)], PRIMARY, OVERLAY)).toBeCloseTo(34.5)
    expect(domainMax(data, [series(OVERLAY)], PRIMARY, OVERLAY)).toBeCloseTo(1035)
  })

  /**
   * No visible series, or nothing measured, must still produce a usable domain. A `[0, 0]` domain
   * makes `scaleLinear` map every value to the same pixel and the plot renders as one flat line at
   * the axis — a drawn claim over data nobody has.
   */
  test('an empty window and a fully hidden chart both fall back to the same non-zero floor', () => {
    // 1 ms padded by the same 1.15 every other domain gets — the value matters less than that it
    // is positive and identical across all three ways of having nothing to draw.
    expect(domainMax([point()], [series(PRIMARY)], PRIMARY, OVERLAY)).toBeCloseTo(1.15)
    expect(domainMax([], [], PRIMARY, OVERLAY)).toBeCloseTo(1.15)
    expect(domainMax([point({ bucket: bucket() })], [], PRIMARY, OVERLAY)).toBeCloseTo(1.15)
  })

  /** `p95Ms`/`maxMs` are independently nullable on the row type; a null must be skipped, never
   * coalesced to 0 — that is the fabrication this whole dashboard is built to refuse. */
  test('null band edges are skipped, not read as zero', () => {
    const data = [point({ bucket: bucket({ p95Ms: null, maxMs: null, medianMs: 10 }) })]
    // The empty-window fallback, NOT 10 (the median, which this function deliberately ignores) and
    // NOT 0 (a null coalesced into a reading).
    expect(domainMax(data, [series(PRIMARY)], PRIMARY, OVERLAY)).toBeCloseTo(1.15)
  })
})

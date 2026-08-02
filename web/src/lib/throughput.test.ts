import { describe, expect, test } from 'bun:test'
import { throughputPoints, throughputTotals } from './throughput'
import type { ThroughputBucket } from './types'

const HOUR_MS = 3_600_000
const HOUR_0 = 10 * HOUR_MS
const OPTS = { from: HOUR_0, to: HOUR_0 + 3 * HOUR_MS, bucketSeconds: 3600 } as const

function bucket(patch: Partial<ThroughputBucket> & Pick<ThroughputBucket, 'bucket'>): ThroughputBucket {
  return { inBytes: 0, outBytes: 0, spanMs: 0, intervals: 0, skipped: 0, ...patch }
}

describe('throughputPoints', () => {
  /**
   * The load-bearing arithmetic. A bucket that measured 60 s of an hour carries its bytes over
   * 60 s, not over the hour — dividing by the bucket width would report 1/60th of the true rate,
   * and would do so hardest exactly when the collector was struggling, turning a measurement
   * problem into an apparent traffic collapse.
   */
  test('divides by measured time, not by the bucket width', () => {
    const [point] = throughputPoints([bucket({ bucket: HOUR_0, inBytes: 6_000_000, outBytes: 600_000, spanMs: 60_000, intervals: 2 })], OPTS)
    expect(point?.downBytesPerS).toBe(100_000)
    expect(point?.upBytesPerS).toBe(10_000)
  })

  /** An unmeasured hour and an idle hour look nothing alike on a line and must not look alike on
   * the chart. Null is the chart's hatch; 0 is a bar of height zero. */
  test('a bucket the response never mentioned has no rate, rather than a rate of zero', () => {
    const points = throughputPoints([], OPTS)
    expect(points.length).toBeGreaterThan(0)
    expect(points.every((p) => p.downBytesPerS === null && p.upBytesPerS === null)).toBe(true)
  })

  test('a measured but idle bucket keeps its zero rate', () => {
    const [point] = throughputPoints([bucket({ bucket: HOUR_0, spanMs: 60_000, intervals: 2 })], OPTS)
    expect(point?.downBytesPerS).toBe(0)
    expect(point?.upBytesPerS).toBe(0)
  })

  /** Every interval refused means no measured time at all, so there is no denominator and no rate
   * — but the bucket is still distinct from one that was never reported, via `skipped`. */
  test('a bucket whose every interval was refused has no rate but still reports the refusals', () => {
    const [point] = throughputPoints([bucket({ bucket: HOUR_0, spanMs: 0, intervals: 0, skipped: 4 })], OPTS)
    expect(point?.downBytesPerS).toBeNull()
    expect(point?.skipped).toBe(4)
  })

  test('carries the raw volume alongside the rate', () => {
    const [point] = throughputPoints([bucket({ bucket: HOUR_0, inBytes: 6_000_000, spanMs: 60_000, intervals: 2 })], OPTS)
    expect(point?.downBytes).toBe(6_000_000)
  })

  /** Labels are the chart's band-scale keys and must be unique per bucket — see `lib/axis.ts`. */
  test('every bucket gets a distinct axis label', () => {
    const labels = throughputPoints([], OPTS).map((p) => p.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('throughputTotals', () => {
  test('sums volume across the window and counts what it is based on', () => {
    const points = throughputPoints(
      [
        bucket({ bucket: HOUR_0, inBytes: 1_000, outBytes: 100, spanMs: 30_000, intervals: 1 }),
        bucket({ bucket: HOUR_0 + HOUR_MS, inBytes: 2_000, outBytes: 200, spanMs: 30_000, intervals: 1, skipped: 3 }),
      ],
      OPTS,
    )
    const totals = throughputTotals(points)
    expect(totals).toMatchObject({
      downBytes: 3_000,
      upBytes: 300,
      measuredBuckets: 2,
      skippedBuckets: 1,
    })
    // The third and fourth slots of the window were never reported.
    expect(totals.unmeasuredBuckets).toBeGreaterThan(0)
  })

  test('an empty window totals to zero with nothing measured', () => {
    expect(throughputTotals([])).toEqual({
      downBytes: 0,
      upBytes: 0,
      measuredBuckets: 0,
      skippedBuckets: 0,
      unmeasuredBuckets: 0,
    })
  })
})

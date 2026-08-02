import { describe, expect, test } from 'bun:test'
import { foldPoints } from './throughput-chart'
import { foldSourceIndex } from './fold'
import type { ThroughputPoint } from '../lib/throughput'

function measured(over: Partial<ThroughputPoint> = {}): ThroughputPoint {
  return {
    key: '0',
    label: '0',
    bucketStart: 0,
    downBytesPerS: 1000,
    upBytesPerS: 100,
    downBytes: 60_000,
    upBytes: 6_000,
    spanMs: 60_000,
    intervals: 1,
    skipped: 0,
    ...over,
  }
}

function absent(label: string): ThroughputPoint {
  return {
    key: label,
    label,
    bucketStart: Number(label),
    downBytesPerS: null,
    upBytesPerS: null,
    downBytes: 0,
    upBytes: 0,
    spanMs: 0,
    intervals: 0,
    skipped: 0,
  }
}

function labeled(p: ThroughputPoint, label: string): ThroughputPoint {
  return { ...p, key: label, label, bucketStart: Number(label) }
}

describe('foldPoints', () => {
  /**
   * `spanMs > 0` after summing only requires ONE measured member — a `[measured, absent, absent]`
   * group sums to a positive `spanMs` and a real, non-null rate. That rate is not itself wrong (it
   * is the true rate over the time that WAS measured), but the fold must still carry
   * `unmeasuredMembers` so `MirroredBars` hatches the two-thirds of the column no member measured,
   * rather than drawing a bar that implies the whole width agreed with it.
   */
  test('[measured, absent, absent] carries unmeasuredMembers 2 and keeps the real partial rate', () => {
    const [folded] = foldPoints([labeled(measured(), '0'), absent('1'), absent('2')], 1)
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(2)
    expect(folded?.downBytesPerS).not.toBeNull()
  })

  test('[absent, absent, absent] is wholly unmeasured', () => {
    const [folded] = foldPoints([absent('0'), absent('1'), absent('2')], 1)
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(3)
    expect(folded?.downBytesPerS).toBeNull()
    expect(folded?.upBytesPerS).toBeNull()
  })

  test('[measured, measured, measured] carries unmeasuredMembers 0', () => {
    const [folded] = foldPoints(
      [labeled(measured(), '0'), labeled(measured(), '1'), labeled(measured(), '2')],
      1,
    )
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(0)
  })

  /** The mirror lie: a mostly-measured fold must not report itself wholly unmeasured either. */
  test('a 2-of-3-measured fold does not report itself wholly unmeasured', () => {
    const [folded] = foldPoints([labeled(measured(), '0'), labeled(measured(), '1'), absent('2')], 1)
    expect(folded?.unmeasuredMembers).toBe(1)
    expect(folded?.downBytesPerS).not.toBeNull()
  })

  test('a remainder group (source length not divisible by the group size) still folds every point', () => {
    const points = ['0', '1', '2', '3', '4'].map((l) => labeled(measured(), l))
    // cap 2 -> groupSize ceil(5/2) = 3 -> groups of 3 and 2 (the remainder).
    const folded = foldPoints(points, 2)
    expect(folded).toHaveLength(2)
    expect(folded[0]?.foldedFrom).toBe(3)
    expect(folded[1]?.foldedFrom).toBe(2)
    expect(folded.reduce((sum, f) => sum + f.foldedFrom, 0)).toBe(points.length)
    const index = foldSourceIndex(points, folded)
    expect(points.every((p) => index.has(p.label))).toBe(true)
  })

  /**
   * The additive arithmetic the tooltip's "Measured"/"Understated" rows depend on: bytes, spanMs,
   * intervals and skipped all SUM across the fold, and the folded rate is recomputed from the
   * summed bytes over the summed span — never from averaging the per-point rates, which is the bug
   * `throughputPoints`'s own docblock already records fixing once.
   */
  test('bytes, spanMs, intervals and skipped sum; the rate is recomputed, not averaged', () => {
    const a = labeled(
      measured({ downBytes: 60_000, upBytes: 6_000, spanMs: 60_000, intervals: 1, skipped: 0, downBytesPerS: 1000 }),
      '0',
    )
    // A much faster but much shorter interval — averaging the two per-point rates would land near
    // (1000 + 10000) / 2 = 5500, which is not the rate either interval actually ran at.
    const b = labeled(
      measured({ downBytes: 10_000, upBytes: 1_000, spanMs: 1_000, intervals: 1, skipped: 1, downBytesPerS: 10_000 }),
      '1',
    )
    const [folded] = foldPoints([a, b], 1)
    expect(folded?.downBytes).toBe(70_000)
    expect(folded?.upBytes).toBe(7_000)
    expect(folded?.spanMs).toBe(61_000)
    expect(folded?.intervals).toBe(2)
    expect(folded?.skipped).toBe(1)
    // 70,000 bytes over 61 s, not the mean of the two rates.
    expect(folded?.downBytesPerS).toBeCloseTo(70_000 / 61, 5)
  })

  test('a point count at or under the cap passes through unfolded, one source per point', () => {
    const points = [labeled(measured(), '0'), absent('1')]
    const folded = foldPoints(points, 5)
    expect(folded).toEqual([
      { ...points[0], foldedFrom: 1, unmeasuredMembers: 0 },
      { ...points[1], foldedFrom: 1, unmeasuredMembers: 1 },
    ])
  })

  test('a non-positive cap folds nothing', () => {
    expect(foldPoints([labeled(measured(), '0')], 0)).toEqual([])
  })
})

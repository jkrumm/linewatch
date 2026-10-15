import { describe, expect, test } from 'bun:test'
import { foldBands } from 'basalt-ui/charts'
import { mergePoints, pointRows, THROUGHPUT_SERIES, type PlotPoint } from './throughput-chart'
import type { ThroughputPoint } from '../lib/throughput'

function measured(over: Partial<ThroughputPoint> = {}): PlotPoint {
  return {
    bucketStart: 0,
    downBytesPerS: 1000,
    upBytesPerS: 100,
    downBytes: 60_000,
    upBytes: 6_000,
    spanMs: 60_000,
    intervals: 1,
    skipped: 0,
    foldedFrom: 1,
    unmeasuredMembers: 0,
    ...over,
  }
}

function absent(key: string): PlotPoint {
  return {
    bucketStart: Number(key),
    downBytesPerS: null,
    upBytesPerS: null,
    downBytes: 0,
    upBytes: 0,
    spanMs: 0,
    intervals: 0,
    skipped: 0,
    foldedFrom: 1,
    unmeasuredMembers: 1,
  }
}

function keyed(p: PlotPoint, key: string): PlotPoint {
  return { ...p, bucketStart: Number(key) }
}

/** The real grouping `MirroredBars` runs (`foldBands`, exported from basalt-ui 2.9.0), with this
 * chart's own merge — so a fold test exercises the kind's arithmetic, not a copy of it. */
const fold = (points: PlotPoint[], cap: number) => foldBands(points, cap, mergePoints)

describe('mergePoints, through foldBands', () => {
  /**
   * `spanMs > 0` after summing only requires ONE measured member — a `[measured, absent, absent]`
   * group sums to a positive `spanMs` and a real, non-null rate. That rate is not itself wrong (it
   * is the true rate over the time that WAS measured), but the fold must still carry
   * `unmeasuredMembers` so `MirroredBars` hatches the two-thirds of the column no member measured,
   * rather than drawing a bar that implies the whole width agreed with it.
   */
  test('[measured, absent, absent] carries unmeasuredMembers 2 and keeps the real partial rate', () => {
    const [folded] = fold([keyed(measured(), '0'), absent('1'), absent('2')], 1)
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(2)
    expect(folded?.downBytesPerS).not.toBeNull()
  })

  test('[absent, absent, absent] is wholly unmeasured', () => {
    const [folded] = fold([absent('0'), absent('1'), absent('2')], 1)
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(3)
    expect(folded?.downBytesPerS).toBeNull()
    expect(folded?.upBytesPerS).toBeNull()
  })

  test('[measured, measured, measured] carries unmeasuredMembers 0', () => {
    const [folded] = fold(
      [keyed(measured(), '0'), keyed(measured(), '1'), keyed(measured(), '2')],
      1,
    )
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(0)
  })

  /** The mirror lie: a mostly-measured fold must not report itself wholly unmeasured either. */
  test('a 2-of-3-measured fold does not report itself wholly unmeasured', () => {
    const [folded] = fold([keyed(measured(), '0'), keyed(measured(), '1'), absent('2')], 1)
    expect(folded?.unmeasuredMembers).toBe(1)
    expect(folded?.downBytesPerS).not.toBeNull()
  })

  test('a remainder group (source length not divisible by the group size) still folds every point', () => {
    const points = ['0', '1', '2', '3', '4'].map((l) => keyed(measured(), l))
    // cap 2 -> groupSize ceil(5/2) = 3 -> groups of 3 and 2 (the remainder).
    const folded = fold(points, 2)
    expect(folded).toHaveLength(2)
    expect(folded[0]?.foldedFrom).toBe(3)
    expect(folded[1]?.foldedFrom).toBe(2)
    // Every source point accounted for exactly once — see `availability-strip.test.ts`'s
    // identical assertion for why this stopped going through `foldSourceIndex`.
    expect(folded.reduce((sum, f) => sum + f.foldedFrom, 0)).toBe(points.length)
  })

  /**
   * The additive arithmetic the tooltip's "Measured"/"Understated" rows depend on: bytes, spanMs,
   * intervals and skipped all SUM across the fold, and the folded rate is recomputed from the
   * summed bytes over the summed span — never from averaging the per-point rates, which is the bug
   * `throughputPoints`'s own docblock already records fixing once.
   */
  test('bytes, spanMs, intervals and skipped sum; the rate is recomputed, not averaged', () => {
    const a = keyed(
      measured({
        downBytes: 60_000,
        upBytes: 6_000,
        spanMs: 60_000,
        intervals: 1,
        skipped: 0,
        downBytesPerS: 1000,
      }),
      '0',
    )
    // A much faster but much shorter interval — averaging the two per-point rates would land near
    // (1000 + 10000) / 2 = 5500, which is not the rate either interval actually ran at.
    const b = keyed(
      measured({
        downBytes: 10_000,
        upBytes: 1_000,
        spanMs: 1_000,
        intervals: 1,
        skipped: 1,
        downBytesPerS: 10_000,
      }),
      '1',
    )
    const [folded] = fold([a, b], 1)
    expect(folded?.downBytes).toBe(70_000)
    expect(folded?.upBytes).toBe(7_000)
    expect(folded?.spanMs).toBe(61_000)
    expect(folded?.intervals).toBe(2)
    expect(folded?.skipped).toBe(1)
    // 70,000 bytes over 61 s, not the mean of the two rates.
    expect(folded?.downBytesPerS).toBeCloseTo(70_000 / 61, 5)
  })

  test('a point count at or under the cap passes through unfolded, one source per point', () => {
    const points = [keyed(measured(), '0'), absent('1')]
    expect(fold(points, 5)).toEqual(points)
  })

  test('a non-positive cap folds nothing', () => {
    expect(fold([keyed(measured(), '0')], 0)).toEqual([])
  })
})

describe('pointRows', () => {
  test('a measured point states its basis and nothing about folding', () => {
    expect(pointRows(measured()).map((r) => r.label)).toEqual(['Measured'])
  })

  test('a partial point is named Understated', () => {
    const rows = pointRows(measured({ skipped: 2 }))
    expect(rows.map((r) => r.label)).toEqual(['Measured', 'Understated'])
    expect(rows[1]?.value).toBe('2 intervals unplaceable')
  })

  test('an unmeasured point says so rather than printing a rate', () => {
    expect(pointRows(absent('0'))).toEqual([
      expect.objectContaining({ label: 'Not measured', value: 'no usable interval' }),
    ])
  })

  test('a partial fold names how many of its buckets nothing measured', () => {
    const [folded] = fold([keyed(measured(), '0'), absent('1'), absent('2')], 1)
    expect(pointRows(folded!).find((r) => r.label === 'Folded from')?.value).toBe(
      '3 buckets, 2 not measured',
    )
  })
})

describe('THROUGHPUT_SERIES absent state', () => {
  // `MirroredBars.absentState` paints the unmeasured share in this entry's colour. basalt-ui
  // requires it to differ from every measured series' colour, not only by alpha: the flat
  // `VX.neutral` it replaced sat next to the upload grey.
  test('its colour differs from every measured series', () => {
    const absent = THROUGHPUT_SERIES.find((s) => s.key === 'absent')
    expect(absent).toBeDefined()
    for (const s of THROUGHPUT_SERIES.filter((s) => s.key !== 'absent'))
      expect(absent?.color).not.toBe(s.color)
  })
})

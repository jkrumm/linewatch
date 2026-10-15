import { describe, expect, test } from 'bun:test'
import { outageSpans } from './latency-band-chart'

const MIN = 60_000
const BUCKET = 5 * MIN
const slot = (i: number) => ({ bucketStart: 1_000_000 + i * BUCKET })

/** The outage overlay is clamped to the drawn grid and never skipped: a recorded outage that
 * vanishes from the chart while its tooltip row still names it is the disagreement this pins. */
describe('outageSpans', () => {
  const slots = [slot(0), slot(1), slot(2)]
  const gridStart = slot(0).bucketStart - BUCKET / 2
  const gridEnd = slot(2).bucketStart + BUCKET / 2

  test('an outage inside the grid maps to itself', () => {
    const start = slot(1).bucketStart
    expect(outageSpans(slots, [{ startedAt: start, endedAt: start + MIN }], BUCKET, gridEnd)).toEqual([
      { start, end: start + MIN },
    ])
  })

  test('one that began before the window is clamped to the left edge, not dropped', () => {
    const [span] = outageSpans(slots, [{ startedAt: 0, endedAt: slot(1).bucketStart }], BUCKET, gridEnd)
    expect(span).toEqual({ start: gridStart, end: slot(1).bucketStart })
  })

  test('an ongoing outage runs to the window end, clamped to the grid', () => {
    const [span] = outageSpans(slots, [{ startedAt: slot(1).bucketStart, endedAt: null }], BUCKET, gridEnd + BUCKET)
    expect(span).toEqual({ start: slot(1).bucketStart, end: gridEnd })
  })

  test('a single-slot window still draws the outage inside it', () => {
    const only = [slot(0)]
    const start = slot(0).bucketStart
    expect(outageSpans(only, [{ startedAt: start, endedAt: start + MIN }], BUCKET, start + BUCKET)).toEqual([
      { start, end: start + MIN },
    ])
  })

  test('an outage entirely outside the grid, and an empty grid, draw nothing', () => {
    expect(outageSpans(slots, [{ startedAt: 0, endedAt: MIN }], BUCKET, gridEnd)).toEqual([])
    expect(outageSpans([], [{ startedAt: 0, endedAt: MIN }], BUCKET, gridEnd)).toEqual([])
  })
})

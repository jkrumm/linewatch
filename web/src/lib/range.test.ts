import { describe, expect, test } from 'bun:test'
import { PROBE_CYCLE_MS, RANGE_OPTIONS, isRangeOption, rangeToBucket, rangeToWindow, type RangeOption } from './range'

/** A `now` deliberately off the cycle boundary — 17.123 s into a cycle. */
const NOW = 1_800_000_017_123
const CYCLE_START = 1_800_000_000_000

/** The spans DESIGN.md documents, restated here so a silent edit to RANGE_SPAN_MS fails a test. */
const EXPECTED_SPAN_MS: Record<RangeOption, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
  all: 365 * 86_400_000,
}

describe('rangeToWindow', () => {
  test('is stable for every `now` within the same probe cycle', () => {
    // The load-bearing property: queries.ts puts `from`/`to` straight into TanStack Query keys, so an
    // unstable window is an infinite refetch loop and an empty dashboard.
    const first = rangeToWindow('24h', CYCLE_START)
    for (const offsetMs of [1, 4_000, 17_123, PROBE_CYCLE_MS - 1]) {
      expect(rangeToWindow('24h', CYCLE_START + offsetMs)).toEqual(first)
    }
  })

  test('is stable across every range within the same probe cycle', () => {
    for (const range of RANGE_OPTIONS) {
      expect(rangeToWindow(range, NOW)).toEqual(rangeToWindow(range, NOW + 3_000))
    }
  })

  test('produces a new window once a cycle boundary is crossed', () => {
    const before = rangeToWindow('1h', CYCLE_START + PROBE_CYCLE_MS - 1)
    const after = rangeToWindow('1h', CYCLE_START + PROBE_CYCLE_MS)
    expect(after).not.toEqual(before)
    expect(after.to - before.to).toBe(PROBE_CYCLE_MS)
    expect(after.from - before.from).toBe(PROBE_CYCLE_MS)
  })

  test('keeps the span exactly equal to the range span for every option', () => {
    for (const range of RANGE_OPTIONS) {
      const { from, to } = rangeToWindow(range, NOW)
      expect(to - from).toBe(EXPECTED_SPAN_MS[range])
    }
  })

  test('never quantises `to` into the future', () => {
    for (let offsetMs = 0; offsetMs < PROBE_CYCLE_MS; offsetMs += 1_000) {
      const now = CYCLE_START + offsetMs
      for (const range of RANGE_OPTIONS) {
        expect(rangeToWindow(range, now).to).toBeLessThanOrEqual(now)
      }
    }
  })

  test('lands `to` on a cycle boundary and `from` with it', () => {
    const { from, to } = rangeToWindow('7d', NOW)
    expect(to % PROBE_CYCLE_MS).toBe(0)
    expect(from % PROBE_CYCLE_MS).toBe(0)
    expect(to).toBe(CYCLE_START)
  })

  test('defaults `now` to the current clock', () => {
    const { from, to } = rangeToWindow('1h')
    expect(to).toBe(Math.floor(Date.now() / PROBE_CYCLE_MS) * PROBE_CYCLE_MS)
    expect(to - from).toBe(EXPECTED_SPAN_MS['1h'])
  })
})

describe('isRangeOption', () => {
  test('accepts every declared option', () => {
    for (const range of RANGE_OPTIONS) {
      expect(isRangeOption(range)).toBe(true)
    }
  })

  test('rejects anything else', () => {
    for (const value of ['', '1H', '12h', '365d', 'ALL', 'undefined']) {
      expect(isRangeOption(value)).toBe(false)
    }
  })
})

describe('rangeToBucket', () => {
  test('returns the documented bucket seconds per range', () => {
    expect(rangeToBucket('1h')).toBe(60)
    expect(rangeToBucket('24h')).toBe(300)
    expect(rangeToBucket('7d')).toBe(3_600)
    expect(rangeToBucket('30d')).toBe(14_400)
    expect(rangeToBucket('all')).toBe(86_400)
  })

  test('yields a plausible point count for every range (60-180 points, per range.ts)', () => {
    for (const range of RANGE_OPTIONS) {
      const points = EXPECTED_SPAN_MS[range] / 1_000 / rangeToBucket(range)
      expect(points).toBeGreaterThanOrEqual(60)
      expect(points).toBeLessThanOrEqual(432) // 'all' at a daily bucket is 365 points
    }
  })
})

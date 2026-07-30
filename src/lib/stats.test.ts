import { describe, expect, test } from 'bun:test'
import { median, percentile, stddev } from './stats.js'

describe('percentile', () => {
  test('returns null for an empty array', () => {
    expect(percentile([], 50)).toBeNull()
  })

  test('returns the single value regardless of p', () => {
    expect(percentile([7], 5)).toBe(7)
    expect(percentile([7], 95)).toBe(7)
  })

  test('interpolates between the two middle values for an even-length array', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5)
  })

  test('returns the exact middle value for an odd-length array', () => {
    expect(percentile([1, 2, 3], 50)).toBe(2)
  })

  test('is order-independent (sorts internally)', () => {
    expect(percentile([4, 1, 3, 2], 50)).toBe(2.5)
  })

  test('p0 is the minimum and p100 is the maximum', () => {
    const values = [5, 1, 9, 3, 7]
    expect(percentile(values, 0)).toBe(1)
    expect(percentile(values, 100)).toBe(9)
  })

  test('p5/p95 band on a larger sample', () => {
    const values = Array.from({ length: 21 }, (_, i) => i + 1) // 1..21
    expect(percentile(values, 5)).toBe(2)
    expect(percentile(values, 95)).toBe(20)
  })
})

describe('median', () => {
  test('matches percentile(values, 50)', () => {
    expect(median([10, 2, 8])).toBe(8)
    expect(median([])).toBeNull()
  })
})

describe('stddev', () => {
  test('returns null for an empty array', () => {
    expect(stddev([])).toBeNull()
  })

  test('returns 0 for a single value', () => {
    expect(stddev([42])).toBe(0)
  })

  test('returns 0 for identical values', () => {
    expect(stddev([5, 5, 5, 5])).toBe(0)
  })

  test('computes population stddev for a known set', () => {
    // mean 5, deviations [-2,-1,0,1,2] -> variance 2 -> stddev sqrt(2)
    expect(stddev([3, 4, 5, 6, 7])).toBeCloseTo(Math.sqrt(2), 10)
  })
})

import { describe, expect, test } from 'bun:test'
import { STALE_AFTER_MS, isStale, latestSampleTs } from './freshness'
import { PROBE_CYCLE_MS } from './range'

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0)

describe('isStale', () => {
  test('the threshold is two probe cycles', () => {
    expect(STALE_AFTER_MS).toBe(2 * PROBE_CYCLE_MS)
  })

  test('one missed cycle is not stale — a restarted collector must not cry wolf', () => {
    expect(isStale(NOW - PROBE_CYCLE_MS, NOW)).toBe(false)
    expect(isStale(NOW - (2 * PROBE_CYCLE_MS - 1), NOW)).toBe(false)
  })

  test('two missed cycles is stale, and stays stale', () => {
    expect(isStale(NOW - 2 * PROBE_CYCLE_MS, NOW)).toBe(true)
    expect(isStale(NOW - 3 * 60_000, NOW)).toBe(true)
    expect(isStale(NOW - 3 * 86_400_000, NOW)).toBe(true)
  })

  test('a sample from the future is not stale', () => {
    expect(isStale(NOW + PROBE_CYCLE_MS, NOW)).toBe(false)
  })
})

describe('latestSampleTs', () => {
  test('null when nothing has ever reported — not an age of zero', () => {
    expect(latestSampleTs([])).toBeNull()
  })

  test('takes the newest across targets regardless of array order', () => {
    // One target that stopped reporting months ago must not decide the verdict for the ones still
    // running; `GET /api/status` promises no ordering on `lastSamples`.
    const samples = [{ ts: NOW - 90 * 86_400_000 }, { ts: NOW - PROBE_CYCLE_MS }, { ts: NOW - 3600_000 }]
    expect(latestSampleTs(samples)).toBe(NOW - PROBE_CYCLE_MS)
  })
})

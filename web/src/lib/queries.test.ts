import { describe, expect, test } from 'bun:test'
import { quantiseWindow, sameWindowedQuery, WINDOW_KEY_MAX_STEP_MS, windowKeyStepMs } from './queries'
import { PROBE_CYCLE_MS, RANGE_OPTIONS, rangeToBucket, rangeToWindow } from './range'

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0)

/** Builds a key shaped like `probeBucketsQuery`'s — `[..., from, to]`, the convention
 * `sameWindowedQuery` depends on to find the two positions allowed to differ. */
function probeKey(target: string, bucket: number, window: { from: number; to: number }) {
  return ['probes', target, bucket, window.from, window.to]
}

describe('windowKeyStepMs', () => {
  test('clamps a sub-cycle bucket up to the probe cycle — a key cannot rotate faster than data can change', () => {
    expect(windowKeyStepMs(1)).toBe(PROBE_CYCLE_MS)
  })

  test('passes bucketSeconds*1000 through unclamped in the middle band', () => {
    expect(windowKeyStepMs(100)).toBe(100_000)
  })

  test('clamps a long-range bucket down to the 5-minute ceiling — a day bucket must not leave the key a day stale', () => {
    expect(windowKeyStepMs(86_400)).toBe(WINDOW_KEY_MAX_STEP_MS)
  })

  test.each(RANGE_OPTIONS)('the real RANGE_BUCKET for %s resolves inside [PROBE_CYCLE_MS, WINDOW_KEY_MAX_STEP_MS]', (range) => {
    const step = windowKeyStepMs(rangeToBucket(range))
    expect(step).toBeGreaterThanOrEqual(PROBE_CYCLE_MS)
    expect(step).toBeLessThanOrEqual(WINDOW_KEY_MAX_STEP_MS)
  })
})

describe('quantiseWindow', () => {
  test('preserves the span exactly — `prevFrom = from - (to - from)` in the dashboard depends on this', () => {
    const window = { from: NOW - 86_400_000, to: NOW }
    const span = window.to - window.from
    expect(quantiseWindow(window, 3_600).to - quantiseWindow(window, 3_600).from).toBe(span)
  })

  test('floors `to` onto the step and shifts `from` by the identical delta, not a re-derived one', () => {
    const step = windowKeyStepMs(3_600) // the 5-minute ceiling
    const to = NOW + 1_234 // deliberately off the step boundary
    const from = to - 1_000_000
    const quantised = quantiseWindow({ from, to }, 3_600)
    const expectedTo = Math.floor(to / step) * step
    expect(quantised.to).toBe(expectedTo)
    expect(quantised.from).toBe(from - (to - expectedTo))
  })

  test('a `to` already on the step boundary is returned unchanged', () => {
    const step = windowKeyStepMs(60)
    const to = Math.floor(NOW / step) * step
    const from = to - 3_600_000
    expect(quantiseWindow({ from, to }, 60)).toEqual({ from, to })
  })
})

describe('sameWindowedQuery', () => {
  test('a time advance — same span, same leading params — keeps the previous data', () => {
    const outgoing = probeKey('gateway', 60, { from: 0, to: 3_600_000 })
    const incoming = probeKey('gateway', 60, { from: 300_000, to: 3_900_000 }) // shifted forward, same span
    expect(sameWindowedQuery(incoming, outgoing)).toBe(true)
  })

  /**
   * The case the docblock calls out by name: a genuine range change must never keep rendering the
   * outgoing window's numbers under the new range's label. Every one of the five ranges has a
   * distinct span, so every pairing here is a real span change, not an incidental one.
   */
  test.each(RANGE_OPTIONS)('a range change away from %s never keeps the previous data', (range) => {
    const incoming = probeKey('gateway', 60, rangeToWindow(range, NOW))
    for (const previous of RANGE_OPTIONS) {
      if (previous === range) continue
      const outgoing = probeKey('gateway', 60, rangeToWindow(previous, NOW))
      expect(sameWindowedQuery(incoming, outgoing)).toBe(false)
    }
  })

  test('a minDuration change never keeps the previous data, even at an identical span', () => {
    const outgoing = ['outages', 0, 0, 3_600_000]
    const incoming = ['outages', 60, 300_000, 3_900_000] // same span as outgoing, minDuration differs
    expect(sameWindowedQuery(incoming, outgoing)).toBe(false)
  })

  test('a key of different length never matches', () => {
    expect(sameWindowedQuery(['probes', 'gateway', 0, 1], ['probes', 'gateway', 60, 0, 1])).toBe(false)
  })

  test('a key shorter than 2 positions never matches, even against itself', () => {
    expect(sameWindowedQuery([1], [1])).toBe(false)
  })

  test('non-numeric trailing positions never match — a malformed key gets no placeholder data, never a wrong one', () => {
    expect(sameWindowedQuery(['a', 'x', 'y'], ['a', 'x', 'y'])).toBe(false)
  })
})

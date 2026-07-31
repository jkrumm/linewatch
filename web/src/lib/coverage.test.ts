import { describe, expect, test } from 'bun:test'
import { coverageKind, coverageSinceFirst, fmtCoveragePct } from './coverage'
import type { RangeSummary } from './types'

const TO = Date.UTC(2026, 6, 30, 12, 0, 0)
const FROM = TO - 24 * 3_600_000
/** 24 h at the 30 s cadence — the same arithmetic `src/db/range-summary.ts` does. */
const EXPECTED_CYCLES = 2880

function summary(over: Partial<RangeSummary> = {}): RangeSummary {
  return {
    from: FROM,
    to: TO,
    recordedCycles: 2880,
    expectedCycles: EXPECTED_CYCLES,
    coveragePct: 100,
    firstTs: FROM,
    lastTs: TO,
    degradedCycles: 0,
    degradedLossPct: 20,
    onHomeLine: 'all',
    homeLineCycles: 2880,
    offHomeLineCycles: 0,
    unknownHomeLineCycles: 0,
    ...over,
  }
}

describe('coverageKind', () => {
  test('info only at or above 99%', () => {
    expect(coverageKind(summary({ coveragePct: 100 }))).toBe('info')
    expect(coverageKind(summary({ coveragePct: 99 }))).toBe('info')
    expect(coverageKind(summary({ coveragePct: 98.9 }))).toBe('warn')
  })

  test('bad below 90% — the 34.3%-measured window that prompted this', () => {
    expect(coverageKind(summary({ coveragePct: 90 }))).toBe('warn')
    expect(coverageKind(summary({ coveragePct: 89.9 }))).toBe('bad')
    expect(coverageKind(summary({ coveragePct: 34.3 }))).toBe('bad')
  })

  test('an inexpressible coverage is never the quiet tone', () => {
    expect(coverageKind(summary({ coveragePct: null, expectedCycles: 0 }))).toBe('warn')
  })
})

describe('fmtCoveragePct', () => {
  test('null is the word unknown, never 0', () => {
    expect(fmtCoveragePct(null)).toBe('unknown')
  })

  test('a real share is a percentage', () => {
    expect(fmtCoveragePct(34.28)).toBe('34.3%')
    expect(fmtCoveragePct(0)).toBe('0.0%')
  })
})

describe('coverageSinceFirst', () => {
  test('null when the record starts at or before the window — nothing to restate', () => {
    expect(coverageSinceFirst(summary({ firstTs: FROM }))).toBeNull()
    expect(coverageSinceFirst(summary({ firstTs: FROM - 1 }))).toBeNull()
    expect(coverageSinceFirst(summary({ firstTs: null, recordedCycles: 0 }))).toBeNull()
  })

  test('restates coverage against the stretch that could have been measured', () => {
    // The collector started 6 h into a 24 h window and has recorded every cycle since: a coverage
    // fault would be claimed where none was owed.
    const firstTs = FROM + 6 * 3_600_000
    const recordedCycles = 2160
    const result = coverageSinceFirst(
      summary({ firstTs, recordedCycles, coveragePct: (100 * recordedCycles) / EXPECTED_CYCLES }),
    )
    expect(result).not.toBeNull()
    expect(result?.firstTs).toBe(firstTs)
    expect(result?.expectedCycles).toBe(2160)
    expect(result?.coveragePct).toBe(100)
  })

  test('derives the cadence from the summary, not from a client-side 30 s constant', () => {
    // A server configured at 60 s cadence: 1440 expected cycles over 24 h. Half the window
    // remaining must expect 720, not the 1440 a hardcoded 30 s would produce.
    const result = coverageSinceFirst(
      summary({ expectedCycles: 1440, recordedCycles: 720, firstTs: FROM + 12 * 3_600_000 }),
    )
    expect(result?.expectedCycles).toBe(720)
    expect(result?.coveragePct).toBe(100)
  })

  test('null when no cadence can be derived', () => {
    expect(coverageSinceFirst(summary({ expectedCycles: 0, coveragePct: null, firstTs: FROM + 1000 }))).toBeNull()
  })
})

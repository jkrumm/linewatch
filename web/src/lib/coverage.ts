import type { RangeSummary } from './types'

/** The three `Callout` kinds this reading can take (a subset of basalt-ui's `CalloutKind`). */
export type CoverageKind = 'info' | 'warn' | 'bad'

/** At or above this share of the window measured, the coverage line is a footnote. */
const GOOD_COVERAGE_PCT = 99
/** Below this, the downtime figure above it is describing a minority of the window. */
const BAD_COVERAGE_PCT = 90

/**
 * How loudly the coverage envelope has to speak.
 *
 * `coveragePct === null` is **not** the quiet case. It means the server could not express coverage
 * at all (the window is shorter than one probe cycle, so `expectedCycles` is 0), and an unknown
 * share of a window is not a measured one — rendering it as `info` beside a 99.9% window would put
 * "we don't know" and "we measured it all" in the same tone.
 */
export function coverageKind(summary: RangeSummary): CoverageKind {
  const pct = summary.coveragePct
  if (pct === null) return 'warn'
  if (pct < BAD_COVERAGE_PCT) return 'bad'
  if (pct < GOOD_COVERAGE_PCT) return 'warn'
  return 'info'
}

/**
 * Coverage as text. **`null` is the word "unknown", never `0`** — the server deliberately refuses to
 * emit 0 for an inexpressible coverage (see `RangeSummary.coveragePct`), and printing it as 0%
 * would claim a fully-measured window was never measured: the same lie this envelope exists to
 * prevent, inverted.
 */
export function fmtCoveragePct(pct: number | null): string {
  if (pct === null) return 'unknown'
  return `${pct.toFixed(1)}%`
}

/** Coverage recomputed against the stretch that could actually have been measured. */
export interface MeasuredFrom {
  /** The first cycle on record inside the window — later than `from`. */
  firstTs: number
  /** Cycles the cadence should have produced between `firstTs` and `to`. */
  expectedCycles: number
  /** `recordedCycles` against that. Null when it is not expressible, exactly as on the summary. */
  coveragePct: number | null
}

/**
 * The second percentage a window needs when the record starts inside it.
 *
 * A collector installed (or a database restored) mid-window has nothing to answer for in the part
 * that precedes its first cycle, and reporting 34% coverage there reads as 66% of the window lost.
 * That is its own fabrication — a coverage fault claimed where none was owed. So when
 * `firstTs > from` the reading is restated against `to - firstTs`, and the caller shows both.
 *
 * The cadence is derived from the summary itself (`(to - from) / expectedCycles`) rather than from
 * a client-side constant: the server computed `expectedCycles` with its own configured
 * `probeCycleSeconds`, and a hardcoded 30 s here would silently disagree with it the moment that
 * config changes. Returns null when there is no cadence to derive (`expectedCycles === 0`) or the
 * record does not start late.
 */
export function coverageSinceFirst(summary: RangeSummary): MeasuredFrom | null {
  const { firstTs, from, to, expectedCycles, recordedCycles } = summary
  if (firstTs === null || firstTs <= from) return null
  if (expectedCycles <= 0) return null

  const cycleMs = (to - from) / expectedCycles
  const expectedSince = Math.max(0, Math.round((to - firstTs) / cycleMs))

  return {
    firstTs,
    expectedCycles: expectedSince,
    coveragePct:
      expectedSince === 0 ? null : Math.min(100, (100 * recordedCycles) / expectedSince),
  }
}

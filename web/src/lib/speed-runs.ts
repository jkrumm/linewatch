import type { SpeedTest } from './types'
import { fmtDateTime } from './format'

/** A speed-test run placed on a time axis. `x` is the run's instant as a `Date` (a proportional time
 * scale); see `runTickFormat` for the uniqueness argument. */
export type Run = { test: SpeedTest; x: Date }

export const runX = (r: Run): Date => r.x

/** Oldest first: `GET /api/speedtests` answers newest-first, which is right for a list and
 * backwards for a time axis. */
export const toRuns = (tests: readonly SpeedTest[]): Run[] =>
  tests.toSorted((a, b) => a.ts - b.ts).map((test) => ({ test, x: new Date(test.ts) }))

/** The tooltip header, from the instant and with the clock — `tooltip.label` has no 2.x slot, and a
 * reader comparing this tooltip with three that each name a time to the minute needs to know a run
 * is at 04:10 rather than "sometime on the 19th". */
export const runHeader = (_x: Date, r: Run): string => fmtDateTime(r.test.ts)

/** A series that draws a mark for a lone run. `Lines` joins points and draws nothing for one, so a
 * window holding a single speed test (the 1 h range) read as an empty chart with the figure above
 * it saying "Runs 1". With two or more runs the line carries them, and a dot on each would clutter
 * the 7-day view, so only the lone run gets one. */
export function withLoneRunMarker<S extends object>(
  series: readonly S[],
  runs: number,
): readonly (S & { getMarker?: () => Record<string, never> })[] {
  return runs === 1 ? series.map((s) => ({ ...s, getMarker: () => ({}) })) : series
}

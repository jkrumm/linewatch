import type { ProbeBucketSeconds } from './types'

/** Selectable ranges shared by the Latency and Speed views, per DESIGN.md's "Dashboard" section. */
export const RANGE_OPTIONS = ['1h', '24h', '7d', '30d', 'all'] as const
export type RangeOption = (typeof RANGE_OPTIONS)[number]

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** How far back a range spans. `'all'` reaches back to the collector's earliest plausible data —
 * one year is a safe ceiling since DESIGN.md projects ~4.2M rows/year and rollup is deferred. */
const RANGE_SPAN_MS: Record<RangeOption, number> = {
  '1h': HOUR_MS,
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  all: 365 * DAY_MS,
}

/**
 * Server-side bucket size per range, in SECONDS — `GET /api/probes`'s `bucket` query param is an
 * integer number of seconds (verified against the API's own `/openapi/json`), not a `'1m'|'5m'`
 * label. Keeps a long range cheap per DESIGN.md's "Bucketing happens in SQL" note — chosen so
 * every range renders a comparable point count (roughly 60-180 points).
 */
const RANGE_BUCKET: Record<RangeOption, ProbeBucketSeconds> = {
  '1h': 60,
  '24h': 300,
  '7d': 3_600,
  '30d': 14_400,
  all: 86_400,
}

/**
 * The collector's probe cycle, per DESIGN.md's "Cadence" section. `rangeToWindow` floors `to` onto a
 * multiple of it, so the window it returns is identical for 30 seconds at a time — no finer
 * resolution exists in the data anyway.
 *
 * This quantisation is load-bearing, not cosmetic: `queries.ts` puts the raw `from`/`to` millisecond
 * values directly into the TanStack Query keys. With an unquantised `Date.now()`, any component that
 * both computes the window and holds the `useQuery` gets a new key on every render — data arrives,
 * component re-renders, `to` moves, key changes, refetch, forever. That loop kept three of the four
 * dashboard views permanently empty while they reported plausible-looking zeroes. Do not remove the
 * flooring to "simplify" this.
 */
export const PROBE_CYCLE_MS = 30_000

export function isRangeOption(value: string): value is RangeOption {
  return (RANGE_OPTIONS as readonly string[]).includes(value)
}

export function rangeToWindow(range: RangeOption, now: number = Date.now()): { from: number; to: number } {
  // Floor `to` (never round) so the window never reaches past `now` into data that cannot exist yet,
  // and derive `from` from the floored `to` so both ends are stable and the span stays exact.
  const to = Math.floor(now / PROBE_CYCLE_MS) * PROBE_CYCLE_MS
  return { from: to - RANGE_SPAN_MS[range], to }
}

export function rangeToBucket(range: RangeOption): ProbeBucketSeconds {
  return RANGE_BUCKET[range]
}

export const RANGE_LABEL: Record<RangeOption, string> = {
  '1h': '1h',
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'All',
}

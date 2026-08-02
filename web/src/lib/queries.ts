import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import {
  getEvents,
  getOutages,
  getProbeBuckets,
  getRouter,
  getSpeedTests,
  getStatus,
  getThroughput,
  getVerdicts,
} from './api'
import { PROBE_CYCLE_MS } from './range'
import type { ProbeBucketSeconds, TargetName } from './types'

/**
 * How coarsely a window's `to` is floored before it becomes a query key.
 *
 * `rangeToWindow` floors `to` onto the 30 s probe cycle, which is the finest resolution the data
 * has — and that was the right call for a page that reads the window once. It is the wrong call for
 * this one: `statusQuery` refetches every 30 s, `lastSamples[].ts` really changes each cycle, so the
 * page re-renders on a 30 s heartbeat and recomputes the window each time. The refetch interval and
 * the quantum are the same number, so `to` advanced on essentially every tick, all eleven windowed
 * keys rotated, TanStack Query minted eleven fresh `pending` entries, and the whole windowed half
 * of the page emptied and refilled over ~11 staggered re-renders — under a sticky header.
 *
 * Flooring to the SERVER'S OWN BUCKET SIZE instead means the key rotates only when a genuinely new
 * bucket can exist, capped at five minutes so the long ranges do not rotate on their bucket
 * (a 4-hour or 1-day quantum would leave the newest four hours off the page) and floored at the
 * probe cycle so this can never be coarser than `rangeToWindow` already is.
 *
 * `from` shifts by the same delta rather than being recomputed, so the span stays exact to the
 * millisecond — `prevFrom = from - (to - from)` in the dashboard depends on that.
 *
 * **The cost, stated:** windowed figures can be up to one step (≤5 min) behind wall-clock. The live
 * reading is not: `GET /api/status` is unwindowed, refetches every 30 s, and is what `NowStrip` and
 * the sticky header's status chip draw. The window is history; the strip is now.
 *
 * **The trap this creates, and the one rule that keeps it closed:** the returned `to` is NO LONGER
 * "now". `isStale` (`lib/freshness.ts`) uses a 60 s threshold, so feeding a 5-minute-old `to` to it
 * as `now` computes a negative age and returns false forever — a dead collector's last reading
 * presented as current, which is the exact failure this dashboard exists to notice. Every age,
 * every staleness verdict and every `fmtRelative` must take the 30 s clock (`rangeToWindow(...).to`)
 * and not this one.
 */
export const WINDOW_KEY_MAX_STEP_MS = 300_000

export function windowKeyStepMs(bucketSeconds: ProbeBucketSeconds): number {
  return Math.max(PROBE_CYCLE_MS, Math.min(bucketSeconds * 1000, WINDOW_KEY_MAX_STEP_MS))
}

/**
 * Floor a window's `to` onto the server's own bucket resolution (capped at 5 min) and shift `from`
 * by the same delta, so the span is preserved exactly. `queries.test.ts` pins this: the
 * span-preservation property directly, `windowKeyStepMs`'s clamp at both ends, and
 * `sameWindowedQuery`'s three-way split (time advance keeps, range change doesn't, filter change
 * doesn't) against real `rangeToWindow`-shaped keys — `prevFrom = from - (to - from)` in the
 * dashboard only works because the shift is identical on both ends.
 *
 * The returned `to` is NOT "now" — see `WINDOW_KEY_MAX_STEP_MS`'s docblock for why every age /
 * staleness / `fmtRelative` call must use `rangeToWindow(range).to` (the 30 s clock) instead.
 *
 * **This quantisation reduces key rotation, it does not remove it.** Every windowed query key still
 * rotates once per step (still up to every 30 s on `1h`, since `windowKeyStepMs` floors at
 * `PROBE_CYCLE_MS`), and TanStack Query still mints a fresh `pending` entry for a brand-new key by
 * default — so without more, the page still drops to dashes and skeletons on every step, just less
 * often than the pre-quantisation 30 s heartbeat caused. The obvious next reach, `placeholderData:
 * keepPreviousData` (TanStack Query v5's one-option idiom for "keep showing the outgoing page while
 * the next one loads"), is rejected UNGATED: it does not look at what changed between the old key
 * and the new one, so handing it straight to a windowed query means a genuine range change (`1h` →
 * `24h`, or the outage table's `minDuration` filter) would keep rendering the OUTGOING window's
 * numbers, under the NEW window's label, until the new fetch resolves. Showing a 99.9%-overlapping
 * `24h` window under the same `24h` label while the next 5-minute step lands is honest; showing an
 * hour-old `24h` reading under a `7d` label the reader just selected is exactly the fabrication this
 * codebase exists to refuse elsewhere (`denseSparkline`, `windowDowntime`, `on_home_line`'s
 * three-state null, …) — just moved into the query layer instead of a chart.
 *
 * So `placeholderData` below is GATED: `keepAcrossTimeAdvance` (this file) only forwards the
 * previous result when the previous query's key is the same query at an earlier moment — identical
 * everything except `from`/`to`, and `from`/`to` differing by nothing more than a like-for-like
 * SPAN shift. A range change or a filter change changes what is being asked and gets `undefined`
 * (the ordinary `isPending` skeleton), exactly as it should.
 */
export function quantiseWindow(
  window: { from: number; to: number },
  bucketSeconds: ProbeBucketSeconds,
): { from: number; to: number } {
  const step = windowKeyStepMs(bucketSeconds)
  const to = Math.floor(window.to / step) * step
  return { from: window.from - (window.to - to), to }
}

/**
 * Every windowed query key in this file ends `[..., from, to]` — the convention `keepAcrossTimeAdvance`
 * depends on to find the two positions allowed to differ between "the same query, later" and
 * "a different query". A new windowed query factory that doesn't end its key this way silently gets
 * no placeholder data (this returns `false`, never a wrong answer) rather than a broken one — but it
 * should still follow the convention so its own key rotation gets the same treatment.
 *
 * Compares every OTHER position for exact equality (so a `target`, `bucket`, or `minDuration` change
 * is never mistaken for a time step) and the two time positions for equal SPAN, not equal value —
 * `from`/`to` are expected to differ every time by construction; a genuine range change is what
 * changes the span itself.
 */
export function sameWindowedQuery(currentKey: readonly unknown[], previousKey: readonly unknown[]): boolean {
  if (currentKey.length !== previousKey.length || currentKey.length < 2) return false
  const from = currentKey[currentKey.length - 2]
  const to = currentKey[currentKey.length - 1]
  const prevFrom = previousKey[previousKey.length - 2]
  const prevTo = previousKey[previousKey.length - 1]
  if (typeof from !== 'number' || typeof to !== 'number' || typeof prevFrom !== 'number' || typeof prevTo !== 'number') {
    return false
  }
  if (to - from !== prevTo - prevFrom) return false
  for (let i = 0; i < currentKey.length - 2; i++) {
    if (currentKey[i] !== previousKey[i]) return false
  }
  return true
}

/**
 * `placeholderData` for a windowed query — see `quantiseWindow`'s docblock for why this has to be
 * gated rather than a bare `keepPreviousData`. `previousQuery` is `undefined` on the very first
 * mount of a given key (nothing to carry forward yet), which is also correctly `isPending` at that
 * point.
 */
function keepAcrossTimeAdvance<TData>(
  currentKey: readonly unknown[],
  previousData: TData | undefined,
  previousQuery: { queryKey: readonly unknown[] } | undefined,
): TData | undefined {
  if (previousQuery === undefined) return undefined
  return sameWindowedQuery(currentKey, previousQuery.queryKey) ? keepPreviousData(previousData) : undefined
}

/** `staleTime` matches the collector's 30s probe cycle (DESIGN.md "Cadence") — no point polling
 * faster than new data can exist. */
export const statusQuery = () =>
  queryOptions({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 30_000,
    staleTime: 15_000,
  })

export const probeBucketsQuery = (params: {
  from: number
  to: number
  target: TargetName
  bucket: ProbeBucketSeconds
}) => {
  const queryKey = ['probes', params.target, params.bucket, params.from, params.to]
  return queryOptions({
    queryKey,
    queryFn: () => getProbeBuckets(params),
    staleTime: 60_000,
    placeholderData: (previousData, previousQuery) => keepAcrossTimeAdvance(queryKey, previousData, previousQuery),
  })
}

export const throughputQuery = (params: { from: number; to: number; bucket: ProbeBucketSeconds }) => {
  const queryKey = ['throughput', params.bucket, params.from, params.to]
  return queryOptions({
    queryKey,
    queryFn: () => getThroughput(params),
    staleTime: 60_000,
    placeholderData: (previousData, previousQuery) => keepAcrossTimeAdvance(queryKey, previousData, previousQuery),
  })
}

export const outagesQuery = (params: { from: number; to: number; minDuration?: number }) => {
  // `minDuration` sits BEFORE `from`/`to`, not appended after, so this key ends in `[..., from,
  // to]` like every other windowed key here — the convention `sameWindowedQuery` depends on, and
  // worth keeping true of every entry in this file even where TanStack Query itself doesn't care
  // about key shape.
  const queryKey = ['outages', params.minDuration ?? 0, params.from, params.to]
  return queryOptions({
    queryKey,
    queryFn: () => getOutages(params),
    staleTime: 60_000,
    placeholderData: (previousData, previousQuery) => keepAcrossTimeAdvance(queryKey, previousData, previousQuery),
  })
}

export const speedTestsQuery = (params: { from: number; to: number }) => {
  const queryKey = ['speedtests', params.from, params.to]
  return queryOptions({
    queryKey,
    queryFn: () => getSpeedTests(params),
    staleTime: 60_000,
    placeholderData: (previousData, previousQuery) => keepAcrossTimeAdvance(queryKey, previousData, previousQuery),
  })
}

/** The router poller runs every 10 minutes by default, but this refetches faster than that on
 * purpose: `ageMs`/`stale` are computed server-side at request time, so a cached response keeps
 * claiming the age it had when it was fetched. Staleness has to be the server's verdict, not a
 * client cache's memory of one. */
export const routerQuery = () =>
  queryOptions({
    queryKey: ['router'],
    queryFn: getRouter,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

export const verdictsQuery = (params: { from: number; to: number }) => {
  const queryKey = ['verdicts', params.from, params.to]
  return queryOptions({
    queryKey,
    queryFn: () => getVerdicts(params),
    staleTime: 60_000,
    placeholderData: (previousData, previousQuery) => keepAcrossTimeAdvance(queryKey, previousData, previousQuery),
  })
}

export const eventsQuery = (params: { from: number; to: number }) => {
  const queryKey = ['events', params.from, params.to]
  return queryOptions({
    queryKey,
    queryFn: () => getEvents(params),
    staleTime: 60_000,
    placeholderData: (previousData, previousQuery) => keepAcrossTimeAdvance(queryKey, previousData, previousQuery),
  })
}

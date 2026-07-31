import { PROBE_CYCLE_MS } from './range'

/**
 * How old a reading may be before the dashboard stops presenting it as current.
 *
 * Two probe cycles, not one: a single missed cycle is a restarted collector or a slow ping run, and
 * flagging it would cry wolf every deploy. Two consecutive missed cycles is the collector not
 * reporting, and that is the state this dashboard is least able to notice on its own — the outage
 * state machine only advances when a cycle is *ingested*, so a dead collector opens no outage row
 * and every "is it up" signal derived from outage rows stays green forever.
 */
export const STALE_AFTER_MS = 2 * PROBE_CYCLE_MS

export function isStale(ts: number, now: number): boolean {
  return now - ts >= STALE_AFTER_MS
}

/**
 * The newest timestamp across the per-target samples — i.e. when the collector last reported
 * anything at all. Null when it never has, which is a different state from stale: nothing has been
 * measured yet, so there is no age to report.
 *
 * `Math.max` over the whole array rather than `at(-1)`: `GET /api/status`'s `lastSamples` is one
 * row per target that has ever reported, in no promised order, and a target that stopped reporting
 * months ago would otherwise decide the verdict for the ones still running.
 */
export function latestSampleTs(samples: readonly { ts: number }[]): number | null {
  let latest: number | null = null
  for (const sample of samples) {
    if (latest === null || sample.ts > latest) latest = sample.ts
  }
  return latest
}

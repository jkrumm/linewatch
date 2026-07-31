import type { Outage } from './types'

/**
 * The downtime headline for a window, and its two caveats.
 *
 * `seconds` is the outage time that falls INSIDE the window. `openCount` is how many of the
 * contributing outages are still open, i.e. how many of them make `seconds` a floor rather than a
 * total — an ongoing outage is still growing, so the figure is already out of date when it renders.
 */
export interface WindowDowntime {
  seconds: number
  openCount: number
}

/**
 * Sum outage time over a window, clipped to that window and counting outages that have not ended.
 *
 * Two lies live in the obvious `sum + (o.durationS ?? 0)`, and both were on the screen:
 *
 * 1. **`durationS` is null while an outage is open** — by design; the API only fills it when the
 *    state machine closes the row. Coalescing that to 0 rendered "Total downtime: 0 min" directly
 *    under a red "WAN outage in progress" banner. An open outage's contribution is measured from
 *    its start to now instead, and `openCount` says so out loud.
 * 2. **`GET /api/outages` filters on overlap, not containment**, so an outage that began before
 *    `from` and ran into the window is returned whole. Adding its whole duration credits the window
 *    with downtime that happened before it. Every contribution is clipped to `[from, to]`.
 *
 * `durationS` is not read at all: the ingest writes it as `round((endedAt - startedAt) / 1000)`
 * (`src/services/outage-detector.ts`), so the timestamps carry the same fact and are the only ones
 * that can be clipped. `openCount` counts every open row the server returned for this window rather
 * than only the ones whose clipped overlap is positive — the caller asked for this window, the
 * server answered with rows overlapping it, and an open outage contributing zero measured seconds
 * (it started after the last floored cycle boundary) is still an open outage the reader must know
 * about.
 */
export function windowDowntime(
  outages: readonly Outage[],
  window: { from: number; to: number },
  now: number = Date.now(),
): WindowDowntime {
  let ms = 0
  let openCount = 0

  for (const outage of outages) {
    if (outage.endedAt === null) openCount += 1
    // An open outage runs to now, but never past the window: `to` is a floored clock, so `now` can
    // be up to one probe cycle ahead of it, and counting that overshoot would report downtime in a
    // stretch of time the window does not cover.
    const end = Math.min(outage.endedAt ?? now, window.to)
    const start = Math.max(outage.startedAt, window.from)
    ms += Math.max(0, end - start)
  }

  return { seconds: Math.round(ms / 1000), openCount }
}

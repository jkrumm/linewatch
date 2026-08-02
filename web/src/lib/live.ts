import { WAN_TARGETS, median } from './aggregate'
import type { StatusSample } from './types'

/**
 * The two questions the newest probe cycle actually answers, folded into one shape.
 *
 * The dashboard used to render one tile per target: Gateway, Cloudflare, Google, Quad9, four cards
 * across the full width. Three of those four are the same question asked three times — "can this
 * machine reach the internet" — and answering it three times, side by side, in near-identical
 * numbers, invites the reader to look for a difference that is almost never meaningful. The one
 * split that *is* meaningful is the router: latency to the gateway is on your side of the line and
 * latency to an anchor is past it, and no amount of averaging should blur that.
 *
 * So: two readings. `liveGateway` is one target reported as itself; `liveInternet` is the anchors
 * folded together. They share this type because a tile that renders one must render the other
 * identically — a "reading of 1" is not a special case, it is the degenerate case of the same
 * aggregate, and giving it its own type is how the two tiles drift apart.
 *
 * Per-target numbers are not lost: `samples` carries every constituent, and the Latency section's
 * per-target breakout still draws each anchor's full band separately.
 */
export interface LiveReading {
  /**
   * Median of the constituents' median RTTs, and `null` when none reported one.
   *
   * A median rather than a mean, for the reason `aggregate.median` gives: one badly routed anchor
   * drags a mean of three and leaves no trace of having done so. **A target that did not answer is
   * skipped, never counted as 0** — counting it would report a *faster* internet for a cycle that
   * measured less of it.
   */
  medMs: number | null
  /**
   * The worst loss any constituent reported, and `null` when none reported.
   *
   * The worst rather than the median: this tile's job is to say something is wrong, and a tile
   * showing the middle of {0%, 0%, 100%} says nothing is. The count below is what keeps that from
   * over-claiming — one anchor down out of three is visible as `2 of 3 answering`, not as an
   * internet outage.
   */
  worstLossPct: number | null
  /** Newest constituent timestamp — what the tile's age and staleness are measured from. */
  ts: number | null
  /** How many targets this reading covers, and how many of them the server marked `up`. */
  total: number
  upCount: number
  /** Every constituent sample, so a caller can name the anchors without re-querying. */
  samples: StatusSample[]
}

const NOTHING: LiveReading = { medMs: null, worstLossPct: null, ts: null, total: 0, upCount: 0, samples: [] }

/**
 * Fold a set of samples into one reading.
 *
 * `total` counts the samples that arrived, not the targets that were asked for — the caller cannot
 * distinguish "Quad9 has never reported" from "Quad9 reported nothing this cycle" out of
 * `GET /api/status`, which only returns a row per target that has ever reported at all. So the tile
 * says "2 of 2 answering" rather than inventing a third that the response never mentioned.
 */
function fold(samples: StatusSample[]): LiveReading {
  if (samples.length === 0) return NOTHING

  return {
    medMs: median(samples.map((s) => s.medMs)).value,
    // `lossPct` is non-null on every sample the API returns (a 100%-loss cycle reports 100, not
    // null — it is `medMs` that goes null there), so this needs no absence branch. The `null` in
    // the type is reached only by the no-samples case above.
    worstLossPct: Math.max(...samples.map((s) => s.lossPct)),
    ts: Math.max(...samples.map((s) => s.ts)),
    total: samples.length,
    // `up` is server-derived (`received > 0`); trusted rather than re-derived from `lossPct` here,
    // the same rule the per-target tile followed.
    upCount: samples.filter((s) => s.up).length,
    samples,
  }
}

/** The router: one target, reported as itself. */
export function liveGateway(samples: readonly StatusSample[]): LiveReading {
  return fold(samples.filter((s) => s.target === 'gateway'))
}

/**
 * The internet: the WAN anchors, folded.
 *
 * Membership comes from `WAN_TARGETS` (i.e. `TARGETS` minus the gateway) rather than from a list
 * written here, so adding a fourth anchor puts it in this reading instead of silently leaving it
 * out of the one number the page opens with.
 */
export function liveInternet(samples: readonly StatusSample[]): LiveReading {
  const wan = new Set<string>(WAN_TARGETS)
  return fold(samples.filter((s) => wan.has(s.target)))
}

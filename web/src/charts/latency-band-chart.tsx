// MIGRATION-STUB(w5): the SmokePing-style latency band chart (median line, p5-p95 area, loss markers, outage and vantage rails, overlay)
import { ChartCard, type ChartSeries } from 'basalt-ui/charts'
import type { ReactNode } from 'react'
import type {
  Outage,
  ProbeBucket,
  ProbeBucketSeconds,
  VantageBucket,
} from '../lib/types'

/** One position on the time axis. `bucket === null` is a bucket the range route returned no row
 * for: unmeasured, which the chart must draw as its own state rather than as a gap the curve
 * smooths over. `vantage` is the parallel per-bucket record of what those cycles measured
 * *through* — null when the bucket held no cycles at all. `overlayMs` is the second, band-less
 * median: always present on the point (null when there is no `overlay` prop, or the overlay's own
 * bucket at this slot has none), so the drawing code never has to ask the point "does an overlay
 * exist" separately from "what is its value here". */
export type Point = {
  /**
   * `densifyBuckets`' own ISO-8601 bucket start: the x-scale's domain value and the key this chart
   * broadcasts to the shared cursor. One instant, one identity, shared verbatim with the strips.
   *
   * **It is no longer also what the tooltip header renders.** For one release it was a LOCAL ISO
   * stamp with the offset written out, because `TooltipHeader` regexed `YYYY-MM-DD` out of the key
   * and rebuilt a local `Date` from it — so a UTC key named a different calendar day than the
   * axis, the badge and every sibling on the page for every bucket after 22:00 local. That is
   * `tooltip.formatHeader` in 1.17.0, and rendering is now the only thing formatting does.
   *
   * It used to carry a pre-formatted `label` alongside, because `AxisBottomDate` accepted no
   * `tickFormat` and rendered the domain through `fmtAxisDate`, which reduces an ISO string to
   * `DD.MM` — a 24 h window drew `01.08` a dozen times across the bottom of the page's primary
   * latency chart. A pre-formatted label passed through untouched and was the only way to reach
   * the axis, which is what forced the *display* string to also be the *identity*. `tickFormat`
   * ended that in 1.9.0 and `CartesianChart`'s `formatX` is the higher-level form of it now; see
   * `lib/axis.ts`. The ISO key also earns its keep at the cursor: `useChartCursor` resolves a
   * sibling's broadcast key by parsing it, so an ISO domain is what lets the folded strips below
   * track this chart's 288 unfolded buckets with no index in between.
   */
  key: string
  /** The bucket's own start, unix ms — the tooltip header's date and the outage-overlay's x-map
   * both read this rather than re-deriving it from `key`. */
  bucketStart: number
  bucket: ProbeBucket | null
  vantage: VantageBucket | null
  overlayMs: number | null
}

/**
 * The top of the y domain: the highest thing any VISIBLE series can put on the plot, padded.
 *
 * Not `resolveAxisDomain`'s own `'auto'`, which reads `getValue` — and `getValue` is the MEDIAN.
 * A domain sized to the medians clips the band and the envelope drawn around them, which is most
 * of what this chart is.
 *
 * Exported for `latency-domain.test.ts`: this is the one piece of the collapsed chart that is not
 * the framework's, and whether it clips a spike is not observable in a render test.
 */
export function domainMax(
  data: readonly Point[],
  visible: readonly ChartSeries<Point>[],
  chartKey: string,
  overlayKey: string,
): number {
  const showPrimary = visible.some((s) => s.key === chartKey)
  const showOverlay = visible.some((s) => s.key === overlayKey)
  const values: number[] = []
  for (const p of data) {
    if (showPrimary && p.bucket !== null) {
      for (const v of [p.bucket.p95Ms, p.bucket.maxMs]) if (v !== null) values.push(v)
    }
    if (showOverlay && p.overlayMs !== null) values.push(p.overlayMs)
  }
  const max = values.length > 0 ? Math.max(...values) : 1
  return Math.max(1, max * 1.15)
}

/**
 * The SmokePing-style signature chart (DESIGN.md's "Latency" view): a median line with a shaded
 * p5–p95 band, loss encoded as marker color. Genuinely unique (a band between two arbitrary
 * series, per-point loss markers) so it stays bespoke rather than becoming a shipped kind — but
 * bespoke now means **composing `CartesianChart` and drawing only marks**, not assembling a plot.
 * It is a single cartesian plot with one numeric y axis, which is exactly the shape that primitive
 * owns, so the ~230 lines this file spent on margins, scales, the grid, the axes, the shared
 * cursor, the crosshair, the hover overlay and the tooltip shell are gone. What is left below the
 * render prop is the four marks nothing else on the page draws.
 *
 * The x-domain comes from the requested window, never from the response. Three things this chart
 * used to draw as identical blank space are now three distinct marks: a bucket that was never
 * measured (hatched), a bucket where every cycle lost every packet (bad band), and a bucket
 * measured through something other than the home line (bottom rail).
 *
 * The chart no longer knows what a target is. It used to take `target: TargetName` and derive its
 * title/id straight from `TARGET_LABEL`, which meant it could only ever draw one of the four raw
 * per-target series. It now takes a plain `label` and `chartKey` and draws whatever band it is
 * handed — which is what lets the promoted dashboard view feed it a *folded* series (the three WAN
 * anchors' median-of-medians) instead of a single target, with the same component, unchanged.
 *
 * `overlay` adds a second, band-less median line sharing this chart's y-scale — the router's own
 * RTT drawn over the folded-internet band, so one picture answers "how bad, and is it past the
 * router".
 *
 * **With an overlay the primary takes the accent and the overlay takes the mid grey** — the same
 * ranking `speed-chart` and `throughput-chart` use, and for the same reason: the series the chart
 * is ABOUT should be the most visible thing on it.
 *
 * It took two wrong turns to land there, both worth recording because the symptom pointed away
 * from the cause. The internet band read as washed out next to the router line, so the accent was
 * moved to the router — which made the primary dimmer still. The actual fault was neither
 * assignment: the overlay's `LinePath` hard-coded `stroke={VX.line}` and never read the colour its
 * own legend entry declared, so the router was drawn at 11.1:1 against the panel no matter what
 * this file said, out-shining the accent primary at 7.8:1 the whole time — and once the legend
 * entry stopped saying `VX.line`, the swatch named a colour the mark did not have. Both colours now
 * come from one binding each; `overlay-color.test.ts` pins that they cannot drift apart again.
 *
 * With NO overlay the primary keeps `VX.line`, the bright neutral: there it is the only series on
 * the chart, and a lone neutral metric is supposed to be the bright one.
 */
export function LatencyBandChart(_props: {
  /** How the primary series is named in the legend, tooltip and accessible label. */
  label: string
  /** Stable identity for the cursor/chart id — must be unique per mounted instance. */
  chartKey: string
  buckets: ProbeBucket[]
  vantage: VantageBucket[]
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
  /**
   * True while the probe-buckets queries behind this band are in flight.
   *
   * Forwarded to `CartesianChart`, which hands it to `ChartFrame` — the plot rect is reserved,
   * `ChartPending` renders in place of the marks, the legend is dropped and `aria-busy` is set.
   * Dropping the legend is the part worth naming: it declares "Loss under 20%", "Loss 20% or
   * more" and "Cycles fully down" — an encoding for marks that, while pending, do not exist.
   */
  isPending?: boolean
  /**
   * A second median line drawn over the band, with no band of its own.
   *
   * `buckets` are matched to the primary series' slots by bucket start, through the same
   * `densifyBuckets` pass — never by array index. The two series are sparse in different places
   * (the gateway can answer a cycle in which no anchor did, and the reverse), so index-aligning
   * them would silently plot one series' reading at another's instant.
   */
  overlay?: {
    label: string
    buckets: readonly ProbeBucket[]
  }
  /**
   * Extra tooltip rows the caller supplies for a bucket it knows more about than this chart does.
   *
   * The dashboard feeds this chart a *folded* series — the three WAN anchors' median-of-medians —
   * whose buckets carry two facts a `ProbeBucket` has no field for: how many anchors the fold was
   * taken over, and the worst loss any single one of them reported. Both are exactly what a reader
   * needs in order not to misread the band: a one-anchor median and a three-anchor median are
   * different claims, and an internet-wide loss of 0% alongside one dead anchor is two separate
   * pieces of news. The chart cannot know either, so the caller states them, in its own words, on
   * the row that draws them.
   *
   * Called only for a measured bucket — an unmeasured slot has nothing extra to say, and a
   * supplementary row under "Not measured" would imply otherwise.
   */
  renderExtraTooltipRows?: (bucket: ProbeBucket) => ReactNode
  /**
   * Recorded outages to overlay, already scoped to this chart's own subject by the caller.
   *
   * The chart deliberately does not know what a target is (see the component docblock), so it
   * cannot decide whether an `Outage` with `scope: 'gateway'` belongs over the band it is drawing.
   * Drawing a gateway outage across the internet band would assert something the row does not say,
   * so the caller filters by scope and this draws whatever it is handed. Rows are expected to be
   * `GET /api/outages`'s OVERLAP result — an outage that began before `from` arrives whole, which is
   * why both edges are clamped to the plot rather than skipped.
   */
  outages?: readonly Outage[] | undefined
}) {
  return <ChartCard state={{ empty: 'Migrating to basalt-ui 2.0' }} />
}

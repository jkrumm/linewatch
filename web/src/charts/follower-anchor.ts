import type { CursorAnchor } from 'basalt-ui/charts'
import { useInViewport } from './use-in-viewport'

/**
 * Where a hand-composed chart's tooltip goes, source or follower.
 *
 * `CartesianChart` grew this in basalt-ui 1.18.0 as `tooltip.onFollow`: a chart renders its own
 * tooltip when the crosshair came from a SIBLING, anchored to that crosshair because there is no
 * pointer over it to track. The three charts here that compose `ChartFrame` by hand
 * (`availability-strip`, `link-speed-strip`, `throughput-chart` — each waiving
 * `basalt/hand-rolled-plot` per assembly node, with the argument in the assembling component's
 * docblock) get no prop for it: they own their own `<svg>`, their own `Crosshair` and their own
 * `ChartTooltipFloat`, so they have to do the same arithmetic themselves. This is that arithmetic,
 * in one place rather than three, and it deliberately reproduces `CartesianChart`'s — a page where
 * four tooltips appear on one cursor and one of them sits somewhere else is worse than none.
 *
 * **Why the page wants this at all.** Before 1.15.0 this directory carried `charts/synced-tip.tsx`,
 * which drew a value chip on every synced sibling. The chart rebuild deleted `ChartTooltip` and
 * shipped source-only tooltips, so hovering a latency spike moved a bare vertical line across four
 * charts and put numbers on exactly one — the reader got the position and not the reading, which is
 * the half they hovered for.
 *
 * **The source path is unchanged and is not the anchored one.** A source chart tracks the pointer
 * (`cursor.anchor`), matching what these three have always done; only `latency-band-chart` anchors
 * as a source, deliberately, because three charts share its column. That asymmetry is the
 * framework's own: `follow` governs the source, `onFollow` governs the follower, and they only
 * interact in that a follower always anchors.
 *
 * Returns `null` when this chart should render no tooltip at all — no resolved point, the `<svg>`
 * not yet mounted, or the chart off screen (see `useInViewport` for why that last one is not
 * optional) — which `ChartTooltipFloat` already treats as "not shown".
 */
export function tooltipAnchor({
  isSource,
  inView,
  ownAnchor,
  svg,
  marginLeft,
  crosshairX,
}: {
  isSource: boolean
  /** `useInViewport` on this chart's own `<svg>`. A follower off screen renders nothing. */
  inView: boolean
  /** `cursor.anchor` — the viewport pointer position, non-null only while this chart is hovered. */
  ownAnchor: CursorAnchor | null
  svg: SVGSVGElement | null
  /** The plot's left inset, i.e. the translate the crosshair is drawn inside. */
  marginLeft: number
  /** The crosshair's plot-local x, or null when no point is resolved. */
  crosshairX: number | null
}): CursorAnchor | null {
  if (isSource) return ownAnchor
  if (!inView || crosshairX === null || svg === null) return null

  // Read at render time, exactly as `CartesianChart` does. This is the cost the framework documents
  // for `onFollow` and the reason it is opt-in per chart: one `getBoundingClientRect` per follower
  // per hovered frame. It is affordable here because the cursor's BROADCAST is deduped — a scrub
  // inside one column changes no key, so siblings do not re-render and no rect is read.
  const rect = svg.getBoundingClientRect()
  return { x: rect.left + marginLeft + crosshairX, y: rect.top }
}

/**
 * The whole follower-tooltip wiring for a chart that composes `ChartFrame` by hand.
 *
 * Three charts here do (`availability-strip`, `link-speed-strip`, `throughput-chart`), and they had
 * three byte-identical copies of it: the `<svg>` ref, the viewport gate, the `tooltipAnchor` call
 * and the `aria-live` split. `tooltipAnchor` above had already been extracted "in one place rather
 * than three" and the React plumbing around it was still tripled — which is the copy that matters,
 * because the two easy-to-ship-broken halves of this policy both live in the plumbing.
 *
 * Returns the ref to put on the `<svg>` and the two props `ChartTooltipFloat` needs. Call it above
 * the width/emptiness early-return these charts all have: `useInViewport` tracks the NODE, so an
 * `<svg>` that mounts later is picked up, but the hook itself still has to run every render.
 */
export function useFollowerTooltip({
  isSource,
  ownAnchor,
  marginLeft,
  crosshairX,
}: {
  isSource: boolean
  ownAnchor: CursorAnchor | null
  marginLeft: number
  crosshairX: number | null
}): { svgRef: (node: SVGSVGElement | null) => void; anchor: CursorAnchor | null; ariaLive: boolean } {
  const { ref, node, inView } = useInViewport<SVGSVGElement>()
  return {
    svgRef: ref,
    anchor: tooltipAnchor({ isSource, inView, ownAnchor, svg: node, marginLeft, crosshairX }),
    // Followers stay silent. `ChartTooltipFloat` is `aria-live` by default, which is right for the
    // one tooltip a pointer produced and wrong for the three that appear beside it — four live
    // regions announcing on every cursor move makes the page unusable with a screen reader. Same
    // split `CartesianChart` makes for `onFollow`; a hand-composed chart has to make it itself.
    ariaLive: isSource,
  }
}

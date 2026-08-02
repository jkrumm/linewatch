import type { CSSProperties, ReactNode, RefObject } from 'react'
import { ChartTooltip } from 'basalt-ui/charts'

/**
 * The tooltip a chart shows when another chart owns the cursor.
 *
 * Four charts on this page now share one hover key, and the question "what does a chart that is not
 * being hovered show" has no shipped answer beyond `MultiLine`'s policy of crosshair-and-dot only.
 * Crosshair-only is not enough here: the whole reason these four are synced is to read one instant
 * across four measurements, and a cursor with no number attached makes the reader hover each chart
 * in turn, which is the manual eyeball the sync exists to remove.
 *
 * Three rules keep N followers from fighting for the pointer. It is anchored to its OWN plot's
 * crosshair, never to the mouse — so followers cannot stack on one another. It carries no
 * `TooltipHeader`: the chart the reader is actually pointing at already shows the instant, and four
 * copies of the same date card is noise, so a follower is a value chip. And it renders `null` when
 * its chart draws nothing at that key — a chart with no reading there says nothing at all rather
 * than "—", which would assert a measured absence.
 *
 * `ChartTooltip` reads `tip.x`/`tip.y` as VIEWPORT coordinates onto a `position: fixed` div, and a
 * synced chart has no event to derive them from, so they are computed from the svg's own rect. That
 * means the follower drifts if the page scrolls mid-hover; hovering implies a still pointer, and the
 * cost of a scroll listener per follower is not worth closing that.
 *
 * `tooltipRef` is deliberately NOT forwarded. That ref is the single measurement node
 * `useChartTooltip.show` uses for viewport flipping, and a second consumer breaks it.
 */
export function SyncedTip({
  svgRef,
  x,
  styles,
  children,
}: {
  svgRef: RefObject<SVGSVGElement | null>
  /** This chart's crosshair position, in its own SVG-viewport px (margin/gutter already added). */
  x: number
  styles: CSSProperties
  children: ReactNode
}) {
  const rect = svgRef.current?.getBoundingClientRect()
  if (rect === undefined) return null
  return (
    <ChartTooltip tip={{ x: rect.left + x + 12, y: rect.top + 8 }} styles={styles}>
      {children}
    </ChartTooltip>
  )
}

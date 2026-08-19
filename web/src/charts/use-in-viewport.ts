import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

/**
 * Whether an element is currently on screen — the gate on every follower tooltip.
 *
 * `tooltip.onFollow` renders a chart's tooltip when the cursor came from a sibling, which is what
 * this page wants: four measurements of one instant, read at once. What it does not account for is
 * that a follower can be nowhere near the viewport. `ChartTooltipFloat` keeps a tooltip inside the
 * window, so a chart 400 px below the fold does not quietly render its tooltip off screen — it
 * renders it *clamped into view*, on top of the tooltip belonging to a chart the reader is actually
 * looking at. Measured on this page: hovering the latency band drew the Throughput tooltip (chart
 * top at y=1501, viewport 1100) at y=997, directly over the Speed tooltip at y=1015.
 *
 * So the rule is the obvious one — a chart nobody can see does not get a tooltip — and it has to be
 * a *state* rather than a rect read at render time, because the three charts on a framework kind
 * take `onFollow` as a prop and need the answer before they render.
 *
 * Starts `true` and lets the observer correct it on the first frame. The opposite default would
 * suppress a legitimately visible chart's tooltip for one frame, and there is no cursor to render
 * against on mount anyway; under `renderToStaticMarkup` there is no observer and no tooltip either.
 */
export function useInViewport(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (el === null || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) setInView(entry.isIntersecting)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return inView
}

import { useEffect, useState } from 'react'

export type InViewport<T extends Element> = {
  /** Attach to the element whose visibility decides the tooltip. */
  ref: (node: T | null) => void
  /** The attached node, for a caller that also needs to measure it. */
  node: T | null
  inView: boolean
}

/**
 * Whether an element is currently on screen — the gate on every follower tooltip.
 *
 * `tooltip.onFollow` renders a chart's tooltip when the cursor came from a sibling, which is what
 * this page wants: four measurements of one instant, read at once. What it does not account for is
 * that a follower can be nowhere near the viewport. `ChartTooltipFloat` keeps a tooltip inside the
 * window, so a chart 400px below the fold does not quietly render its tooltip off screen — it
 * renders it *clamped into view*, on top of the tooltip belonging to a chart the reader is actually
 * looking at. Measured on this page: hovering the latency band drew the Throughput tooltip (chart
 * top at y=1501, viewport 1100) at y=997, directly over the Speed tooltip at y=1015.
 *
 * So the rule is the obvious one — a chart nobody can see does not get a tooltip — and it has to be
 * a *state* rather than a rect read at render time, because the three charts on a framework kind
 * take `onFollow` as a prop and need the answer before they render.
 *
 * **It tracks the NODE, not a ref object, and that distinction is the whole hook.** The first
 * version took a `RefObject` and observed `ref.current` in an effect keyed on `[ref]`. A ref
 * object's identity never changes, so that effect runs exactly once — on the owning component's
 * mount — and if the element is not in the tree at that moment it is never observed and `inView`
 * stays at its initial `true` forever. That is not a corner: all three hand-composed charts return
 * `null` before rendering their `<svg>` when the plot is too narrow or has no columns yet, both of
 * which resolve later (a range change that brings data, a section expanding, a window resize). The
 * chart would then be permanently exempt from the very gate this hook exists to apply, which shows
 * up as the clamped-tooltip defect above rather than as anything obviously broken. Keying on the
 * node makes attach and detach the same event.
 *
 * Starts `true` and lets the observer correct it on the first frame. The opposite default would
 * suppress a legitimately visible chart's tooltip for one frame, and there is no cursor to render
 * against on mount anyway; under `renderToStaticMarkup` there is no observer and no tooltip either.
 */
export function useInViewport<T extends Element>(): InViewport<T> {
  const [node, setNode] = useState<T | null>(null)
  const [inView, setInView] = useState(true)

  useEffect(() => {
    if (node === null || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) setInView(entry.isIntersecting)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  return { ref: setNode, node, inView }
}

import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * The hover-capture rect, on pointer events instead of mouse events.
 *
 * basalt ships `HoverOverlay`, and it is `onMouseMove`/`onMouseLeave` — so on a phone every tooltip
 * on this page was dark, including the rows that are the only place a fact is stated at all
 * ("0 of 120 expected cycles", "Cycles fully down", the fold's anchor count). Pointer events cover
 * mouse, touch and pen with no branching, and `React.PointerEvent` extends `React.MouseEvent`, so
 * `useHoverSync`'s `handleMouse` takes one unchanged.
 *
 * Leave is deliberately NOT symmetric. On touch, `pointerleave` fires when the finger lifts — so
 * dismissing on it would close the tooltip at the exact moment the reader started reading it. Mouse
 * leaves dismiss; a touch is dismissed by the next tap outside the chart, which is what the document
 * listener below is for. A sticky tooltip with no way to close it is worse than none, so that
 * listener is not optional.
 */
export function PointerOverlay({
  width,
  height,
  onMove,
  onLeave,
  active,
}: {
  width: number
  height: number
  onMove: (event: ReactPointerEvent<SVGRectElement>) => void
  onLeave: () => void
  /** Whether a tooltip is currently open — gates the tap-outside listener so it costs nothing at rest. */
  active: boolean
}) {
  const rectRef = useRef<SVGRectElement | null>(null)

  useEffect(() => {
    if (!active) return
    const dismiss = (event: PointerEvent) => {
      const svg = rectRef.current?.ownerSVGElement
      if (svg === null || svg === undefined) return
      if (event.target instanceof Node && svg.contains(event.target)) return
      onLeave()
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [active, onLeave])

  return (
    <rect
      ref={rectRef}
      width={width}
      height={height}
      fill="transparent"
      style={{ cursor: 'pointer' }}
      onPointerMove={onMove}
      onPointerLeave={(event) => {
        // See the docblock: only a mouse leaving means "stop showing this".
        if (event.pointerType === 'mouse') onLeave()
      }}
    />
  )
}

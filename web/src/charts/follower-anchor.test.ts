import { describe, expect, test } from 'bun:test'
import { tooltipAnchor } from './follower-anchor'

/** A `<svg>` stand-in: `tooltipAnchor` reads exactly one thing off the node. */
const svgAt = (left: number, top: number) =>
  ({ getBoundingClientRect: () => ({ left, top }) }) as unknown as SVGSVGElement

const BASE = {
  isSource: false,
  inView: true,
  ownAnchor: { x: 900, y: 900 },
  svg: svgAt(100, 200),
  marginLeft: 56,
  crosshairX: 40,
} as const

/**
 * Where a hand-composed chart's tooltip goes — the arithmetic behind every follower tooltip on the
 * page, and the one part of this policy that is a pure function rather than React plumbing.
 *
 * These are the tests `charts/follower-tooltip.test.ts` cannot be: a follower state needs a live
 * cursor from a SIBLING chart, so nothing about it is reachable through `renderToStaticMarkup`.
 * Pulling the decision out of the components is what makes it testable at all.
 */
describe('tooltipAnchor', () => {
  test('a source chart tracks the pointer, whatever else is true', () => {
    // Every follower guard is failing here — off screen, no point, no node. A source is unaffected:
    // `follow` governs the source and `onFollow` the follower, and they only meet in that a
    // follower always anchors.
    expect(
      tooltipAnchor({ ...BASE, isSource: true, inView: false, svg: null, crosshairX: null }),
    ).toEqual({ x: 900, y: 900 })
  })

  test('a source with no pointer over it shows nothing', () => {
    expect(tooltipAnchor({ ...BASE, isSource: true, ownAnchor: null })).toBeNull()
  })

  test('a follower anchors to its own crosshair, not the pointer', () => {
    // svg.left 100 + marginLeft 56 + crosshairX 40. Never `ownAnchor`, which is over the chart the
    // reader is hovering and would stack four tooltips on one spot.
    expect(tooltipAnchor(BASE)).toEqual({ x: 196, y: 200 })
  })

  /**
   * The defect this gate exists for: `ChartTooltipFloat` keeps a tooltip inside the window, so an
   * off-screen follower does not render out of sight — it renders CLAMPED INTO VIEW, over a
   * tooltip the reader is looking at.
   */
  test('a follower off screen renders nothing', () => {
    expect(tooltipAnchor({ ...BASE, inView: false })).toBeNull()
  })

  test('a follower with no resolved point renders nothing', () => {
    expect(tooltipAnchor({ ...BASE, crosshairX: null })).toBeNull()
  })

  test('a follower whose svg has not mounted renders nothing', () => {
    expect(tooltipAnchor({ ...BASE, svg: null })).toBeNull()
  })

  test('a follower ignores the pointer anchor entirely', () => {
    // A stale `ownAnchor` from this chart's own last hover must not leak into a follower render.
    expect(tooltipAnchor({ ...BASE, ownAnchor: { x: 1, y: 1 } })).toEqual({ x: 196, y: 200 })
  })

  test('the anchor tracks the plot inset, so a chart with a wider gutter is not offset', () => {
    expect(tooltipAnchor({ ...BASE, marginLeft: 0 })).toEqual({ x: 140, y: 200 })
  })
})

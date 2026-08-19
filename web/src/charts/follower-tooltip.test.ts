import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const HAND_COMPOSED = ['availability-strip', 'link-speed-strip', 'throughput-chart'] as const
const FRAMEWORK = ['latency-band-chart', 'speed-chart', 'bufferbloat-chart'] as const

const read = (name: string, ext = 'tsx') =>
  readFileSync(new URL(`./${name}.${ext}`, import.meta.url), 'utf8')
/** Comments stripped, so a docblock naming the old behaviour does not itself satisfy the check. */
const code = (name: string, ext?: string) =>
  read(name, ext)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

/**
 * Every chart on the page cursor renders a tooltip, and only the source announces one.
 *
 * `tooltip.onFollow` (basalt-ui 1.18.0) is the shipped answer for the three charts on a framework
 * kind; the three that compose `ChartFrame` by hand own their own `<svg>`, `Crosshair` and
 * `ChartTooltipFloat`, and route the same policy through `useFollowerTooltip`.
 *
 * **What is worth pinning is the two halves that ship broken by default**, because nothing renders
 * differently either way and no gate catches either one:
 *
 *  - `ChartTooltipFloat` is `aria-live` by default, which is right for the one tooltip a pointer
 *    produced and wrong for the three beside it. The first working version of this had all four
 *    announcing on every cursor move.
 *  - `ChartTooltipFloat` keeps a tooltip inside the window, so an unconditional `onFollow` makes an
 *    off-screen chart render its tooltip CLAMPED INTO VIEW, over one the reader is looking at.
 *
 * **These are source assertions, and that is a real cost, taken deliberately.** A follower state
 * needs a live cursor broadcast from a SIBLING chart, and `renderToStaticMarkup` produces neither
 * the cursor nor the sibling — there is no render path to assert against. So this file pins the
 * WIRING and `follower-anchor.test.ts` pins the DECISION as a pure function, which is where the
 * arithmetic and all four guard clauses actually live. The cost is that a rename breaks these
 * without anything being wrong; the mitigation is that the policy now has ONE implementation
 * (`useFollowerTooltip`) rather than three, so what each chart has to be checked for is a single
 * call rather than four hand-copied lines.
 */
describe('follower tooltips', () => {
  test('the policy has one implementation, and it carries both defaults', () => {
    const seam = code('follower-anchor', 'ts')
    // The aria-live split, in the one place all three hand-composed charts read it from.
    expect(seam).toContain('ariaLive: isSource')
    expect(seam).toContain('useInViewport<SVGSVGElement>()')
  })

  test.each(FRAMEWORK)('%s opts into onFollow, gated on being on screen', (name) => {
    // `onFollow: true` is the regression, not the fix — see the viewport half above.
    expect(code(name)).toContain('onFollow: inView')
    expect(code(name)).toContain('useInViewport<HTMLDivElement>()')
  })

  test.each(HAND_COMPOSED)('%s routes its tooltip through the shared hook', (name) => {
    const src = code(name)
    expect(src).toContain('useFollowerTooltip({')
    expect(src).toContain('<ChartTooltipFloat anchor={tipAnchor} ariaLive={ariaLive}>')
    // The source-only anchor this replaced: a follower resolved a point, drew a crosshair, and was
    // handed a null anchor, so it painted a line and no numbers.
    expect(src).not.toContain('anchor={cursor.isSource ? cursor.anchor : null}')
    // And the hand-copied version that replaced THAT, which is what tripled the policy.
    expect(src).not.toContain('ariaLive={cursor.isSource}')
  })
})

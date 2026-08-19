import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const HAND_COMPOSED = ['availability-strip', 'link-speed-strip', 'throughput-chart'] as const
const FRAMEWORK = ['latency-band-chart', 'speed-chart', 'bufferbloat-chart'] as const

const read = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8')
/** Comments stripped, so a docblock naming the old behaviour does not satisfy the check. */
const code = (name: string) =>
  read(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

/**
 * Every chart on the page cursor renders a tooltip, and only the source announces one.
 *
 * Two halves of one rule, and the second is the kind that ships broken because nobody sees it.
 *
 * **The tooltip.** basalt-ui 1.15.0 made tooltips source-only, which deleted this directory's
 * `charts/synced-tip.tsx` and left the page hovering a bare vertical line across four charts with
 * numbers on exactly one — the position without the reading. `tooltip.onFollow` (1.18.0) is the
 * shipped answer for the three charts on a framework kind; the three that compose `ChartFrame` by
 * hand own their own `<svg>`, `Crosshair` and `ChartTooltipFloat`, so they reproduce it through
 * `tooltipAnchor`.
 *
 * **The `aria-live`.** `ChartTooltipFloat` announces by default, which is right for the one tooltip
 * a pointer produced and wrong for the three beside it: four live regions firing on every cursor
 * move makes the page unusable with a screen reader. `CartesianChart` makes that split itself for
 * `onFollow`; a hand-composed chart has to pass `ariaLive={cursor.isSource}` and silently does not
 * by default. Nothing renders differently either way, no gate catches it, and the first shipped
 * version of this change had all three followers announcing.
 *
 * Source tests on purpose: a follower state needs a live cursor from a SIBLING chart, and
 * `renderToStaticMarkup` produces neither the cursor nor the sibling.
 */
describe('follower tooltips', () => {
  test.each(FRAMEWORK)('%s opts into onFollow, gated on being on screen', (name) => {
    // `onFollow: true` is the regression, not the fix. `ChartTooltipFloat` keeps a tooltip inside
    // the window, so an unconditional opt-in makes an off-screen chart render its tooltip CLAMPED
    // INTO VIEW, on top of one the reader is actually looking at. See `useInViewport`.
    expect(code(name)).toContain('onFollow: inView')
    expect(code(name)).toContain('useInViewport(')
  })

  test.each(HAND_COMPOSED)('%s is gated on being on screen too', (name) => {
    expect(code(name)).toContain('useInViewport(')
    expect(code(name)).toContain('inView,')
  })

  test.each(HAND_COMPOSED)('%s positions its tooltip through the shared helper', (name) => {
    const src = code(name)
    expect(src).toContain('tooltipAnchor({')
    // The source-only anchor this replaced: a follower resolved a point, drew a crosshair, and was
    // handed a null anchor, so it painted a line and no numbers.
    expect(src).not.toContain('anchor={cursor.isSource ? cursor.anchor : null}')
  })

  test.each(HAND_COMPOSED)('%s announces only as the cursor source', (name) => {
    expect(code(name)).toContain('ariaLive={cursor.isSource}')
  })
})

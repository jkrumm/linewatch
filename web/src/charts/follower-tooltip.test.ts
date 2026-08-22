import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/** Every chart on the page cursor. Since basalt-ui 1.23.0 all six sit on a shipped kind — the two
 * strips on `BandStrip`, the throughput bars on `MirroredBars`, the other three on
 * `CartesianChart`/`MultiLine` — so all six reach the follower policy through the same prop. */
const ON_THE_CURSOR = [
  'availability-strip',
  'link-speed-strip',
  'throughput-chart',
  'latency-band-chart',
  'speed-chart',
  'bufferbloat-chart',
] as const

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
 * `tooltip.onFollow` (basalt-ui 1.18.0) is the shipped answer, and the `aria-live` half comes with
 * it — a kind gives the live region to the cursor SOURCE alone, so nothing here has to. **What the
 * framework still does not own is the viewport gate**, and that is the half worth pinning:
 * `ChartTooltipFloat` keeps a tooltip inside the window, so an unconditional `onFollow: true` makes
 * an off-screen chart render its tooltip CLAMPED INTO VIEW, over one the reader is looking at.
 * Measured on this page: hovering the latency band drew the Throughput tooltip (chart top at
 * y=1501, viewport 1100) at y=997, directly over Speed's at y=1015.
 *
 * **These are source assertions, and that is a real cost, taken deliberately.** A follower state
 * needs a live cursor broadcast from a SIBLING chart, and `renderToStaticMarkup` produces neither
 * the cursor nor the sibling — there is no render path to assert against.
 *
 * Three charts used to compose `ChartFrame` by hand and reproduce the whole policy through
 * `charts/follower-anchor.ts` — the anchor arithmetic, the `<svg>` ref and the `aria-live` split.
 * `BandStrip`/`MirroredBars` own all three now; the file and its tests are deleted.
 */
describe('follower tooltips', () => {
  test.each(ON_THE_CURSOR)('%s opts into onFollow, gated on being on screen', (name) => {
    // `onFollow: true` is the regression, not the fix — see the viewport half above.
    expect(code(name)).toContain('onFollow: inView')
    expect(code(name)).toContain('useInViewport<HTMLDivElement>()')
  })

  test.each(ON_THE_CURSOR)('%s does not hand-roll the aria-live split', (name) => {
    // The two shapes the hand-composed charts carried. A kind makes the split itself, and a chart
    // that reaches for `cursor.isSource` is one that has stopped composing the kind.
    const src = code(name)
    expect(src).not.toContain('ariaLive={cursor.isSource}')
    expect(src).not.toContain('anchor={cursor.isSource ? cursor.anchor : null}')
  })
})

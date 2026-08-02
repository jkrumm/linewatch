import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./latency-band-chart.tsx', import.meta.url), 'utf8')

/** Comments stripped, so the docblock that NAMES the old bug does not itself trip the check. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * A legend swatch that names a colour the mark does not have.
 *
 * `latency-band-chart` builds its legend in one function and draws the plot in another, and the
 * overlay's colour was a literal in each. When the legend's literal changed the `LinePath`'s did
 * not, so the router legend said one colour for two commits while the line kept rendering
 * `VX.line` — 11.1:1 against the dark panel, brighter than the accent primary it is drawn over.
 * Nothing caught it: it typechecks, it lints, the palette guard is satisfied (both ARE tokens), and
 * the chart is correct in every other respect. It is the same defect class as the `ChartTooltip`
 * rows that mounted in the SVG namespace and were never painted — a mark and a legend that are not
 * independently reviewable.
 *
 * A render test cannot see this: both values are `var(--vx-*)` strings, so a rendered legend swatch
 * and a rendered stroke would each contain whatever literal was written, and comparing them proves
 * only that the file says what the file says. What has to hold is structural — ONE binding, read
 * by both sites — so that is what this asserts.
 */
describe('the router overlay legend and mark cannot drift', () => {
  test('both read the single OVERLAY_COLOR binding', () => {
    expect(source).toContain('const OVERLAY_COLOR =')
    expect(source).toContain('color: OVERLAY_COLOR')
    expect(source).toContain('stroke={OVERLAY_COLOR}')
  })

  test('neither site reintroduces a series-colour literal', () => {
    expect(code).not.toMatch(/label: overlay\.label, color: VX\./)
    // Chrome (`VX.grid`, `VX.axisStroke`) may stroke a literal — it is not a series. A series
    // neutral or the accent written back into a stroke is the regression this guards.
    const strokes = [...code.matchAll(/stroke=\{(VX\.[A-Za-z0-9.]+)\}/g)].map((m) => m[1])
    expect(strokes.filter((t) => /^VX\.(line|line2|accent|neutral|ink)$/.test(t))).toEqual([])
  })
})

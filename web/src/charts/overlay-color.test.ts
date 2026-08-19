import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./latency-band-chart.tsx', import.meta.url), 'utf8')

/** Comments stripped, so the docblock that NAMES the old bug does not itself trip the check. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * A legend swatch that names a colour the mark does not have.
 *
 * `latency-band-chart` built its legend in one function and drew the plot in another, and the
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
 * only that the file says what the file says. What has to hold is structural, so that is what this
 * asserts.
 *
 * **The structure got stronger in the basalt-ui 1.15.0 migration, and the assertions moved with
 * it.** The old form was "one module constant, read by both sites" — real, but still two reads that
 * a careless edit could separate. The chart now composes `CartesianChart`, which derives the legend
 * from the `series` array and hands the same array back to the mark renderer as `ctx.visible`; the
 * marks stroke `primary.color` / `overlaySeries.color`, i.e. the very object the legend rendered.
 * There is no second read left to drift. What these tests pin is that nobody reintroduces one.
 */
describe('the latency band legend and its marks cannot drift', () => {
  test('the overlay colour is declared once and only in the series descriptor', () => {
    expect(source).toContain('const OVERLAY_COLOR =')
    expect(source).toContain('color: OVERLAY_COLOR')
    // Read back off the series, never repeated at the mark.
    expect(code).not.toContain('stroke={OVERLAY_COLOR}')
  })

  test('every series stroke reads the descriptor the legend rendered', () => {
    const strokes = [...code.matchAll(/stroke=\{([^}]+)\}/g)].map((m) => m[1]!.trim())
    // Chrome (`VX.grid`, `VX.axisStroke`) may stroke a literal — it is not a series. A series
    // neutral or the accent written back into a stroke is the regression this guards.
    expect(strokes.filter((t) => /^VX\.(line|line2|accent|neutral|ink)$/.test(t))).toEqual([])
    // Both series marks resolve their colour through the `PlotContext` entry, not a local.
    expect(strokes).toContain('primary.color')
    expect(strokes).toContain('overlaySeries.color')
  })

  test('neither site reintroduces a series-colour literal in the legend', () => {
    expect(code).not.toMatch(/label: overlay\.label,\s*color: VX\./)
  })
})

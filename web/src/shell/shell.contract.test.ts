import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/**
 * The shell-less page's gutter contract, found broken in a browser rather than by a type:
 *
 * - The root Container takes its gutter from `root-layout.module.css`. A `px` prop is an inline
 *   style, so it beats that class — the page loses its gutter and the full-bleed `PageBar` overshoots
 *   the viewport by the inset (horizontal scroll at every width).
 *
 * Its sibling, `components/dashboard-section.render.test.tsx`, pins the section-anchor half.
 *
 * A source test on purpose: the cascade is a fact a static render cannot observe.
 */
describe('shell-less layout contracts', () => {
  test('the root Container carries no px prop', () => {
    const root = read('../routes/__root.tsx')
    const container = root.match(/<Container\b[^>]*>/)?.[0]
    expect(container).toBeDefined()
    expect(container).not.toMatch(/\bpx=/)
    expect(container).toContain('classes.page')
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/**
 * Compact mode is allowed to drop supporting detail and forbidden to drop a finding — see
 * `lib/compact.tsx` for the full split and the one judgement call in it.
 *
 * This is a SOURCE test rather than a render test, and that is the only form available: the state
 * lives in `createPersistedState`, which is SSR-safe and therefore always resolves to its `initial`
 * (`false`) under `renderToStaticMarkup`, so a rendering test can only ever observe the non-compact
 * branch — it would pass just as happily if someone gated the critical verdicts tomorrow. Grepping
 * the module is the same idiom `services/router/actions.ts` already uses for the destructive
 * operation names: when the property you need to hold is "this line never acquires that gate",
 * the line is what you assert on.
 */
describe('compact mode never hides a finding', () => {
  const panel = read('../components/verdict-panel.tsx')

  test('critical and warn verdicts render with no compact gate', () => {
    expect(panel).toContain('{critical.map((group) => (')
    expect(panel).toContain('{warn.map((group) => (')
    // If either list ever grows a gate it will read `{!compact && critical.map(` or similar.
    expect(panel).not.toMatch(/compact\s*&&\s*critical/)
    expect(panel).not.toMatch(/compact\s*&&\s*warn/)
    expect(panel).not.toMatch(/compact\s*\?[^\n]*critical/)
    expect(panel).not.toMatch(/compact\s*\?[^\n]*warn/)
  })

  test('the routine group is the only gated branch in the band', () => {
    const gated = panel.split('\n').filter((line) => line.includes('compact') && line.includes('&&'))
    expect(gated).toHaveLength(1)
    expect(gated[0]).toContain('routine')
  })

  test('the warn and bad coverage callouts render with no compact gate', () => {
    const coverage = read('../components/coverage-callout.tsx')
    // Exactly one branch consults `compact`, and it is the `info` one — the row that says nothing
    // is wrong. The `<Callout kind={kind}>` below it carries `warn` and `bad` and must stay
    // unconditional.
    const gated = coverage.split('\n').filter((line) => line.includes('compact ?'))
    expect(gated).toHaveLength(1)
    expect(gated[0]).toContain("kind === 'info'")
  })
})

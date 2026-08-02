import { describe, expect, test } from 'bun:test'
import { SECTION_KEYS, VERDICT_SECTION, isSectionKey, sectionAnchor, unmappedVerdictIds } from './verdict-section'
import type { Severity, Verdict } from './types'

function v(id: string, severity: Severity = 'warn'): Verdict {
  return {
    id,
    severity,
    title: `${id} fired`,
    conclusion: 'x',
    evidence: [{ label: 'l', value: 'v' }],
    action: null,
    uncertainty: null,
  }
}

describe('the verdict → section map', () => {
  /**
   * The completeness check, done by reading the rule module rather than by restating its ids here.
   * A second hand-written list of rule names is a list that drifts: the point is to fail when
   * `src/lib/verdict.ts` grows a rule, and a fixture copied from it cannot notice that.
   *
   * An unmapped rule is not cosmetic. It fires, renders in the verdict band, and points at no
   * section — so the reader is told something is wrong and given nowhere to look.
   */
  test('covers every rule id the server can emit, and no others', async () => {
    const source = await Bun.file(new URL('../../../src/lib/verdict.ts', import.meta.url)).text()
    const emitted = [...source.matchAll(/^\s*id: '([a-z_]+)',$/gm)].map((m) => m[1])

    expect(emitted.length).toBeGreaterThan(0)
    const missing = emitted.filter((id) => id !== undefined && !(id in VERDICT_SECTION))
    expect(missing).toEqual([])

    // The other direction: a mapping left behind by a deleted rule points the reader at nothing.
    const stale = Object.keys(VERDICT_SECTION).filter((id) => !emitted.includes(id))
    expect(stale).toEqual([])
  })

  test('every mapping names a real section', () => {
    for (const section of Object.values(VERDICT_SECTION)) expect(isSectionKey(section)).toBe(true)
  })

  test('SECTION_KEYS is the five sections, in reading order', () => {
    expect([...SECTION_KEYS]).toEqual(['uptime', 'latency', 'speed', 'throughput', 'path'])
  })

  /** No rule maps to Throughput yet, and that is allowed: the completeness test runs rule → section,
   * not section → rule. A section with no findings is a section nothing has gone wrong in. */
  test('a section with no rule pointing at it is legal', () => {
    expect(Object.values(VERDICT_SECTION)).not.toContain('throughput')
  })

  /** The anchor is what turns the mapping into a link the reader can actually follow, so it has to
   * be derived from the key rather than written twice. */
  test('every section has a distinct anchor derived from its key', () => {
    const anchors = SECTION_KEYS.map(sectionAnchor)
    expect(new Set(anchors).size).toBe(SECTION_KEYS.length)
    expect(sectionAnchor('uptime')).toBe('section-uptime')
  })
})

describe('unmappedVerdictIds', () => {
  test('a mapped set reports nothing', () => {
    expect(unmappedVerdictIds([v('probe_coverage_low'), v('throughput_exceeds_link')])).toEqual([])
  })

  test('an unmapped id is reported rather than silently dropped, once per id', () => {
    expect(unmappedVerdictIds([v('some_future_rule', 'critical'), v('some_future_rule', 'warn')])).toEqual([
      'some_future_rule',
    ])
  })

  /** Severity is irrelevant here — an `info` rule pointing nowhere is the same page defect as a
   * `critical` one, and the old attention-dot rule (which ignored `info`) does not apply. */
  test('reports an unmapped info rule too', () => {
    expect(unmappedVerdictIds([v('some_future_rule', 'info')])).toEqual(['some_future_rule'])
  })

  test('no verdicts means nothing unmapped', () => {
    expect(unmappedVerdictIds([])).toEqual([])
  })
})

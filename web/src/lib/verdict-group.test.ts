import { describe, expect, test } from 'bun:test'
import { groupVerdicts, triageVerdicts } from './verdict-group'
import type { Verdict } from './types'

function verdict(patch: Partial<Verdict> & Pick<Verdict, 'id'>): Verdict {
  return {
    severity: 'info',
    conclusion: `${patch.id} conclusion`,
    evidence: [{ label: 'e', value: '1' }],
    action: null,
    uncertainty: null,
    ...patch,
  }
}

describe('groupVerdicts', () => {
  /** The 30 d "4 stalled-together cards" case, minimised: the repetition this module exists to
   * remove must actually collapse, not just render tidier. */
  test('collapses a run of same-id verdicts into one group', () => {
    const groups = groupVerdicts([
      verdict({ id: 'carrier_resync_dated', conclusion: 'resync at t1' }),
      verdict({ id: 'carrier_resync_dated', conclusion: 'resync at t2' }),
      verdict({ id: 'carrier_resync_dated', conclusion: 'resync at t3' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].instances).toHaveLength(3)
  })

  /** Sorting is severity-then-id, so same-id instances at different severities are never
   * contiguous. A group must still find its worst member regardless of arrival order. */
  test('takes the worst severity among its instances, whichever order they arrive in', () => {
    const worseLast = groupVerdicts([
      verdict({ id: 'r', severity: 'info' }),
      verdict({ id: 'r', severity: 'critical' }),
    ])
    expect(worseLast[0].severity).toBe('critical')

    const worseFirst = groupVerdicts([
      verdict({ id: 'r', severity: 'warn' }),
      verdict({ id: 'r', severity: 'info' }),
    ])
    expect(worseFirst[0].severity).toBe('warn')
  })

  /** The representative must come from the worst-severity instance, not just the first one to
   * arrive — otherwise a milder sentence that happened to arrive first would understate the group. */
  test('the representative is the first instance at the worst severity, not the first overall', () => {
    const groups = groupVerdicts([
      verdict({ id: 'r', severity: 'info', conclusion: 'mild, arrived first' }),
      verdict({ id: 'r', severity: 'critical', conclusion: 'severe, arrived second' }),
      verdict({ id: 'r', severity: 'critical', conclusion: 'severe, arrived third' }),
    ])
    expect(groups[0].conclusion).toBe('severe, arrived second')
  })

  /** A group of 1 has to be indistinguishable in render from an ungrouped verdict — the panel
   * relies on this to render every group the same way regardless of `instances.length`. */
  test('a single verdict yields a group of 1 carrying its own fields verbatim', () => {
    const solo = verdict({ id: 'r', conclusion: 'the only conclusion' })
    const groups = groupVerdicts([solo])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      id: 'r',
      conclusion: 'the only conclusion',
      instances: [solo],
    })
  })

  test('empty input yields empty output', () => {
    expect(groupVerdicts([])).toEqual([])
  })

  test('preserves first-appearance order across interleaved ids', () => {
    const groups = groupVerdicts([
      verdict({ id: 'a' }),
      verdict({ id: 'b' }),
      verdict({ id: 'a' }),
      verdict({ id: 'c' }),
    ])
    expect(groups.map((g) => g.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('triageVerdicts', () => {
  /** The load-bearing rule: an actionable finding must never be one the reader has to click to
   * see, no matter how many of them there are. Neither tier has a budget. */
  test('never routes a critical or a warn into the collapsed tier, at any count', () => {
    const groups = groupVerdicts([
      verdict({ id: 'c1', severity: 'critical' }),
      verdict({ id: 'c2', severity: 'critical' }),
      verdict({ id: 'w1', severity: 'warn' }),
      verdict({ id: 'w2', severity: 'warn' }),
      verdict({ id: 'w3', severity: 'warn' }),
    ])
    const { critical, warn, routine } = triageVerdicts(groups)
    expect(critical).toHaveLength(2)
    expect(warn).toHaveLength(3)
    expect(routine).toHaveLength(0)
  })

  /** The change this module was rewritten for: `info` no longer earns a slot on screen. A window
   * whose only findings are informational renders no card at all — just the toggle. */
  test('every info and ok group is routine, however few there are', () => {
    const groups = groupVerdicts([verdict({ id: 'i1', severity: 'info' }), verdict({ id: 'i2', severity: 'ok' })])
    const { critical, warn, routine } = triageVerdicts(groups)
    expect(critical).toEqual([])
    expect(warn).toEqual([])
    expect(routine.map((g) => g.id)).toEqual(['i1', 'i2'])
  })

  /** Nothing may vanish in the sort — the three tiers must always re-form the whole input. */
  test('is total: the three tiers reform the whole input', () => {
    const groups = groupVerdicts([
      verdict({ id: 'i1', severity: 'info' }),
      verdict({ id: 'c1', severity: 'critical' }),
      verdict({ id: 'w1', severity: 'warn' }),
      verdict({ id: 'i2', severity: 'ok' }),
    ])
    const { critical, warn, routine } = triageVerdicts(groups)
    expect([...critical, ...warn, ...routine]).toHaveLength(groups.length)
    expect(new Set([...critical, ...warn, ...routine])).toEqual(new Set(groups))
  })

  test('empty input yields three empty tiers', () => {
    expect(triageVerdicts([])).toEqual({ critical: [], warn: [], routine: [] })
  })

  /** The triage is a filter, not a re-sort: within a tier the server's ordering survives. */
  test('preserves relative order within each tier', () => {
    const groups = groupVerdicts([
      verdict({ id: 'i1', severity: 'info' }),
      verdict({ id: 'c1', severity: 'critical' }),
      verdict({ id: 'i2', severity: 'info' }),
      verdict({ id: 'i3', severity: 'info' }),
    ])
    const { routine } = triageVerdicts(groups)
    expect(routine.map((g) => g.id)).toEqual(['i1', 'i2', 'i3'])
  })
})

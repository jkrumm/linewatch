import { describe, expect, test } from 'bun:test'
import { foldColumns, foldStates } from './link-speed-strip'
import { foldSourceIndex } from './fold'
import type { LinkBucketState } from '../lib/vantage'

const STEADY_1000: LinkBucketState = { kind: 'steady', mbit: 1000 }
const STEADY_100: LinkBucketState = { kind: 'steady', mbit: 100 }
const NO_VANTAGE_5: LinkBucketState = { kind: 'no-vantage', cycles: 5 }
const NO_VANTAGE_7: LinkBucketState = { kind: 'no-vantage', cycles: 7 }
const UNMEASURED: LinkBucketState = { kind: 'unmeasured' }
const TRANSITION: LinkBucketState = { kind: 'transition', mbits: [100, 1000] }

function column(label: string, state: LinkBucketState) {
  return { key: label, bucketStart: Number(label), label, state }
}

describe('foldStates', () => {
  test('any member already a transition widens the mbit set and stays a transition', () => {
    expect(foldStates([TRANSITION, STEADY_1000])).toEqual({ kind: 'transition', mbits: [100, 1000] })
  })

  /** The renegotiation is inside the folded span even though no single source bucket straddled it —
   * two DISAGREEING steady readings must not average to a third speed nobody ever ran at. */
  test('all steady but disagreeing on mbit is also a transition, not an average', () => {
    expect(foldStates([STEADY_1000, STEADY_100])).toEqual({ kind: 'transition', mbits: [100, 1000] })
  })

  test('all steady and agreeing folds to steady at that one speed', () => {
    expect(foldStates([STEADY_1000, STEADY_1000])).toEqual({ kind: 'steady', mbit: 1000 })
  })

  /** `no-vantage` cycles sum across the fold — `unmeasured` members contribute nothing, since they
   * were never cycled at all, and must not be counted as cycles that ran but reported no speed. */
  test('any no-vantage member (with no steady/transition) folds to no-vantage, summing cycles', () => {
    expect(foldStates([NO_VANTAGE_5, NO_VANTAGE_7, UNMEASURED])).toEqual({ kind: 'no-vantage', cycles: 12 })
  })

  test('every member unmeasured folds to unmeasured', () => {
    expect(foldStates([UNMEASURED, UNMEASURED])).toEqual({ kind: 'unmeasured' })
  })
})

describe('foldColumns', () => {
  test('[steady, unmeasured, unmeasured] carries unmeasuredMembers 2, not a collapse to fully-measured', () => {
    const [folded] = foldColumns(
      [column('0', STEADY_1000), column('1', UNMEASURED), column('2', UNMEASURED)],
      1,
    )
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(2)
    // `foldStates` still reports a speed — the coverage count is what keeps that from reading as a
    // fully-confident reading across the whole span (see `StripPlot`'s `unmeasuredFrac`).
    expect(folded?.state).toEqual({ kind: 'steady', mbit: 1000 })
  })

  test('[unmeasured, unmeasured, unmeasured] is wholly unmeasured', () => {
    const [folded] = foldColumns([column('0', UNMEASURED), column('1', UNMEASURED), column('2', UNMEASURED)], 1)
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(3)
    expect(folded?.state).toEqual({ kind: 'unmeasured' })
  })

  test('[steady, steady, steady] carries unmeasuredMembers 0', () => {
    const [folded] = foldColumns([column('0', STEADY_1000), column('1', STEADY_1000), column('2', STEADY_1000)], 1)
    expect(folded?.unmeasuredMembers).toBe(0)
  })

  /** The mirror lie: a mostly-measured fold must not report itself wholly unmeasured. */
  test('a 2-of-3-measured fold does not report itself wholly unmeasured', () => {
    const [folded] = foldColumns([column('0', STEADY_1000), column('1', STEADY_1000), column('2', UNMEASURED)], 1)
    expect(folded?.unmeasuredMembers).toBe(1)
    expect(folded?.state).toEqual({ kind: 'steady', mbit: 1000 })
  })

  test('a remainder group (source length not divisible by the group size) still folds every column', () => {
    const columns = [
      column('0', STEADY_1000),
      column('1', STEADY_1000),
      column('2', STEADY_1000),
      column('3', STEADY_1000),
      column('4', STEADY_1000),
    ]
    const folded = foldColumns(columns, 2)
    expect(folded).toHaveLength(2)
    expect(folded[0]?.foldedFrom).toBe(3)
    expect(folded[1]?.foldedFrom).toBe(2)
    expect(folded.reduce((sum, f) => sum + f.foldedFrom, 0)).toBe(columns.length)
    const index = foldSourceIndex(columns, folded)
    expect(columns.every((c) => index.has(c.label))).toBe(true)
  })

  test('a non-positive cap folds nothing', () => {
    expect(foldColumns([column('0', STEADY_1000)], 0)).toEqual([])
  })
})

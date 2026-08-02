import { describe, expect, test } from 'bun:test'
import { foldColumns, foldStates, summariseLink } from './link-speed-strip'
import { foldSourceIndex } from './fold'
import type { LinkBucketState } from '../lib/vantage'

const STEADY_1000: LinkBucketState = { kind: 'steady', mbit: 1000 }
const STEADY_100: LinkBucketState = { kind: 'steady', mbit: 100 }
const NO_VANTAGE_5: LinkBucketState = { kind: 'no-vantage', cycles: 5 }
const NO_VANTAGE_7: LinkBucketState = { kind: 'no-vantage', cycles: 7 }
const UNMEASURED: LinkBucketState = { kind: 'unmeasured' }
const TRANSITION: LinkBucketState = { kind: 'transition', mbits: [100, 1000] }

function column(key: string, state: LinkBucketState) {
  return { key, bucketStart: Number(key), state }
}

/**
 * The verdict line above the strip. It exists because this chart's normal state is a flat band
 * carrying no information — so what it says has to be true of the RECORD, not of the drawing, and
 * these pin the three places that could quietly stop being true.
 */
describe('summariseLink', () => {
  test('a steady window names its one speed and no renegotiation', () => {
    const summary = summariseLink([column('0', STEADY_1000), column('1', STEADY_1000)])
    expect(summary.mbits).toEqual([1000])
    expect(summary.transitionBuckets).toBe(0)
    expect(summary).toMatchObject({ measured: 2, total: 2, noVantage: 0 })
  })

  /** A speed seen ONLY inside a transition bucket still happened. Reading `mbits` off the steady
   * buckets alone would drop the very speed the reader is looking for. */
  test('collects speeds seen only inside a transition bucket', () => {
    const summary = summariseLink([column('0', STEADY_1000), column('1', TRANSITION)])
    expect(summary.mbits).toEqual([100, 1000])
    expect(summary.transitionBuckets).toBe(1)
  })

  /** The denominator is the whole window, so the sentence can never imply full coverage from a
   * window that was mostly unmeasured — the same discipline the tooltips' "N of M expected" uses. */
  test('unmeasured and no-vantage buckets count against the total, not toward measured', () => {
    const summary = summariseLink([
      column('0', STEADY_1000),
      column('1', UNMEASURED),
      column('2', NO_VANTAGE_5),
    ])
    expect(summary).toMatchObject({ measured: 1, total: 3, noVantage: 1 })
  })

  /** The two "nothing to say" cases the headline distinguishes: cycles that ran and carried no
   * rate is a different fact from no cycles at all, and `mbits.length === 0` alone cannot tell
   * them apart. */
  test('separates a window with no cycles from one whose cycles reported no speed', () => {
    expect(summariseLink([column('0', UNMEASURED)])).toMatchObject({ mbits: [], noVantage: 0 })
    expect(summariseLink([column('0', NO_VANTAGE_7)])).toMatchObject({ mbits: [], noVantage: 1 })
  })
})

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
    expect(columns.every((c) => index.has(c.key))).toBe(true)
  })

  test('a non-positive cap folds nothing', () => {
    expect(foldColumns([column('0', STEADY_1000)], 0)).toEqual([])
  })
})

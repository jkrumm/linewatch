import { describe, expect, test } from 'bun:test'
import { VX, foldBands } from 'basalt-ui/charts'
import { type Column, bandSeries, getBand, mergeColumns } from './availability-strip'
import type { ProbeBucket } from '../lib/types'

function bucket(over: Partial<ProbeBucket> = {}): ProbeBucket {
  return {
    bucket: 0,
    target: 'wan',
    medianMs: 10,
    p5Ms: 8,
    p95Ms: 12,
    minMs: 5,
    maxMs: 15,
    maxLossPct: 0,
    lossPct: 0,
    downCycles: 0,
    count: 10,
    ...over,
  }
}

/** A slot as `AvailabilityStrip` constructs it — `foldedFrom`/`unmeasuredMembers` are carried from
 * construction, not added by the merge, because `getBand` never sees the fold's bookkeeping. */
function column(key: string, value: ProbeBucket | null): Column {
  return {
    key,
    bucketStart: Number(key),
    bucket: value,
    foldedFrom: 1,
    unmeasuredMembers: value === null ? 1 : 0,
  }
}

/** The grouping half of the fold is basalt's — `foldBands` is exported precisely so a consumer
 * tests its merge against the arithmetic that will actually run, rather than a re-implementation. */
const fold = (columns: Column[], cap: number) => foldBands(columns, cap, mergeColumns)

const colorOf = (key: string) => bandSeries(10).find((s) => s.key === key)?.color

/**
 * The reported bug, pinned: *why is reachability red all the time even though we are online?*
 *
 * The floor under every measured band was the bad hue at 14% — the loss ramp's own bottom step —
 * so a window that lost nothing painted a faint red wash end to end. Every number behind it was
 * correct, which is why nothing caught it: the ramp was continuous, 0% sat at its floor, and no
 * test asked what colour "fine" is drawn in. These do.
 *
 * The fill now lives in two places by design: a state that is ONE colour carries it on its `series`
 * entry (so the legend swatch cannot drift from the mark), and only the loss RAMP overrides it per
 * band. So does the assertion.
 */
describe('getBand', () => {
  test('a clean bucket is not drawn in the bad hue', () => {
    expect(getBand(column('0', bucket({ lossPct: 0, maxLossPct: 0 })))).toMatchObject({
      state: 'clean',
    })
    expect(colorOf('clean')).toContain('neutral')
    expect(colorOf('clean')).not.toContain('bad')
  })

  test('a lossy bucket is', () => {
    expect(getBand(column('0', bucket({ lossPct: 1 }))).fill).toContain('bad')
  })

  /** The two must be told apart at a glance, which is the whole job of this strip. Sharing a hue
   * and differing only in alpha is what made a clean window unreadable. */
  test('clean and lossy do not share a hue', () => {
    const clean = getBand(column('0', bucket({ lossPct: 0 })))
    const lossy = getBand(column('1', bucket({ lossPct: 0.01 })))
    expect(clean.state).not.toBe(lossy.state)
    // A clean band takes its series fill (neutral); only the ramp overrides.
    expect(clean.fill).toBeUndefined()
    expect(colorOf('clean')).toBe(VX.neutral)
    expect(lossy.fill).toContain(VX.badSolid)
  })

  /** The smallest recorded loss has to clear the clean floor by more than a rounding step, or the
   * split above buys nothing: it would be a different hue at an indistinguishable weight. */
  test('the faintest loss is drawn well above the clean floor', () => {
    const lossy = getBand(column('0', bucket({ lossPct: 0.001 }))).fill ?? ''
    const pct = Number(/([\d.]+)%/.exec(lossy)?.[1])
    expect(pct).toBeGreaterThanOrEqual(30)
  })

  /** Unchanged, and re-pinned here because the split above is a change to the same function: a
   * bucket where every cycle got nothing back is its own state, not the top of the loss ramp. */
  test('a fully-down bucket is its own state, and an empty aggregate is not', () => {
    expect(getBand(column('0', bucket({ count: 10, downCycles: 10, lossPct: 100 }))).state).toBe(
      'down',
    )
    expect(getBand(column('0', bucket({ count: 0, downCycles: 0, lossPct: 0 }))).state).not.toBe(
      'down',
    )
  })

  /** An absent bucket is never a fill: the whole band's width is the absence hatch, which is the
   * kind's own vocabulary rather than a colour this file picks. */
  test('an absent bucket is wholly hatched, never a fill', () => {
    expect(getBand(column('0', null))).toEqual({ state: 'absent', absentFraction: 1 })
  })

  /** The share drawn hatched inside a partly-measured band — the fix for a 1-of-3-measured fold
   * that used to paint as a clean, fully-measured column. */
  test('a partly-measured fold hatches exactly the share nothing measured', () => {
    const [folded] = fold([column('0', bucket()), column('1', null), column('2', null)], 1)
    expect(getBand(folded!).absentFraction).toBeCloseTo(2 / 3, 10)
  })
})

describe('mergeColumns, through foldBands', () => {
  test('[measured, absent, absent] carries unmeasuredMembers 2, not a collapse to fully-measured', () => {
    const [folded] = fold([column('0', bucket()), column('1', null), column('2', null)], 1)
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(2)
    // The lie this fixes: the fold must not read as though every member agreed.
    expect(folded?.bucket).not.toBeNull()
  })

  test('[absent, absent, absent] is wholly unmeasured', () => {
    const [folded] = fold([column('0', null), column('1', null), column('2', null)], 1)
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(3)
    expect(folded?.bucket).toBeNull()
  })

  test('[measured, measured, measured] carries unmeasuredMembers 0', () => {
    const [folded] = fold([column('0', bucket()), column('1', bucket()), column('2', bucket())], 1)
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(0)
  })

  /** The mirror lie: a fold that is MOSTLY measured must not report itself wholly unmeasured
   * either — `unmeasuredMembers` has to track the actual absent count, not clamp to the extremes. */
  test('a 2-of-3-measured fold does not report itself wholly unmeasured', () => {
    const [folded] = fold([column('0', bucket()), column('1', bucket()), column('2', null)], 1)
    expect(folded?.unmeasuredMembers).toBe(1)
    expect(folded?.bucket).not.toBeNull()
  })

  test('a remainder group (source length not divisible by the group size) still folds every column', () => {
    const columns = [
      column('0', bucket()),
      column('1', bucket()),
      column('2', bucket()),
      column('3', bucket()),
      column('4', bucket()),
    ]
    // cap 2 -> groupSize ceil(5/2) = 3 -> groups of 3 and 2 (the remainder).
    const folded = fold(columns, 2)
    expect(folded).toHaveLength(2)
    expect(folded[0]?.foldedFrom).toBe(3)
    expect(folded[1]?.foldedFrom).toBe(2)
    // Every source column accounted for exactly once. A fold that dropped or double-counted one
    // would shorten the window without shortening the axis. `foldedFrom` SUMS in the merge rather
    // than counting the group, which is what keeps this true whatever the group is made of.
    expect(folded.reduce((sum, f) => sum + f.foldedFrom, 0)).toBe(columns.length)
  })

  /** The tooltip's own arithmetic: `downCycles` and `count` sum across the fold (additive, like a
   * cycle count), never averaged the way `lossPct` is maxed. A fold that summed the wrong way would
   * understate "cycles fully down" the moment the worst member wasn't also the most-measured one. */
  test('downCycles and count sum across the fold; lossPct and maxLossPct take the worst member', () => {
    const [folded] = fold(
      [
        column('0', bucket({ lossPct: 2, maxLossPct: 5, downCycles: 1, count: 100 })),
        column('1', bucket({ lossPct: 50, maxLossPct: 100, downCycles: 10, count: 20 })),
      ],
      1,
    )
    expect(folded?.bucket?.lossPct).toBe(50)
    expect(folded?.bucket?.maxLossPct).toBe(100)
    expect(folded?.bucket?.downCycles).toBe(11)
    expect(folded?.bucket?.count).toBe(120)
  })

  /** `expectedCycles * foldedFrom` is the denominator behind both the derived "Not measured" row
   * and the hand-authored "Measured" one — it has to scale with the fold, or a 3:1 fold prints as
   * though only one bucket's worth was ever expected. */
  test('foldedFrom scales the expected-cycles denominator the tooltip multiplies it by', () => {
    const [folded] = fold([column('0', bucket()), column('1', bucket()), column('2', bucket())], 1)
    const expectedCycles = 10
    expect(expectedCycles * (folded?.foldedFrom ?? 0)).toBe(30)
    const absent = bandSeries(expectedCycles).find((s) => s.key === 'absent')
    expect(absent?.formatValue?.({ ...folded!, bucket: null })).toBe('0 of 30 expected cycles')
  })

  test('a column count at or under the cap passes through unfolded, one source per column', () => {
    const columns = [column('0', bucket()), column('1', null)]
    expect(fold(columns, 5)).toEqual(columns)
  })

  test('a non-positive cap folds nothing', () => {
    expect(fold([column('0', bucket())], 0)).toEqual([])
  })
})

import { describe, expect, test } from 'bun:test'
import { VX } from 'basalt-ui/charts'
import { columnFill, foldColumns } from './availability-strip'
import { foldSourceIndex } from './fold'
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

function column(key: string, value: ProbeBucket | null) {
  return { key, bucketStart: Number(key), bucket: value }
}

/**
 * The reported bug, pinned: *why is reachability red all the time even though we are online?*
 *
 * The floor under every measured column was the bad hue at 14% — the loss ramp's own bottom step —
 * so a window that lost nothing painted a faint red wash end to end. Every number behind it was
 * correct, which is why nothing caught it: the ramp was continuous, 0% sat at its floor, and no
 * test asked what colour "fine" is drawn in. These do.
 */
describe('columnFill', () => {
  // The pattern's id, not a paint value — `hatchFill` wraps it in `url(#…)`.
  const HATCH = 'absent-hatch'

  test('a clean bucket is not drawn in the bad hue', () => {
    const fill = columnFill(bucket({ lossPct: 0, maxLossPct: 0 }), HATCH)
    expect(fill).toContain('neutral')
    expect(fill).not.toContain('bad')
  })

  test('a lossy bucket is', () => {
    expect(columnFill(bucket({ lossPct: 1 }), HATCH)).toContain('bad')
  })

  /** The two must be told apart at a glance, which is the whole job of this strip. Sharing a hue
   * and differing only in alpha is what made a clean window unreadable. */
  test('clean and lossy do not share a hue', () => {
    const clean = columnFill(bucket({ lossPct: 0 }), HATCH)
    const lossy = columnFill(bucket({ lossPct: 0.01 }), HATCH)
    expect(clean).not.toBe(lossy)
    expect(clean.includes(VX.neutral)).toBe(true)
    expect(lossy.includes(VX.badSolid)).toBe(true)
  })

  /** The smallest recorded loss has to clear the clean floor by more than a rounding step, or the
   * split above buys nothing: it would be a different hue at an indistinguishable weight. */
  test('the faintest loss is drawn well above the clean floor', () => {
    const lossy = columnFill(bucket({ lossPct: 0.001 }), HATCH)
    const pct = Number(/([\d.]+)%/.exec(lossy)?.[1])
    expect(pct).toBeGreaterThanOrEqual(30)
  })

  /** Unchanged, and re-pinned here because the split above is a change to the same function: a
   * bucket where every cycle got nothing back is solid, not the top of the loss ramp. */
  test('a fully-down bucket is solid, and an empty aggregate is not', () => {
    expect(columnFill(bucket({ count: 10, downCycles: 10, lossPct: 100 }), HATCH)).toBe(VX.badSolid)
    expect(columnFill(bucket({ count: 0, downCycles: 0, lossPct: 0 }), HATCH)).not.toBe(VX.badSolid)
  })

  test('an absent bucket is the hatch, never a fill', () => {
    expect(columnFill(null, HATCH)).toBe(`url(#${HATCH})`)
  })
})

describe('foldColumns', () => {
  test('[measured, absent, absent] carries unmeasuredMembers 2, not a collapse to fully-measured', () => {
    const [folded] = foldColumns([column('0', bucket()), column('1', null), column('2', null)], 1)
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(2)
    // The lie this fixes: the fold must not read as though every member agreed.
    expect(folded?.bucket).not.toBeNull()
  })

  test('[absent, absent, absent] is wholly unmeasured', () => {
    const [folded] = foldColumns([column('0', null), column('1', null), column('2', null)], 1)
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(3)
    expect(folded?.bucket).toBeNull()
  })

  test('[measured, measured, measured] carries unmeasuredMembers 0', () => {
    const [folded] = foldColumns(
      [column('0', bucket()), column('1', bucket()), column('2', bucket())],
      1,
    )
    expect(folded?.foldedFrom).toBe(3)
    expect(folded?.unmeasuredMembers).toBe(0)
  })

  /** The mirror lie: a fold that is MOSTLY measured must not report itself wholly unmeasured
   * either — `unmeasuredMembers` has to track the actual absent count, not clamp to the extremes. */
  test('a 2-of-3-measured fold does not report itself wholly unmeasured', () => {
    const [folded] = foldColumns([column('0', bucket()), column('1', bucket()), column('2', null)], 1)
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
    const folded = foldColumns(columns, 2)
    expect(folded).toHaveLength(2)
    expect(folded[0]?.foldedFrom).toBe(3)
    expect(folded[1]?.foldedFrom).toBe(2)
    // The precondition `foldSourceIndex` depends on: every source column accounted for.
    expect(folded.reduce((sum, f) => sum + f.foldedFrom, 0)).toBe(columns.length)
    const index = foldSourceIndex(columns, folded)
    expect(columns.every((c) => index.has(c.key))).toBe(true)
  })

  /** The tooltip's own arithmetic: `downCycles` and `count` sum across the fold (additive, like a
   * cycle count), never averaged the way `lossPct` is maxed. A fold that summed the wrong way would
   * understate "cycles fully down" the moment the worst member wasn't also the most-measured one. */
  test('downCycles and count sum across the fold; lossPct and maxLossPct take the worst member', () => {
    const [folded] = foldColumns(
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

  /** `expectedCycles * foldedFrom` is the tooltip's denominator for "N of M expected cycles" — it
   * has to scale with the fold, or a 3:1 fold prints as though only one bucket's worth was ever
   * expected. This pins the multiplier `ColumnRows` relies on. */
  test('foldedFrom scales the expected-cycles denominator the tooltip multiplies it by', () => {
    const [folded] = foldColumns([column('0', bucket()), column('1', bucket()), column('2', bucket())], 1)
    const expectedCycles = 10
    expect(expectedCycles * (folded?.foldedFrom ?? 0)).toBe(30)
  })

  test('a column count at or under the cap passes through unfolded, one source per column', () => {
    const columns = [column('0', bucket()), column('1', null)]
    const folded = foldColumns(columns, 5)
    expect(folded).toEqual([
      { ...columns[0], foldedFrom: 1, unmeasuredMembers: 0 },
      { ...columns[1], foldedFrom: 1, unmeasuredMembers: 1 },
    ])
  })

  test('a non-positive cap folds nothing', () => {
    expect(foldColumns([column('0', bucket())], 0)).toEqual([])
  })
})

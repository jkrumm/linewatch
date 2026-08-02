import { describe, expect, test } from 'bun:test'
import { foldSourceIndex } from './fold'

type Source = { key: string }
type Folded = { key: string; foldedFrom: number }

function source(keys: string[]): Source[] {
  return keys.map((key) => ({ key }))
}

describe('foldSourceIndex', () => {
  test('every source key resolves to the folded column that swallowed it', () => {
    const src = source(['a', 'b', 'c', 'd', 'e', 'f'])
    const folded: Folded[] = [
      { key: 'a', foldedFrom: 3 }, // consumes a, b, c
      { key: 'd', foldedFrom: 3 }, // consumes d, e, f
    ]
    const index = foldSourceIndex(src, folded)
    expect(index.get('a')).toBe(folded[0])
    expect(index.get('b')).toBe(folded[0])
    expect(index.get('c')).toBe(folded[0])
    expect(index.get('d')).toBe(folded[1])
    expect(index.get('e')).toBe(folded[1])
    expect(index.get('f')).toBe(folded[1])
    // The precondition the docblock declares: every source column resolved, none left over.
    expect(folded.reduce((sum, f) => sum + f.foldedFrom, 0)).toBe(src.length)
  })

  test('a remainder group whose foldedFrom differs from its siblings still resolves every key', () => {
    // 5 source columns folded 2:2:1 — the shape `Math.ceil(length / cap)` grouping produces when
    // the source length is not divisible by the group size.
    const src = source(['a', 'b', 'c', 'd', 'e'])
    const folded: Folded[] = [
      { key: 'a', foldedFrom: 2 },
      { key: 'c', foldedFrom: 2 },
      { key: 'e', foldedFrom: 1 },
    ]
    const index = foldSourceIndex(src, folded)
    expect(src.every((s) => index.has(s.key))).toBe(true)
    expect(index.get('a')).toBe(folded[0])
    expect(index.get('b')).toBe(folded[0])
    expect(index.get('c')).toBe(folded[1])
    expect(index.get('d')).toBe(folded[1])
    expect(index.get('e')).toBe(folded[2])
  })

  /**
   * The exact regression the docblock warns about: a `fold*` function that drops a remainder group
   * (rather than folding it into a shorter final column) under-counts `foldedFrom` relative to
   * `source.length`. `foldSourceIndex` walks `folded` and stops consuming source columns the moment
   * it runs out of entries, so the trailing source labels — the ones the dropped group covered —
   * resolve to nothing. A chart's `resolveKey` then returns `null` for those keys,
   * `syncedPoint` falls back to `null`, and the shared crosshair blinks off exactly on them: this is
   * what reappears the moment a fold function stops honouring the precondition.
   */
  test('a fold that drops a remainder group leaves the trailing source keys unmapped', () => {
    const src = source(['a', 'b', 'c', 'd', 'e'])
    // foldedFrom sums to 3, not 5 — the last two source columns were never folded into anything.
    const folded: Folded[] = [{ key: 'a', foldedFrom: 3 }]
    const index = foldSourceIndex(src, folded)
    expect(index.get('a')).toBeDefined()
    expect(index.get('b')).toBeDefined()
    expect(index.get('c')).toBeDefined()
    expect(index.get('d')).toBeUndefined()
    expect(index.get('e')).toBeUndefined()
  })

  test('an empty source or an empty fold produces an empty index rather than throwing', () => {
    expect(foldSourceIndex([], []).size).toBe(0)
    expect(foldSourceIndex(source(['a']), []).size).toBe(0)
  })
})

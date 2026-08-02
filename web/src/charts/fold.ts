/**
 * Recovers, for every SOURCE column a folded chart densified, which folded (drawn) column
 * swallowed it.
 *
 * `useHoverSync`'s own `pointByKey` is built from the DRAWN array only, keyed by the same
 * `getKey` the chart uses locally — so on a folded chart (availability strip, link-speed strip,
 * throughput bars) that map holds one key per folded column. A sibling that does not fold (the
 * latency band chart keys all 288 raw buckets) broadcasts a key from the full, unfolded space, and
 * two of every three such keys have no entry in a folded chart's own `pointByKey` — the shared
 * crosshair blinks on and off with no rule a reader can infer. This index is keyed over the SAME
 * full space the unfolded broadcaster uses, so every key it can possibly send resolves to the
 * folded column that contains it.
 *
 * Built by walking `folded` and consuming exactly `foldedFrom` source columns per entry — true for
 * every `fold*` function in this directory (each builds its groups by consecutive slicing over the
 * source array), regardless of the aggregation rule inside a group.
 */
export function foldSourceIndex<S extends { label: string }, F extends { foldedFrom: number }>(
  source: readonly S[],
  folded: readonly F[],
): Map<string, F> {
  const index = new Map<string, F>()
  let cursor = 0
  for (const column of folded) {
    for (let i = 0; i < column.foldedFrom; i++) {
      const sourceColumn = source[cursor]
      if (sourceColumn !== undefined) index.set(sourceColumn.label, column)
      cursor++
    }
  }
  return index
}

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
 * **This is the map behind `useHoverSync`'s `resolveKey` seam, and the fold is why the seam is
 * ours to fill.** basalt-ui 1.9.0 added the override precisely because a downsampling chart cannot
 * resolve a sibling's key by string equality; what a fold *is* on this dashboard — which source
 * buckets a drawn column stands for, and the `foldedFrom` count that says so — stays domain
 * knowledge the framework has no way to compute. Charts pass `resolveKey: (key) =>
 * index.get(key) ?? null` and stop reading `HoverContext` themselves.
 *
 * Keyed by the bucket's ISO start (`Slot.key`), which is the scale's domain value and therefore
 * the broadcast hover key. It used to be the axis label, back when a pre-formatted label had to
 * double as the domain value to reach `AxisBottomDate` at all; `tickFormat` ended that coupling
 * (see `lib/axis.ts`), so the key is now an identity rather than a rendering.
 *
 * Built by walking `folded` and consuming exactly `foldedFrom` source columns per entry — true for
 * every `fold*` function in this directory (each builds its groups by consecutive slicing over the
 * source array), regardless of the aggregation rule inside a group.
 */
export function foldSourceIndex<S extends { key: string }, F extends { foldedFrom: number }>(
  source: readonly S[],
  folded: readonly F[],
): Map<string, F> {
  const index = new Map<string, F>()
  let cursor = 0
  for (const column of folded) {
    for (let i = 0; i < column.foldedFrom; i++) {
      const sourceColumn = source[cursor]
      if (sourceColumn !== undefined) index.set(sourceColumn.key, column)
      cursor++
    }
  }
  return index
}

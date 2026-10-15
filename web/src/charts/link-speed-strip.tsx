// MIGRATION-STUB(w4): the BandStrip link-speed strip (speed ramp, transition markers, verdict line, tooltip rows)
import { ChartCard } from 'basalt-ui/charts'
import type { ProbeBucketSeconds, VantageBucket } from '../lib/types'
import type { LinkBucketState } from '../lib/vantage'

/**
 * One slot of the strip.
 *
 * `foldedFrom`/`unmeasuredMembers` are carried from CONSTRUCTION for the reason
 * `availability-strip.tsx`'s identical fields give: `getBand` never sees the fold's bookkeeping.
 * `foldStates`'s own `kind` says what the MEASURED members reported, never how much of the span
 * they cover, and a 1-of-3-measured band must not paint as a fully-confident reading.
 */
export type Column = {
  /** ISO-8601 of the bucket start: the band scale's domain value, the broadcast hover key, and what
   * `bucketTickFormat` renders into the axis label at draw time. See `lib/axis.ts`. */
  key: string
  bucketStart: number
  state: LinkBucketState
  foldedFrom: number
  unmeasuredMembers: number
}

/**
 * How a group of adjacent slots collapses into the one band drawn in its place — the same
 * sub-pixel pitch problem `availability-strip.tsx` fixes, and the same MAX-never-mean argument this
 * file's own guide copy already makes: the mean of 1000 and 100 is 550, a rate the link never ran
 * at for a moment. That argument holds identically for a *folded* span, which is what `foldStates`
 * below is built to keep true.
 */
export function mergeColumns(group: Column[]): Column {
  const first = group[0]
  if (first === undefined) throw new Error('mergeColumns: empty group')
  return {
    ...first,
    state: foldStates(group.map((c) => c.state)),
    foldedFrom: group.reduce((sum, c) => sum + c.foldedFrom, 0),
    unmeasuredMembers: group.reduce((sum, c) => sum + c.unmeasuredMembers, 0),
  }
}

/**
 * The fold rule for a link state:
 *
 *   - any member `transition` -> the folded slot is `transition`, over the union of every distinct
 *     speed any member reported (a fold can only widen the set of speeds seen, never narrow it);
 *   - all members `steady` but disagreeing on `mbit` -> ALSO `transition` — the renegotiation IS
 *     inside the folded span even though no single source bucket straddled it;
 *   - all members `steady` and agreeing -> `steady` at that one speed;
 *   - otherwise `no-vantage` (something was measured, just not a speed) when any member was;
 *   - `unmeasured` only when EVERY member is `unmeasured` — a group with any `no-vantage` or
 *     `steady` member was measured, and folding it to unmeasured would claim less was recorded
 *     than actually was.
 *
 * That last rule is honest about what `kind` MEANS (a speed genuinely was negotiated somewhere in
 * this span) but says nothing about how much of the span it covers — `[1000 Mbit, absent, absent]`
 * folds to `steady` at 1000 Mbit under this rule, correctly, and the band would paint at that
 * reading across its whole width, incorrectly. `unmeasuredMembers` is what hatches that share.
 */
export function foldStates(states: LinkBucketState[]): LinkBucketState {
  const mbits = new Set<number>()
  let anyTransition = false
  let anySteady = false
  let anyNoVantage = false
  let noVantageCycles = 0

  for (const s of states) {
    if (s.kind === 'steady') {
      mbits.add(s.mbit)
      anySteady = true
    } else if (s.kind === 'transition') {
      for (const m of s.mbits) mbits.add(m)
      anyTransition = true
    } else if (s.kind === 'no-vantage') {
      anyNoVantage = true
      noVantageCycles += s.cycles
    }
    // 'unmeasured' contributes nothing to any of the above.
  }

  if (anyTransition || mbits.size > 1)
    return { kind: 'transition', mbits: [...mbits].toSorted((a, b) => a - b) }
  if (anySteady) return { kind: 'steady', mbit: [...mbits][0]! }
  if (anyNoVantage) return { kind: 'no-vantage', cycles: noVantageCycles }
  return { kind: 'unmeasured' }
}

/**
 * What the window as a whole did, in numbers — computed over the UNFOLDED columns, so the sentence
 * describes the record rather than the drawing.
 *
 * The strip's problem is that its subject is almost always constant. On a healthy gigabit line
 * every band is the same fill, and a reader looking at a flat blue band 288 buckets wide learns
 * only that something was measured; the one fact worth having — *did the NIC renegotiate, and
 * what to* — is legible only by hovering bands one at a time looking for a marker that is usually
 * not there. A chart whose normal state carries no information has to state its own conclusion, and
 * the marks then become the evidence for it rather than the whole message.
 *
 * `transitionBuckets` counts BUCKETS containing a renegotiation, not renegotiations: a bucket
 * reports the distinct speeds it saw and not how many times it changed between them, so any
 * count of events would be invented. `mbits` is every distinct speed the window saw, including
 * those seen only inside a transition bucket.
 */
export type LinkSummary = {
  /** Buckets that reported a link speed. */
  measured: number
  /** Buckets in the window, measured or not — the denominator the reader needs to weigh the rest. */
  total: number
  /** Buckets measured but reporting no link speed at all: cycles ran, the vantage had no rate. */
  noVantage: number
  /** Every distinct negotiated speed the window saw, ascending. */
  mbits: number[]
  transitionBuckets: number
}

export function summariseLink(columns: readonly { state: LinkBucketState }[]): LinkSummary {
  const mbits = new Set<number>()
  let measured = 0
  let noVantage = 0
  let transitionBuckets = 0

  for (const { state } of columns) {
    if (state.kind === 'steady') {
      mbits.add(state.mbit)
      measured += 1
    } else if (state.kind === 'transition') {
      for (const m of state.mbits) mbits.add(m)
      measured += 1
      transitionBuckets += 1
    } else if (state.kind === 'no-vantage') {
      noVantage += 1
    }
  }

  return {
    measured,
    total: columns.length,
    noVantage,
    mbits: [...mbits].toSorted((a, b) => a - b),
    transitionBuckets,
  }
}

/**
 * Negotiated link speed over the window, one band per bucket.
 *
 * The one rule that shapes this chart: **a bucket holding more than one link speed is drawn as a
 * transition marker, not as a value.** `GET /api/probes`'s vantage series reports every distinct
 * speed seen in a bucket precisely so the client cannot flatten them, and averaging a
 * 1000→100 renegotiation into 550 renders a rate the NIC never ran at — a fabricated measurement
 * sitting in the middle of two real ones.
 *
 * Three more states stay distinct from each other and from a speed: a bucket the range route
 * returned nothing for (hatched — not measured), a bucket whose cycles reported no link speed at
 * all (faint — measured, but not this), and the speeds themselves.
 */
export function LinkSpeedStrip(_props: {
  vantage: VantageBucket[]
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
  /**
   * True while the probe-buckets query carrying the vantage series is in flight.
   *
   * `linkBucketState(null)` is `unmeasured`, so an unresolved query hatched every band in the
   * window — a positive claim that the collector ran and reported no link speed for any of it,
   * which on this strip reads as the NIC having gone dark rather than as a question nobody had
   * answered. Same guard, same reason, as `availability-strip.tsx`'s.
   */
  isPending?: boolean
}) {
  return <ChartCard state={{ empty: 'Migrating to basalt-ui 2.0' }} />
}

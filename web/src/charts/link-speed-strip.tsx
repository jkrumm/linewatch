import { useCallback, useMemo } from 'react'
import {
  type BandFold,
  type BandSpan,
  BandStrip,
  type BandStripSeries,
  type ChartTooltipRow,
} from 'basalt-ui/charts'
import { VX, alpha } from 'basalt-ui/tokens'
import { useInViewport } from './use-in-viewport'
import classes from './link-speed-strip.module.css'
import type { ProbeBucketSeconds, VantageBucket } from '../lib/types'
import type { LinkBucketState } from '../lib/vantage'
import { linkBucketState } from '../lib/vantage'
import { densifyBuckets } from '../lib/densify'
import { fmtDateTime } from '../lib/format'
import { bucketTickFormat } from '../lib/axis'
import { ABSENT_ALPHA, ABSENT_COLOR, foldedFromRows } from './band-shared'

/** The plot's height, bands plus axis — see `availability-strip.tsx`'s identical constant. */
const STRIP_FRAME_HEIGHT = 65

/** The transition marker's inset from the band's top and bottom. It is drawn as its own bar of its
 * own colour rather than as a value, so it cannot be read off the intensity ramp. */
const MARKER_INSET = 6

/**
 * One slot of the strip.
 *
 * `foldedFrom`/`unmeasuredMembers` are carried from CONSTRUCTION for the reason
 * `availability-strip.tsx`'s identical fields give: `getBand` never sees the fold's bookkeeping.
 * `foldStates`'s own `kind` says what the MEASURED members reported, never how much of the span
 * they cover, and a 1-of-3-measured band must not paint as a fully-confident reading.
 */
export type Column = {
  /** The bucket's start, epoch ms: the strip's x (as a `Date`, the instant — never a display
   * string), the broadcast hover key and the cursor's resolution key. `bucketTickFormat` turns it
   * into the time a reader sees at draw time. See `lib/axis.ts`. */
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

const FOLD: BandFold<Column> = { merge: mergeColumns }

/** Stable across renders, unlike an inline arrow — the kind recompiles when `x` changes identity. */
const columnX = (c: Column): Date => new Date(c.bucketStart)

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
 * reading across its whole width, incorrectly. `unmeasuredMembers` is what paints that share.
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
 * Which state a band is in, and the two qualifications the state alone cannot carry.
 *
 * A transition gets both: a faint fill so the ramp cannot be misread as a speed, and a `marker` —
 * a shorter inset bar in the state's own colour — because "the NIC renegotiated here" must not be
 * readable off an intensity ramp at all. A steady band gets the ramp itself, relative to the
 * fastest speed the window saw rather than to any absolute rate, because this line's ceiling is a
 * property of the hardware and not of the chart.
 *
 * `maxMbit` is 0 only when no bucket in the window reported a speed, in which case the `steady`
 * branch is unreachable; the guard keeps the division defined rather than producing NaN.
 */
export function bandFor(c: Column, maxMbit: number): BandSpan {
  const absentFraction = c.unmeasuredMembers / c.foldedFrom
  const state = c.state
  if (state.kind === 'unmeasured') return { state: 'absent', absentFraction }
  // Measured cycles that reported no link speed. Faint and its own state rather than the absent
  // one: something was measured here, so it is not absence — it just was not this.
  if (state.kind === 'no-vantage') return { state: 'no-vantage', absentFraction }
  if (state.kind === 'transition')
    return {
      state: 'transition',
      absentFraction,
      fill: alpha(VX.warnSolid, 0.25),
      marker: { inset: MARKER_INSET },
    }
  const intensity = maxMbit > 0 ? state.mbit / maxMbit : 1
  return { state: 'speed', absentFraction, fill: alpha(VX.line, 0.25 + 0.65 * intensity) }
}

/**
 * The four states, which on `BandStrip` are also the legend and the one derived tooltip row.
 *
 * `fillOpacity` mirrors the real alphas so the legend cannot describe a fill the chart does not
 * draw. The speed swatch is the ramp's top step because that is what a healthy window is drawn in;
 * the ramp itself is relative to the fastest speed the window saw, which the verdict line above
 * states in words.
 *
 * **The absent state is the only one in `ABSENT_COLOR`.** With the hatch gone (basalt-ui 2.8.0) "not
 * measured" is a flat fill, and 2.9.0 requires it to differ from every measured state's colour, not
 * only by alpha. The speed ramp is `VX.line`, a renegotiation `VX.warnSolid` and a cycle that
 * reported no speed `VX.neutral` — none is the accent. `link-speed-strip.test.ts` pins it.
 */
export const LINK_STATES: BandStripSeries<Column>[] = [
  {
    key: 'speed',
    label: 'Negotiated speed',
    color: VX.line,
    fillOpacity: 0.9,
    formatValue: (c) => (c.state.kind === 'steady' ? `${c.state.mbit} Mbit` : null),
  },
  {
    key: 'transition',
    label: 'Renegotiated',
    color: VX.warnSolid,
    fillOpacity: 1,
    // Joined with a slash, not an arrow: the bucket reports the distinct speeds it saw, not the
    // order it saw them in, and an arrow would invent a direction.
    formatValue: (c) =>
      c.state.kind === 'transition' ? c.state.mbits.map((m) => `${m} Mbit`).join(' / ') : null,
  },
  {
    key: 'no-vantage',
    label: 'No link speed reported',
    color: VX.neutral,
    fillOpacity: 0.18,
    formatValue: (c) => (c.state.kind === 'no-vantage' ? `${c.state.cycles} cycles` : null),
  },
  {
    key: 'absent',
    label: 'Not measured',
    color: ABSENT_COLOR,
    fillOpacity: ABSENT_ALPHA,
    formatValue: () => 'no cycles',
  },
]

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
 * returned nothing for (a flat fill in `ABSENT_COLOR` — not measured), a bucket whose cycles
 * reported no link speed at all (faint — measured, but not this), and the speeds themselves.
 */
export function LinkSpeedStrip({
  vantage,
  from,
  to,
  bucketSeconds,
  isPending,
}: {
  vantage: VantageBucket[]
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
  /**
   * True while the probe-buckets query carrying the vantage series is in flight.
   *
   * `linkBucketState(null)` is `unmeasured`, so an unresolved query painted every band in the
   * window as not measured — a positive claim that the collector ran and reported no link speed for
   * any of it, which on this strip reads as the NIC having gone dark rather than as a question
   * nobody had answered. Same guard, same reason, as `availability-strip.tsx`'s.
   */
  isPending?: boolean
}) {
  const columns: Column[] = useMemo(
    () =>
      densifyBuckets(vantage, { from, to, bucketSeconds }).map((slot) => {
        const state = linkBucketState(slot.value)
        return {
          bucketStart: slot.bucketStart,
          state,
          foldedFrom: 1,
          unmeasuredMembers: state.kind === 'unmeasured' ? 1 : 0,
        }
      }),
    [vantage, from, to, bucketSeconds],
  )

  const maxMbit = useMemo(() => {
    let max = 0
    for (const column of columns) {
      if (column.state.kind === 'steady') max = Math.max(max, column.state.mbit)
      if (column.state.kind === 'transition') max = Math.max(max, ...column.state.mbits)
    }
    return max
  }, [columns])

  const summary = useMemo(() => summariseLink(columns), [columns])
  const getBand = useCallback((c: Column) => bandFor(c, maxMbit), [maxMbit])
  const formatX = useMemo(() => bucketTickFormat(bucketSeconds), [bucketSeconds])
  // The viewport gate every follower tooltip on this page needs — see `use-in-viewport.ts`.
  const { ref: viewRef, inView } = useInViewport<HTMLDivElement>()
  const tooltip = useMemo(
    () => ({
      onFollow: inView,
      // From the instant, never from the key — see `charts/tooltip-header.test.ts`.
      formatHeader: (_x: Date, c: Column) => fmtDateTime(c.bucketStart),
      rows: columnRows,
    }),
    [inView],
  )

  return (
    // A floor, not a height — see `availability-strip.tsx`'s identical wrapper.
    <div ref={viewRef} style={{ minHeight: STRIP_FRAME_HEIGHT }}>
      {isPending !== true && <LinkVerdict summary={summary} />}
      <BandStrip
        data={columns}
        x={columnX}
        states={LINK_STATES}
        getBand={getBand}
        fold={FOLD}
        absentState="absent"
        height={STRIP_FRAME_HEIGHT}
        formatX={formatX}
        ariaLabel="Negotiated link speed per bucket, with unmeasured buckets marked and renegotiations marked rather than averaged"
        state={{ pending: isPending === true }}
        // Four states, not four series — there is nothing to toggle. Dropped while pending: a legend
        // over a plot with no marks names an encoding for nothing, and 2.x renders it regardless of
        // `state` (basalt friction, w4.md).
        legend={isPending === true ? false : { toggle: false }}
        tooltip={tooltip}
      />
    </div>
  )
}

/**
 * The window's conclusion, above the evidence for it.
 *
 * Raw elements and `VX.*` rather than Mantine `Text`: `src/charts/**` is the Mantine-free half of
 * this app (see the basalt-charts rule), and it is the one place a raw element is the correct
 * remedy rather than a token-system bypass.
 */
function LinkVerdict({ summary }: { summary: LinkSummary }) {
  const { measured, total, noVantage, mbits, transitionBuckets } = summary

  // Nothing reported a speed. Which of the two reasons applies is a real distinction — cycles that
  // ran and carried no rate is a different fact from no cycles at all — and it is the one the
  // strip's own absent-vs-faint split already draws.
  let headline: string
  if (mbits.length === 0) {
    headline =
      noVantage > 0
        ? 'Cycles ran, and none of them reported a link speed'
        : 'No link speed recorded in this window'
  } else if (mbits.length === 1) {
    headline = `Steady at ${mbits[0]} Mbit`
  } else {
    headline = `${mbits.join(' / ')} Mbit`
  }

  const notes: string[] = []
  if (mbits.length > 0) {
    notes.push(
      transitionBuckets === 0
        ? 'no renegotiation recorded'
        : `${transitionBuckets} bucket${transitionBuckets === 1 ? '' : 's'} contained a renegotiation`,
    )
  }
  // The denominator, always — every claim above is only true of the buckets that reported one, and
  // a window measured a tenth of itself supports a much weaker version of the same sentence.
  notes.push(`${measured} of ${total} buckets reported a speed`)

  return (
    <div className={classes['verdict']}>
      <span style={{ color: VX.ink, fontSize: VX.text.sm, fontWeight: 600 }}>{headline}</span>
      {/* `legendText` rather than `text`: this is the same subordinate register as the legend
          directly under the plot, and the two sit within a few px of each other. */}
      <span style={{ color: VX.legendText, fontSize: VX.text.xs }}>· {notes.join(' · ')}</span>
    </div>
  )
}

/**
 * The rows the one derived row cannot carry — see `availability-strip.tsx`'s identical split.
 *
 * `BandStrip` derives exactly one row, the hovered band's state; a renegotiation's "not averaged"
 * note and the fold basis stay hand-authored here as plain `ChartTooltipRow` data.
 */
export function columnRows(column: Column): ChartTooltipRow[] {
  const rows: ChartTooltipRow[] = []
  if (column.state.kind === 'transition')
    rows.push({
      label: 'Not averaged',
      value: 'the order within the bucket is unrecorded',
      color: VX.neutral,
    })
  return [...rows, ...foldedFromRows(column.foldedFrom, column.unmeasuredMembers)]
}

import { useCallback, useMemo } from 'react'
import {
  type BandFold,
  type BandSpan,
  BandStrip,
  type BandStripSeries,
  type ChartMargin,
  TooltipRow,
  VX,
  alpha,
} from 'basalt-ui/charts'
import { useInViewport } from './use-in-viewport'
import type { ProbeBucketSeconds, VantageBucket } from '../lib/types'
import type { LinkBucketState } from '../lib/vantage'
import { linkBucketState } from '../lib/vantage'
import { densifyBuckets } from '../lib/densify'
import { fmtDateTime } from '../lib/format'
import { axisTickValues, bucketTickFormat } from '../lib/axis'

const STRIP_HEIGHT = 44

/** Room for the time axis, and `VX.margin.bottom` restated — see `availability-strip.tsx`'s
 * identical constant for why a `BandStrip`'s band height has to be backed out of `height` by hand. */
const AXIS_HEIGHT = 30

/** The one-row legend band reserved out of the height handed to the kind — see
 * `availability-strip.tsx`'s identical constant. */
const LEGEND_BAND = 24

const STRIP_FRAME_HEIGHT = STRIP_HEIGHT + AXIS_HEIGHT + LEGEND_BAND

/** No y axis and nothing drawn above the band row, so the top gutter is dead space — see
 * `availability-strip.tsx`'s identical override. */
const STRIP_MARGIN: Partial<ChartMargin> = { top: 0 }

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

const FOLD: BandFold<Column> = { merge: mergeColumns }

/** Stable across renders — see `availability-strip.tsx`'s identical constant. */
const getColumnKey = (c: Column): string => c.key

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
  // Measured cycles that reported no link speed. Faint and solid rather than hatched: something
  // was measured here, so it is not absence — it just was not this.
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
 */
export const FILL_SERIES: BandStripSeries<Column>[] = [
  {
    key: 'speed',
    label: 'Negotiated speed',
    color: VX.line,
    mark: 'bar',
    fillOpacity: 0.9,
    formatValue: (c) => (c.state.kind === 'steady' ? `${c.state.mbit} Mbit` : null),
  },
  {
    key: 'transition',
    label: 'Renegotiated',
    color: VX.warnSolid,
    mark: 'bar',
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
    mark: 'bar',
    fillOpacity: 0.18,
    formatValue: (c) => (c.state.kind === 'no-vantage' ? `${c.state.cycles} cycles` : null),
  },
  {
    key: 'absent',
    label: 'Not measured',
    color: VX.neutral,
    mark: 'bar',
    fillOpacity: 0.5,
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
 * returned nothing for (hatched — not measured), a bucket whose cycles reported no link speed at
 * all (faint — measured, but not this), and the speeds themselves.
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
   * `linkBucketState(null)` is `unmeasured`, so an unresolved query hatched every band in the
   * window — a positive claim that the collector ran and reported no link speed for any of it,
   * which on this strip reads as the NIC having gone dark rather than as a question nobody had
   * answered. Same guard, same reason, as `availability-strip.tsx`'s.
   */
  isPending?: boolean
}) {
  const columns: Column[] = useMemo(
    () =>
      densifyBuckets(vantage, { from, to, bucketSeconds }).map((slot) => {
        const state = linkBucketState(slot.value)
        return {
          key: slot.key,
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

  const getBand = useCallback((c: Column) => bandFor(c, maxMbit), [maxMbit])
  const formatX = useMemo(() => bucketTickFormat(bucketSeconds), [bucketSeconds])
  const { ref: viewRef, inView } = useInViewport<HTMLDivElement>()

  return (
    // A floor, not a height — see `availability-strip.tsx`'s identical wrapper.
    <div ref={viewRef} style={{ minHeight: STRIP_FRAME_HEIGHT }}>
      {isPending !== true && <LinkVerdict summary={summariseLink(columns)} />}
      <BandStrip
        data={columns}
        chartId="link-speed-strip"
        getX={getColumnKey}
        series={FILL_SERIES}
        getBand={getBand}
        fold={FOLD}
        height={STRIP_FRAME_HEIGHT}
        margin={STRIP_MARGIN}
        formatX={formatX}
        xTickValues={axisTickValues}
        absentState="absent"
        isPending={isPending === true}
        ariaLabel="Negotiated link speed per bucket, with unmeasured buckets hatched and renegotiations marked rather than averaged"
        // Four states, not four series — there is nothing to toggle.
        legend={{ toggle: false }}
        tooltip={{
          onFollow: inView,
          formatHeader: (_key, c) => fmtDateTime(c.bucketStart),
          label: () => ({ text: 'Link speed', color: VX.line }),
          extraRows: (c) => <StateRows column={c} />,
        }}
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
  // strip's own hatch-vs-faint split already draws.
  const headline =
    mbits.length === 0
      ? noVantage > 0
        ? 'Cycles ran, and none of them reported a link speed'
        : 'No link speed recorded in this window'
      : mbits.length === 1
        ? `Steady at ${mbits[0]} Mbit`
        : `${mbits.map((m) => `${m}`).join(' / ')} Mbit`

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
    // `inline-spacing`'s remedy is a Mantine spacing prop, and `src/charts/**` is the Mantine-free
    // half of this app — there is no prop form to prefer here. Both literals are 6px, under the
    // 10px the guard already treats as legitimate micro-spacing wherever it can tell a CSS
    // declaration from a TSX style object.
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: 6, // theme-allow inline-spacing — micro-spacing, no Mantine prop reachable here
        paddingBottom: 6, // theme-allow inline-spacing — same 6px, same reason
      }}
    >
      <span style={{ color: VX.ink, fontSize: VX.text.sm, fontWeight: 600 }}>{headline}</span>
      {/* `legendText` rather than `text`: this is the same subordinate register as the legend
          directly under the plot, and the two sit within a few px of each other. */}
      <span style={{ color: VX.legendText, fontSize: VX.text.xs }}>· {notes.join(' · ')}</span>
    </div>
  )
}

/**
 * The rows the one derived row cannot carry — see `availability-strip.tsx`'s identical split.
 */
function StateRows({ column }: { column: Column }) {
  // Named whenever more than one source bucket stands behind this band. A partial fold gets its own
  // clause: the band already hatches the unmeasured share, and the tooltip has to say the same
  // thing in words.
  const foldedRow = column.foldedFrom > 1 && (
    <TooltipRow
      color={VX.neutral}
      shape="bar"
      label="Folded from"
      value={
        column.unmeasuredMembers > 0 && column.unmeasuredMembers < column.foldedFrom
          ? `${column.foldedFrom} buckets, ${column.unmeasuredMembers} not measured`
          : `${column.foldedFrom} buckets`
      }
    />
  )

  return (
    <>
      {column.state.kind === 'transition' && (
        <TooltipRow
          color={VX.neutral}
          shape="dot"
          label="Not averaged"
          value="the order within the bucket is unrecorded"
        />
      )}
      {foldedRow}
    </>
  )
}

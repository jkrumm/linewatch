import { useCallback, useMemo } from 'react'
import { areaY } from '@tanstack/charts/area'
import { dot } from '@tanstack/charts/dot'
import { lineY } from '@tanstack/charts/line'
import { decorative } from '@tanstack/charts/mark/decorative'
import { rect } from '@tanstack/charts/rect'
import { ruleX } from '@tanstack/charts/rule'
import {
  CartesianChart,
  chartCurve,
  type ChartMarks,
  type ChartSeries,
  type ChartTooltipRow,
  type PlotContext,
} from 'basalt-ui/charts'
import { VX, alpha } from 'basalt-ui/tokens'
import { useInViewport } from './use-in-viewport'
import { ABSENT_ALPHA, ABSENT_COLOR } from './band-shared'
import type {
  HomeLineVerdict,
  Outage,
  ProbeBucket,
  ProbeBucketSeconds,
  VantageBucket,
} from '../lib/types'
import { densifyBuckets } from '../lib/densify'
import { bucketTickFormat } from '../lib/axis'
import { PROBE_CYCLE_MS } from '../lib/range'
import { fmtDateTime, fmtDuration, fmtMs, fmtPct } from '../lib/format'

/** One position on the time axis. `bucket === null` is a bucket the range route returned no row
 * for: unmeasured, which the chart must draw as its own state rather than as a gap the curve
 * smooths over. `vantage` is the parallel per-bucket record of what those cycles measured
 * *through* — null when the bucket held no cycles at all. `overlayMs` is the second, band-less
 * median: always present on the point (null when there is no `overlay` prop, or the overlay's own
 * bucket at this slot has none), so the drawing code never has to ask the point "does an overlay
 * exist" separately from "what is its value here". */
export type Point = {
  /** The bucket's own start, unix ms: the x value (as a `Date`), the tooltip header's instant and
   * the outage overlay's x-map. The identity is the instant itself — there is no second key to keep
   * in step with it, and nothing is ever regexed back out of a display string. */
  bucketStart: number
  bucket: ProbeBucket | null
  vantage: VantageBucket | null
  overlayMs: number | null
}

/** Stable across renders: `CartesianChart` memoizes on `x`'s identity, and an inline arrow is a new
 * function every render of a page that re-renders on a 30 s heartbeat. */
const getPointX = (p: Point): Date => new Date(p.bucketStart)

/** The overlay line's colour, declared ONCE and read back off the series descriptor by the mark —
 * see `overlay-color.test.ts` for the bug that made that worth spelling out. */
const OVERLAY_COLOR = VX.line2

const HOME_LINE_LABEL: Record<HomeLineVerdict, string> = {
  all: 'Home line',
  none: 'Not the home line',
  mixed: 'Mixed paths',
  unknown: 'Not reported',
}

/** Where the marker ramp steps from amber to red, named once because the legend entries
 * (`loss-partial` / `loss-heavy`) and the gate that decides which dot to draw both read it; `getMarker` reads `lossColor` for the cursor dot. The
 * *Solid* variants, not `VX.good`/`VX.warn`/`VX.bad`: those are area-fill tokens mixed down to
 * 8–18% opacity, right behind a line and invisible on a 3 px marker. */
const HEAVY_LOSS_PCT = 20

function lossColor(lossPct: number): string {
  if (lossPct <= 0) return VX.goodSolid
  if (lossPct < HEAVY_LOSS_PCT) return VX.warnSolid
  return VX.badSolid
}

/** Height of the vantage rail along the bottom axis, and of the outage rail along the top, in px. */
const RAIL_H = 5
const OUTAGE_RAIL_H = 3

/**
 * The top of the y domain: the highest thing any VISIBLE series can put on the plot, padded.
 *
 * Not `resolveAxisDomain`'s own `'auto'`, which reads `getValue` — and `getValue` is the MEDIAN.
 * A domain sized to the medians clips the band and the envelope drawn around them, which is most
 * of what this chart is.
 *
 * Exported for `latency-domain.test.ts`: this is the one piece of the collapsed chart that is not
 * the framework's, and whether it clips a spike is not observable in a render test.
 */
export function domainMax(
  data: readonly Point[],
  visible: readonly ChartSeries<Point>[],
  chartKey: string,
  overlayKey: string,
): number {
  const showPrimary = visible.some((s) => s.key === chartKey)
  const showOverlay = visible.some((s) => s.key === overlayKey)
  const values: number[] = []
  for (const p of data) {
    if (showPrimary && p.bucket !== null) {
      for (const v of [p.bucket.p95Ms, p.bucket.maxMs]) if (v !== null) values.push(v)
    }
    if (showOverlay && p.overlayMs !== null) values.push(p.overlayMs)
  }
  const max = values.length > 0 ? Math.max(...values) : 1
  return Math.max(1, max * 1.15)
}

/**
 * The SmokePing-style signature chart (DESIGN.md's "Latency" view): a median line with a shaded
 * p5–p95 band, loss encoded as marker colour. No shipped kind draws a band between two arbitrary
 * series with per-point loss markers, so this is `CartesianChart` with consumer `marks` — the
 * host owns the plot, the axes, the grid, the cursor, the legend and the tooltip; this file draws
 * only the marks nothing else on the page draws.
 *
 * The x-domain comes from the requested window, never from the response. Three things this chart
 * would otherwise draw as identical blank space are three distinct marks: a bucket that was never
 * measured (a flat `ABSENT_COLOR` column, the strips' encoding), a bucket where every cycle lost
 * every packet (a red band whose opacity is the share of cycles down), and a bucket measured
 * through something other than the home line (a bottom rail).
 *
 * The chart does not know what a target is: it takes a plain `label` and `chartKey` and draws
 * whatever band it is handed, which is what lets the dashboard feed it a *folded* series (the three
 * WAN anchors' median-of-medians) with the same component. `overlay` adds a second, band-less
 * median sharing this chart's y-scale — the router's own RTT over the folded-internet band.
 *
 * **With an overlay the primary takes the accent and the overlay takes the mid grey** — the same
 * ranking `speed-chart` and `throughput-chart` use: the series the chart is ABOUT should be the
 * most visible thing on it. Alone, the primary keeps `VX.line`, the bright neutral. Every mark
 * reads its colour back off `plot.visible`, never off a local literal, so a legend swatch and its
 * mark are the same object (`overlay-color.test.ts` pins it).
 */
export function LatencyBandChart({
  label,
  chartKey,
  buckets,
  vantage,
  from,
  to,
  bucketSeconds,
  isPending,
  overlay,
  extraTooltipRows,
  outages,
}: {
  /** How the primary series is named in the legend, tooltip and accessible label. */
  label: string
  /** Stable identity for the cursor/chart id — must be unique per mounted instance. */
  chartKey: string
  buckets: ProbeBucket[]
  vantage: VantageBucket[]
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
  /**
   * True while the probe-buckets queries behind this band are in flight. Handed to `state`, which
   * also conceals the legend (it declares marks that, while pending, do not exist) without
   * moving the chart when the data arrives.
   */
  isPending?: boolean
  /**
   * A second median line drawn over the band, with no band of its own.
   *
   * `buckets` are matched to the primary series' slots by bucket start, through the same
   * `densifyBuckets` pass — never by array index. The two series are sparse in different places
   * (the gateway can answer a cycle in which no anchor did, and the reverse), so index-aligning
   * them would silently plot one series' reading at another's instant.
   */
  overlay?: {
    label: string
    buckets: readonly ProbeBucket[]
  }
  /**
   * Extra tooltip rows for a bucket the caller knows more about than this chart does.
   *
   * The dashboard feeds this chart a *folded* series whose buckets carry two facts a `ProbeBucket`
   * has no field for: how many anchors the fold was taken over, and the worst loss any single one
   * of them reported. The chart cannot know either, so the caller states them, as data, in its own
   * words. Called only for a measured bucket — an unmeasured slot has nothing extra to say.
   */
  extraTooltipRows?: (bucket: ProbeBucket) => readonly ChartTooltipRow[]
  /**
   * Recorded outages to overlay, already scoped to this chart's own subject by the caller.
   *
   * Drawing a gateway outage across the internet band would assert something the row does not say,
   * so the caller filters by scope and this draws whatever it is handed. Rows are expected to be
   * `GET /api/outages`'s OVERLAP result — an outage that began before `from` arrives whole, which is
   * why both edges are clamped to the plot rather than skipped.
   */
  outages?: readonly Outage[] | undefined
}) {
  const points: Point[] = useMemo(() => {
    const vantageByBucket = new Map(vantage.map((v) => [v.bucket, v]))
    // Densified on the SAME {from, to, bucketSeconds} window as the primary series, so its slot
    // grid lines up bucket-start-for-bucket-start with the primary's — matched below by that start,
    // not by array position.
    const overlayByBucket = overlay
      ? new Map(
          // `densifyBuckets` takes a mutable array; `overlay.buckets` is `readonly` on the public
          // prop so a caller's own array can't be mutated through it — spread a shallow copy in.
          densifyBuckets([...overlay.buckets], { from, to, bucketSeconds }).map((slot) => [
            slot.bucketStart,
            slot.value?.medianMs ?? null,
          ]),
        )
      : null
    return densifyBuckets(buckets, { from, to, bucketSeconds }).map((slot) => ({
      bucketStart: slot.bucketStart,
      bucket: slot.value,
      vantage: vantageByBucket.get(slot.bucketStart) ?? null,
      overlayMs: overlayByBucket?.get(slot.bucketStart) ?? null,
    }))
  }, [buckets, vantage, overlay, from, to, bucketSeconds])

  // What the collector's cadence should have produced in one bucket. Named "expected" wherever it
  // is shown, because it is arithmetic over the configured cadence, not a count of anything.
  const expectedCycles = Math.max(1, Math.round((bucketSeconds * 1000) / PROBE_CYCLE_MS))
  const bucketMs = bucketSeconds * 1000
  const hasOutages = outages !== undefined && outages.length > 0
  const pending = isPending === true

  // Alone, the primary is the bright neutral; against an overlay it takes the accent and the
  // overlay steps down to the mid grey. ONE binding each; the marks read it back off the series.
  const primaryColor = overlay ? VX.accent : VX.line
  const overlayKey = `${chartKey}-overlay`
  const overlayLabel = overlay?.label

  /**
   * The single source of truth for the marks, the legend and the tooltip's per-series rows.
   *
   * Two entries carry a value (the median and the overlay). The others are ENCODINGS — the two
   * loss thresholds, the full-loss band, the unmeasured column, the outage rail — which the legend
   * has to name because they are the marks on this chart a reader cannot decode from the axes.
   * They return `null` from `getValue`, so they are legended and never a tooltip row. All are read
   * back out of `plot.visible` in `latencyMarks` and gate the mark they name, one for one.
   */
  const series = useMemo<ChartSeries<Point>[]>(
    () => [
      {
        key: chartKey,
        label,
        color: primaryColor,
        mark: 'line',
        getValue: (p) => p.bucket?.medianMs ?? null,
        formatValue: fmtMs,
        // The hover dot takes the bucket's worst-loss colour (basalt-ui 2.11.0). `getMarker` only
        // colours a `cursorValue` dot here: `CartesianChart` draws no always-on markers for
        // consumer `marks`, so the loss dots under the line are `latencyMarks`' own.
        cursorValue: (p) => p.bucket?.medianMs ?? null,
        getMarker: (p) => {
          const loss = p.bucket?.maxLossPct ?? 0
          if (loss <= 0 || p.bucket?.medianMs == null) return null
          return { color: lossColor(loss), r: 3, ring: false }
        },
      },
      ...(overlayLabel !== undefined
        ? [
            {
              key: overlayKey,
              label: overlayLabel,
              color: OVERLAY_COLOR,
              mark: 'line' as const,
              role: 'overlay' as const,
              strokeWidth: VX.line2Width,
              getValue: (p: Point) => p.overlayMs,
              formatValue: fmtMs,
            },
          ]
        : []),
      // Two loss entries and not three: `lossColor(0)` is the good token, but a marker is only
      // DRAWN when maxLossPct > 0, so a "No loss" swatch would name a mark this chart never draws.
      {
        key: 'loss-partial',
        label: `Loss under ${HEAVY_LOSS_PCT}%`,
        color: VX.warnSolid,
        mark: 'bar',
        getValue: () => null,
      },
      {
        key: 'loss-heavy',
        label: `Loss ${HEAVY_LOSS_PCT}% or more`,
        color: VX.badSolid,
        mark: 'bar',
        getValue: () => null,
      },
      // A lower `fillOpacity` keeps the washed full-loss band's swatch distinguishable from the
      // solid dot swatches above (the band's own opacity is the share of cycles down).
      {
        key: 'down-band',
        label: 'Cycles fully down',
        color: VX.badSolid,
        mark: 'bar',
        fillOpacity: 0.3,
        getValue: () => null,
      },
      {
        key: 'absent',
        label: 'Not measured',
        color: ABSENT_COLOR,
        mark: 'bar',
        fillOpacity: ABSENT_ALPHA,
        getValue: () => null,
      },
      // `mark: 'line'` — the outage overlay is a thin rail along the top edge, not a filled block.
      ...(hasOutages
        ? [
            {
              key: 'outage',
              label: 'Recorded outage',
              color: VX.badSolid,
              mark: 'line' as const,
              getValue: () => null,
            },
          ]
        : []),
    ],
    [chartKey, label, primaryColor, overlayKey, overlayLabel, hasOutages],
  )

  const marks = useCallback(
    (plot: PlotContext<Point, Date>) =>
      latencyMarks(plot, { chartKey, overlayKey, bucketMs, outages, windowTo: to }),
    [chartKey, overlayKey, bucketMs, outages, to],
  )
  const y = useMemo(
    () => ({
      // The envelope is part of the domain: `maxMs` is the only stored witness of a sub-cycle
      // stall, and a domain sized to p95 alone would clip the very spikes it exists to show. A
      // FUNCTION of the VISIBLE series so toggling the band off rescales to the overlay.
      domain: (data: readonly Point[], visible: readonly ChartSeries<Point>[]) =>
        [0, domainMax(data, visible, chartKey, overlayKey)] as const,
      ticks: 4,
      format: fmtMs,
    }),
    [chartKey, overlayKey],
  )
  const formatX = useMemo(() => bucketTickFormat(bucketSeconds), [bucketSeconds])

  // The viewport gate every follower tooltip on this page needs — see `use-in-viewport.ts`.
  const { ref: viewRef, inView } = useInViewport<HTMLDivElement>()
  const tooltip = useMemo(
    () => ({
      onFollow: inView,
      // From the instant, never from the x value: a header regexed out of an ISO string and
      // rebuilt as a LOCAL date names the previous calendar day after 22:00 local. See
      // `charts/tooltip-header.test.ts`.
      formatHeader: (_x: Date, p: Point) => fmtDateTime(p.bucketStart),
      rows: (p: Point) => [
        ...bucketRows(p, expectedCycles, primaryColor),
        ...outageRows(p, outages ?? [], bucketMs, to),
        ...(p.bucket !== null ? (extraTooltipRows?.(p.bucket) ?? []) : []),
        ...vantageRows(p),
      ],
    }),
    [inView, expectedCycles, primaryColor, outages, bucketMs, to, extraTooltipRows],
  )

  return (
    <div ref={viewRef}>
      <CartesianChart
        data={points}
        x={getPointX}
        series={series}
        marks={marks}
        y={y}
        formatX={formatX}
        height={190}
        // `getX` is a bucket's LEADING EDGE, so containment — not proximity — is what relates a
        // sibling's broadcast instant to a column.
        cursorResolution="leading"
        // The legend is a KEY first and a control second: it is the only place on the page that
        // says what the amber and red dots mean, and `toggle` would let a reader hide the finding
        // they opened the page for. `state` conceals it while pending (basalt-ui 2.10.0).
        legend={{ toggle: false }}
        state={{ pending }}
        tooltip={tooltip}
        ariaLabel={
          overlay
            ? `${label} latency with ${overlay.label} overlaid — median with p5 to p95 band, worst-ping envelope, and unmeasured periods marked${hasOutages ? ', with outages flagged' : ''}`
            : `${label} latency — median with p5 to p95 band, worst-ping envelope, and unmeasured periods marked${hasOutages ? ', with outages flagged' : ''}`
        }
      />
    </div>
  )
}

type MarkOptions = {
  chartKey: string
  overlayKey: string
  bucketMs: number
  outages: readonly Outage[] | undefined
  windowTo: number
}

/**
 * Everything this chart draws that no other chart does — and nothing else. The grid, the axes, the
 * crosshair, the cursor dots, the legend and the tooltip are `CartesianChart`'s.
 *
 * **Every colour is read back off `plot.visible`, never off a local literal**, and `plot.rows(key)`
 * is `[]` for a toggled-off series, so a series absent from the plot draws nothing here.
 *
 * Marks are in data space, so they track resize and the legend. The pixel-sized rails (outage,
 * vantage) are converted at `plot.plotHeight`, the plot area without the axis gutter, so they draw
 * the declared 3 / 5 px (basalt-ui 2.11.0; the first pass reports the frame and re-renders once).
 */
function latencyMarks(
  plot: PlotContext<Point, Date>,
  { chartKey, overlayKey, bucketMs, outages, windowTo }: MarkOptions,
): ChartMarks {
  const { visible } = plot
  const primary = visible.find((s) => s.key === chartKey)
  const overlaySeries = visible.find((s) => s.key === overlayKey)
  const showAbsent = visible.some((s) => s.key === 'absent')
  const showDownBand = visible.some((s) => s.key === 'down-band')
  const showOutages = visible.some((s) => s.key === 'outage')
  // Each loss threshold is gated on its OWN legend entry: one gate for both drew both dot colours
  // or neither and read `loss-heavy` nowhere.
  const showLossPartial = visible.some((s) => s.key === 'loss-partial')
  const showLossHeavy = visible.some((s) => s.key === 'loss-heavy')

  const [yMin, yMax] = plot.yDomain
  const perPx = (yMax - yMin) / Math.max(1, plot.plotHeight)
  const half = bucketMs / 2
  const column = (p: Point) => ({
    x1: new Date(p.bucketStart - half),
    x2: new Date(p.bucketStart + half),
  })

  // Absence, the full-loss band and the vantage rail are properties of the BUCKET, not of the
  // median line, so they read the slot grid off `plot.data`, which no legend toggle empties.
  const slots = plot.data

  const marks: ChartMarks[number][] = []

  // Absence and full-loss are drawn FIRST, before anything decides whether there is a line to
  // draw, so a bucket with nothing to plot still occupies pixels.
  if (showAbsent) {
    const cells = slots.filter((p) => p.bucket === null).map((p) => ({ ...column(p), y0: 0, y1: yMax }))
    if (cells.length > 0) {
      marks.push(
        decorative(
          rect(cells, {
            id: 'absent',
            x1: 'x1',
            x2: 'x2',
            y1: 'y0',
            y2: 'y1',
            fill: ABSENT_COLOR,
            fillOpacity: ABSENT_ALPHA,
            inset: 0,
          }),
        ),
      )
    }
  }

  if (showDownBand) {
    // Opacity carries the measurement: the share of the bucket's cycles that got nothing back. One
    // blip in a 120-cycle hour is a faint tint; a bucket that was down throughout is a solid band.
    // A mark has one opacity, so buckets are grouped by that share in 5% steps.
    const byOpacity = new Map<number, Cell[]>()
    for (const p of slots) {
      if (p.bucket === null || p.bucket.downCycles <= 0) continue
      const share = p.bucket.downCycles / Math.max(1, p.bucket.count)
      const step = Math.round((0.1 + 0.45 * share) * 20) / 20
      const group: Cell[] = byOpacity.get(step) ?? []
      group.push({ ...column(p), y0: 0, y1: yMax })
      byOpacity.set(step, group)
    }
    for (const [opacity, cells] of byOpacity) {
      marks.push(
        decorative(
          rect(cells, {
            id: `down-${opacity}`,
            x1: 'x1',
            x2: 'x2',
            y1: 'y0',
            y2: 'y1',
            fill: VX.badSolid,
            fillOpacity: opacity,
            inset: 0,
          }),
        ),
      )
    }
  }

  const spans = showOutages
    ? outageSpans(slots, outages ?? [], bucketMs, windowTo).map((span) => ({
        x1: new Date(span.start),
        x2: new Date(span.end),
        y0: yMax - OUTAGE_RAIL_H * perPx,
        y1: yMax,
      }))
    : []
  if (spans.length > 0) {
    marks.push(
      decorative(
        rect(spans, {
          id: 'outage-rail',
          x1: 'x1',
          x2: 'x2',
          y1: 'y0',
          y2: 'y1',
          fill: VX.badSolid,
          inset: 0,
        }),
      ),
      // The span's two edges, full height and faint.
      decorative(
        ruleX(
          spans.flatMap((span) => [span.x1, span.x2]),
          { id: 'outage-edge', x: (d: Date) => d, stroke: VX.badSolid, strokeOpacity: 0.5 },
        ),
      ),
    )
  }

  if (primary !== undefined) {
    const rows = plot.rows(chartKey)
    // The worst individual round trip in each bucket. Thin, unfilled and faint so it can never be
    // mistaken for the p5–p95 band it encloses. A null `y` is a gap, never a zero.
    marks.push(
      decorative(
        lineY(
          rows.map((r) => ({ x: r.x, y: r.datum.bucket?.maxMs ?? null })),
          {
            id: 'envelope',
            x: 'x',
            y: 'y',
            stroke: primary.color,
            strokeOpacity: 0.35,
            strokeWidth: 1,
            curve: chartCurve('monotone'),
          },
        ),
      ),
      decorative(
        areaY(
          rows.map((r) => ({ x: r.x, ...bandEdges(r.datum) })),
          {
            id: 'band',
            x: 'x',
            y1: 'p5',
            y2: 'p95',
            fill: primary.color,
            fillOpacity: 0.14,
            curve: chartCurve('monotone'),
          },
        ),
      ),
      // The median, drawn through `plot.rows` so it carries the cursor dot and the tooltip row.
      // `lineWidth` (2.5), not `line2Width` (2): weight is the second half of the primary/overlay
      // ranking, and colour alone had already proved insufficient.
      lineY(rows, {
        id: chartKey,
        x: rowX,
        y: 'y',
        z: 'series',
        stroke: primary.color,
        strokeWidth: primary.strokeWidth ?? VX.lineWidth,
        curve: chartCurve('monotone'),
      }),
    )
  }

  if (overlaySeries !== undefined) {
    // Plain reference line: no band, no loss markers — a null `overlayMs` breaks the line exactly
    // as the primary's median does, so an unmeasured router cycle never interpolates.
    marks.push(
      lineY(plot.rows(overlayKey), {
        id: overlayKey,
        x: rowX,
        y: 'y',
        z: 'series',
        stroke: overlaySeries.color,
        strokeWidth: overlaySeries.strokeWidth ?? VX.line2Width,
        curve: chartCurve('monotone'),
      }),
    )
  }

  if (primary !== undefined) {
    // A marker sits on the bucket's MEDIAN, so a bucket with no median has nowhere honest to put
    // one — and the only such bucket is one where every cycle got nothing back, which the
    // full-loss band already paints in full. Placing a dot at 0 ms would claim a reading.
    for (const heavy of [false, true]) {
      if (heavy ? !showLossHeavy : !showLossPartial) continue
      const dotKey = heavy ? 'loss-heavy' : 'loss-partial'
      const dots = plot
        .rows(chartKey)
        .filter((r) => {
          const b = r.datum.bucket
          return b !== null && b.maxLossPct > 0 && r.y !== null && (b.maxLossPct >= HEAVY_LOSS_PCT) === heavy
        })
      if (dots.length === 0) continue
      marks.push(
        decorative(
          dot(dots, {
            id: dotKey,
            x: rowX,
            y: 'y',
            r: 3,
            fill: visible.find((s) => s.key === dotKey)?.color ?? VX.badSolid,
          }),
        ),
      )
    }
  }

  // The vantage rail. `all` is the only verdict that claims the whole bucket measured this line,
  // so everything else is marked — `unknown` in neutral, since an unreported vantage is not
  // evidence of a failover either.
  for (const [verdict, fill] of [
    ['unknown', VX.neutral],
    ['other', VX.warnSolid],
  ] as const) {
    const cells = slots
      .filter(
        (p) =>
          p.vantage !== null &&
          p.vantage.onHomeLine !== 'all' &&
          (verdict === 'unknown' ? p.vantage.onHomeLine === 'unknown' : p.vantage.onHomeLine !== 'unknown'),
      )
      .map((p) => ({ ...column(p), y0: 0, y1: RAIL_H * perPx }))
    if (cells.length === 0) continue
    marks.push(
      decorative(
        rect(cells, {
          id: `vantage-${verdict}`,
          x1: 'x1',
          x2: 'x2',
          y1: 'y0',
          y2: 'y1',
          fill,
          fillOpacity: 0.8,
          inset: 0,
        }),
      ),
    )
  }

  return marks
}

/**
 * The recorded outages as spans on the drawn grid, clamped to it — never skipped.
 *
 * `GET /api/outages` filters on overlap, not containment, so an outage that began before the window
 * arrives whole. A straddling outage that vanishes is the recorded fact this overlay exists to
 * show, silently dropped; so is one inside a single-bucket window (one slot, no neighbour to
 * measure a step against — the grid edge is the slot's own half-bucket either side).
 */
export function outageSpans(
  slots: readonly Pick<Point, 'bucketStart'>[],
  outages: readonly Pick<Outage, 'startedAt' | 'endedAt'>[],
  bucketMs: number,
  windowTo: number,
): { start: number; end: number }[] {
  const first = slots[0]
  const last = slots[slots.length - 1]
  if (first === undefined || last === undefined) return []
  const gridStart = first.bucketStart - bucketMs / 2
  const gridEnd = last.bucketStart + bucketMs / 2
  return outages
    .map((o) => ({
      start: Math.max(gridStart, o.startedAt),
      end: Math.min(gridEnd, Math.min(o.endedAt ?? windowTo, windowTo)),
    }))
    .filter((span) => span.end - span.start > 0)
}

/** The x channel of a `plot.rows()` row, as an accessor (a field name does not type-check against
 * a generic `X`). */
const rowX = (row: { x: Date }): Date => row.x

/** A rect in data space: x as bucket edges, y as the value range it spans. */
type Cell = { x1: Date; x2: Date; y0: number; y1: number }

/** All three band edges, not just the median. They come from one `GROUP BY` in one CTE today, so
 * they are all-null or all-non-null together and this cannot currently split them — but a band
 * edge silently pinned to the axis is a fabrication that would ship the moment the percentile SQL
 * changes. A partly-null band edge is a gap. */
function bandEdges(p: Point): { p5: number | null; p95: number | null } {
  const b = p.bucket
  if (b === null || b.medianMs === null || b.p5Ms === null || b.p95Ms === null) {
    return { p5: null, p95: null }
  }
  return { p5: b.p5Ms, p95: b.p95Ms }
}

function bucketRows(p: Point, expectedCycles: number, primaryColor: string): ChartTooltipRow[] {
  const bucket = p.bucket
  if (bucket === null) {
    return [
      { label: 'Not measured', value: `0 of ${expectedCycles} expected cycles`, color: ABSENT_COLOR },
    ]
  }
  // No "Median" row: `CartesianChart` derives one from the primary series, labelled with the
  // series' own name. The rows below are the ones no series carries.
  return [
    {
      label: 'p5 – p95',
      value: `${fmtMs(bucket.p5Ms)} – ${fmtMs(bucket.p95Ms)}`,
      color: primaryColor,
      swatch: 'dashed',
    },
    // The envelope's own row: the slowest single round trip in the bucket, the only stored trace
    // of a stall lasting less than one cycle.
    { label: 'Worst ping', value: fmtMs(bucket.maxMs), color: alpha(primaryColor, 0.35) },
    { label: 'Loss', value: fmtPct(bucket.lossPct), color: lossColor(bucket.lossPct) },
    // The marker colour tracks the worst cycle, so name it — labelling it "Loss" made a one-blip
    // hour read as a 100%-loss hour.
    { label: 'Worst cycle', value: fmtPct(bucket.maxLossPct), color: lossColor(bucket.maxLossPct) },
    ...(bucket.downCycles > 0
      ? [{ label: 'Cycles fully down', value: String(bucket.downCycles), color: VX.badSolid }]
      : []),
    {
      label: 'Measured',
      value: `${bucket.count} of ${expectedCycles} expected cycles`,
      color: VX.neutral,
    },
  ]
}

/** The overlaid outages the hovered bucket sits inside, named on the bucket that draws them. One
 * row whatever the count: two outages inside one bucket is a fact about the bucket, not two. */
function outageRows(
  p: Point,
  outages: readonly Outage[],
  bucketMs: number,
  windowTo: number,
): ChartTooltipRow[] {
  const end = p.bucketStart + bucketMs
  const hits = outages.filter(
    (o) => o.startedAt < end && Math.min(o.endedAt ?? windowTo, windowTo) > p.bucketStart,
  )
  if (hits.length === 0) return []
  return [{ label: 'Recorded outage', value: outageValue(hits), color: VX.badSolid }]
}

function outageValue(hits: readonly Outage[]): string {
  const [only] = hits
  if (hits.length > 1 || only === undefined) return `${hits.length} recorded`
  if (only.endedAt === null) return 'ongoing'
  return fmtDuration(only.durationS ?? Math.round((only.endedAt - only.startedAt) / 1000))
}

/**
 * The rail's swatch, matching the rail. `all` is the only verdict that claims the whole bucket
 * measured this line, so it is the only green one — but `unknown` is NOT the same reading as
 * `none`/`mixed`: the rail draws it in neutral, on the grounds that an unreported vantage is not
 * evidence of a failover either, and the tooltip must not contradict it.
 */
function vantageColor(verdict: HomeLineVerdict): string {
  if (verdict === 'all') return VX.goodSolid
  if (verdict === 'unknown') return VX.neutral
  return VX.warnSolid
}

function vantageRows(p: Point): ChartTooltipRow[] {
  const vantage = p.vantage
  if (vantage === null) return []
  return [
    {
      label: 'Vantage',
      value: HOME_LINE_LABEL[vantage.onHomeLine],
      color: vantageColor(vantage.onHomeLine),
    },
    ...(vantage.unknownHomeLineCycles > 0
      ? [
          {
            label: 'Cycles with no vantage',
            value: String(vantage.unknownHomeLineCycles),
            color: VX.neutral,
          },
        ]
      : []),
  ]
}

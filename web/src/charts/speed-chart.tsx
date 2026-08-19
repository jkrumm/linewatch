import { ChartCard, ChartLegend, MultiLine, VX, useChartSize } from 'basalt-ui/charts'
import { useInViewport } from './use-in-viewport'
import type { SpeedTest } from '../lib/types'
import { fmtClock, fmtMbps } from '../lib/format'
import { AXIS_LABEL_PX, fitTickCount, runAxisKey, runTickFormat } from '../lib/axis'
import { useCardTitle, useCompactMode } from '../lib/compact'

/**
 * It was 260, which was headroom above the download trace rather than resolution in it; 190 —
 * matching `latency-band-chart`, the other member of the same "lines over a window" idiom — turned
 * out to be one step too far. Two traces plus two horizontal references need room to sit apart from
 * each other, and at 190 the download line and the carrier-sync reference nearly touch on this
 * line. 220 keeps the cut without collapsing the gap the chart exists to show.
 */
const SPEED_HEIGHT = 220

/**
 * Compact draws this one chart shorter, and only this one.
 *
 * It is the chart with the least shape to lose: two near-flat traces plus two horizontal reference
 * lines, where the reading is *where they sit* against the references, not the wiggle. The latency
 * band and the throughput bars are the opposite — spikes and gaps are the whole content and 130px
 * would flatten them into a smear. So the height reduction is per-chart rather than a global
 * scale factor.
 */
const SPEED_HEIGHT_COMPACT = 160

/**
 * A horizontal reference at a rate the line is measured against — the host's negotiated link speed,
 * the carrier's sync rate.
 *
 * `label` is supplied by the caller and must be derived from the live reading it marks. This
 * component authors no sentence about what a reference means, because any such sentence names a
 * link speed that stops being true the moment the NIC renegotiates — which on this host
 * demonstrably happens. A caller with a null or stale input passes no ref line at all rather than
 * a stale one.
 */
export type SpeedRefLine = {
  value: number
  label: string
  color: string
}

/**
 * Every speed-test run in the window, download against upload.
 *
 * **Titled for its own section, which is the rule now: a chart's title is its section's word.**
 * "Speed" here, "Throughput" a screen down, "Ping" and "Connection health" above. That is not
 * redundancy with the heading — in compact the heading is gone and this title is the only label the
 * card has, so it has to carry the section's meaning on its own.
 *
 * The hazard the old title ("Speed test runs") was avoiding is still avoided, and it is worth
 * restating because the fix looks superficially like the bug: this chart was once called
 * "Throughput", the name of a DIFFERENT section measuring a different thing — what the line
 * actually carried, from the interface counters, rather than what it managed when asked to
 * saturate. One word for two measurements a screen apart is the confusion the Speed/Throughput
 * split exists to prevent. Each chart now takes its OWN section's word, so no word is used twice.
 */
export function SpeedChart({
  tests,
  refLines = [],
  isPending,
}: {
  tests: SpeedTest[]
  refLines?: SpeedRefLine[]
  /**
   * True while the speed-tests query is in flight.
   *
   * `tests ?? []` drew an axis with no points on it — which on a run-series chart is the claim
   * "no speed test ran in this window", not "nobody has asked yet".
   *
   * Handed straight to `MultiLine` now. It used to be branched here, onto an app-side
   * `PendingChart`, because the kind sat inside this chart's own `ResponsiveChart` and its
   * `ChartFrame` therefore never mounted until a `ResizeObserver` had fired — invisible to the
   * server-rendered guard. `ChartFrame` floors its plot rect at `minWidth` (200px) as of 1.15.0,
   * so it renders `ChartPending` whether or not anything has been measured, and the app-side
   * scaffolding is gone.
   *
   * The ref-line legend below is this app's own rather than `ChartFrame`'s, so it still needs
   * suppressing explicitly: a dashed "Host link 1000 Mbit" caption over a plot with no runs on it
   * names a ceiling for measurements that are not on screen.
   */
  isPending?: boolean
}) {
  // Oldest first. `GET /api/speedtests` answers newest-first — right for a list, backwards for a
  // time axis — and this chart plotted it in that order, so time ran right to left while every
  // other chart on the page ran left to right. A reader comparing a dip here against the latency
  // band above was reading two mirrored axes as though they aligned.
  const ordered = tests.toSorted((a, b) => a.ts - b.ts)
  // The key is the run's INSTANT and the label is drawn from it — see `runAxisKey`, including what
  // keying on the instant costs and what it buys (this chart on the page's shared cursor). For two
  // releases this line built a pre-formatted, collision-broken label instead, because `MultiLine`
  // forwarded no formatter and the domain value was the only string that reached the axis.
  const points = ordered.map((test) => ({ test, key: runAxisKey(test.ts) }))
  const [compact] = useCompactMode()
  const height = compact ? SPEED_HEIGHT_COMPACT : SPEED_HEIGHT
  // The container's own width, measured here rather than inside a wrapper the kind renders under.
  // `ResponsiveChart` is gone (1.15.0 has one responsive path, `ChartFrame`, which every kind
  // composes internally) and `useChartSize` is the shipped hook for a box outside the chart system
  // that still needs measuring — which this is, for the one reason below: `xTicks` is a COUNT, and
  // a count that keeps its labels apart can only be derived from a width.
  const { ref: sizeRef, width } = useChartSize()
  // Its own wrapper rather than the measuring div: `useChartSize`'s ref is a CALLBACK ref of
  // unpinned identity, and merging two callback refs inline would detach and re-observe on
  // every render. One layout-neutral div is the cheaper answer.
  const { ref: viewRef, inView } = useInViewport<HTMLDivElement>()
  const plotWidth = Math.max(1, width - VX.margin.left - VX.margin.right)

  return (
    <ChartCard
      title={useCardTitle("Speed")}
      // The unit lives here, not on the y ticks. Formatting each tick as `600 Mbps` was the
      // obvious fix for a unitless axis and it made things worse: `MultiLine` draws its axis inside
      // basalt's shared 44 px gutter, sized for bare numbers, so every tick rendered as the bare
      // word `Mbps` with its number clipped off — a unitless axis replaced by a numberless one.
      // Only the unit survives the copy pass: "one point per run" is in the tooltip and
      // "download against upload" is the legend.
      subtitle="Mbps"
      // The x-axis is categorical: runs are drawn at equal spacing whatever the real interval
      // between them, so say so rather than let the spacing imply a cadence. The sentence also has
      // to carry what that costs the shared cursor now that this chart is on it — a reader watching
      // the crosshair land at a different x on this card than on the band above needs the rule,
      // not a guess.
      tooltip="Ookla runs, one point each, drawn at equal spacing regardless of the gap between them — so the shared cursor marks the run nearest the moment you are hovering, not the same horizontal position. Download and upload share one axis."
    >
      {/* `MultiLine` measures its own width but exposes only a tick *count*, so the count has to be
          derived from a width measured out here. Left to its default, `smartTicks` spaces ticks by
          `VX.minPxPerTick` (55) — sized for the bare `DD.MM` its own formatter produces, not for
          the `DD.MM HH:MM` these run labels carry — and every one of a 24 h window's runs got a
          tick, rendering the axis as one unbroken smear of overlapping timestamps. */}
      {/* See `availability-strip.tsx`'s identical wrapper for why this is a floor, not a height. */}
      <div ref={viewRef}>
        <div ref={sizeRef} style={{ minHeight: height }}>
          <MultiLine
            data={points}
            chartId="speed-throughput"
            ariaLabel="Download against upload in Mbps, one point per speed-test run"
            isPending={isPending === true}
            // The *plot* width, not the container's: the kind spends its measured margins on the
            // axes, and sizing the tick count off the outer width overestimates by ~60 px. Harmless
            // at 1600 px and not at 390, where it was the difference between four legible timestamps
            // and five overlapping ones. `VX.margin` is only a FLOOR on a measured margin now, so
            // this is an estimate rather than the exact gutter — one tick either way, never a
            // clipped label.
            xTicks={fitTickCount(
              points.length,
              Math.max(2, Math.floor(plotWidth / AXIS_LABEL_PX)),
              plotWidth,
            )}
            getX={(p) => p.key}
            formatX={runTickFormat}
            // Numbers on this card while the cursor is on a chart above — see
            // `latency-band-chart`'s `onFollow` for why every chart on this page opts in.
            tooltip={{
              onFollow: inView,
              // The badge carries the run's clock, which the header format drops. It was tolerable
              // while this card was the only thing on screen and is not now: the follower tooltip
              // appears beside three that each name a time to the minute, and a reader comparing
              // them needs to know this one is a run at 04:10 rather than "sometime on the 19th".
              label: (p) => ({ text: fmtClock(p.test.ts), color: VX.legendText }),
            }}
            series={[
              {
                // Accent blue against `VX.line2`, the MID grey — one pair for these two
                // concepts wherever they are drawn, here and in the throughput bars. Not
                // `VX.line`: at 11.1:1 against the panel it is the brightest thing available
                // and makes the secondary series louder than the accent. Not two greys
                // either, which is what this chart's own history warns about.
                key: 'download',
                label: 'Download',
                color: VX.accent,
                mark: 'line',
                getValue: (p) => p.test.downloadMbps,
                formatValue: fmtMbps,
              },
              {
                key: 'upload',
                label: 'Upload',
                color: VX.line2,
                mark: 'line',
                getValue: (p) => p.test.uploadMbps,
                formatValue: fmtMbps,
              },
            ]}
            refLines={refLines.map((ref) => ({
              value: ref.value,
              color: ref.color,
              dashed: true,
            }))}
            // PER-SERIES, not `y.format`. An `AxisConfig.format` is the tick formatter AND the
            // tooltip's — and the unit belongs to the subtitle here, not to every tick (see the
            // `subtitle` prop above, and the clipped-axis bug its comment records). Measured margins
            // would now fit `600 Mbps`, so it would no longer clip; it would just say Mbps five times
            // over a card that already says it once.
            y={{ domain: 'auto' }}
            height={height}
          />
        </div>
      </div>
      {/* `MultiLine` draws ref lines but names none of them, and an unlabelled rule across a
          throughput chart is an assertion the reader has to guess at. The labels ride here, in
          their own reference-role legend, with the numbers their caller measured. */}
      {refLines.length > 0 && isPending !== true && (
        <ChartLegend
          chartId="speed-throughput-refs"
          placement="bottom"
          items={refLines.map((ref) => ({
            key: ref.label,
            label: ref.label,
            color: ref.color,
            shape: 'line' as const,
            dashed: true,
            role: 'reference' as const,
          }))}
        />
      )}
    </ChartCard>
  )
}

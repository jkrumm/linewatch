import { ChartCard, ChartLegend, MultiLine, ResponsiveChart, VX } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'
import { fmtMbps } from '../lib/format'
import { AXIS_LABEL_PX, fitTickCount, runAxisLabels } from '../lib/axis'
import { PendingChart } from './pending'
import { useCompactMode } from '../lib/compact'

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
   * Branched here rather than handed to `MultiLine`'s own `isPending`, even though the kind takes
   * one as of basalt-ui 1.9.0. This chart wraps the kind in its OWN `ResponsiveChart` (it has to —
   * `numTicksX` is derived from a measured plot width, see below), so the kind's `ChartFrame`
   * never mounts until that outer container has been measured, and a pending state that renders
   * nothing until a `ResizeObserver` fires is one no server-rendered test can observe. Replacing
   * the whole wrapper achieves what `ChartFrame`'s own gate would — no plot, no legend, a reserved
   * footprint — and stays visible to the guard.
   *
   * The ref-line legend below is this app's own rather than `ChartFrame`'s, so it needs
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
  // Pre-formatted, because `MultiLine` forwards no `tickFormat` to its x-axis and basalt's own
  // formatter reduces an ISO string to `DD.MM` — a 24 h window drew `01.08` twenty-four times.
  // See `runAxisLabels` for how collisions are avoided, which matters more here than on a bucketed
  // chart: run timestamps are whatever the cron fired at, not a grid.
  const labels = runAxisLabels(ordered.map((t) => t.ts))
  const points = ordered.map((test, i) => ({ test, label: labels[i] ?? '' }))
  const [compact] = useCompactMode()
  const height = compact ? SPEED_HEIGHT_COMPACT : SPEED_HEIGHT

  return (
    <ChartCard
      title="Speed"
      // The unit lives here, not on the y ticks. Formatting each tick as `600 Mbps` was the
      // obvious fix for a unitless axis and it made things worse: `MultiLine` draws its axis inside
      // basalt's shared 44 px gutter, sized for bare numbers, so every tick rendered as the bare
      // word `Mbps` with its number clipped off — a unitless axis replaced by a numberless one.
      // Only the unit survives the copy pass: "one point per run" is in the tooltip and
      // "download against upload" is the legend.
      subtitle="Mbps"
      // The x-axis is categorical: runs are drawn at equal spacing whatever the real interval
      // between them, so say so rather than let the spacing imply a cadence.
      tooltip="Ookla runs, one point each, drawn at equal spacing regardless of the gap between them. Download and upload share one axis."
    >
      {/* `MultiLine` measures its own width but exposes only a tick *count*, so the count has to be
          derived from a width measured out here — the same wrapper the latency comparison used for
          the same reason. Left to its default, every one of a 24 h window's runs got a tick and the
          axis rendered as one unbroken smear of overlapping timestamps. */}
      {/* See `availability-strip.tsx`'s identical wrapper for why this is a floor, not a height. */}
      <div style={{ minHeight: height }}>
        {isPending === true ? (
          <PendingChart height={height} />
        ) : (
          <ResponsiveChart height={height}>
            {({ width }) => {
              // The *plot* width, not the container's: `MultiLine` spends `VX.margin` on its axes, and
              // sizing the tick count off the outer width overestimates by 60 px. Harmless at 1600 px
              // and not at 390, where it was the difference between four legible timestamps and five
              // overlapping ones.
              const plotWidth = Math.max(1, width - VX.margin.left - VX.margin.right)
              return (
                <MultiLine
                  data={points}
                  chartId="speed-throughput"
                  ariaLabel="Download against upload in Mbps, one point per speed-test run"
                  numTicksX={fitTickCount(
                    points.length,
                    Math.max(2, Math.floor(plotWidth / AXIS_LABEL_PX)),
                    plotWidth,
                  )}
                  getX={(p) => p.label}
                  series={[
                    {
                      // `VX.accent`/`VX.line`, not `VX.line`/`VX.line2`: both of the latter resolve to
                      // plain greys and read as one indistinct hue on the dark panel, which on a
                      // two-series chart means the reader cannot tell download from upload without the
                      // legend. The same pair the latency chart uses for its own two-series case.
                      key: 'download',
                      label: 'Download',
                      color: VX.accent,
                      mark: 'line',
                      getValue: (p) => p.test.downloadMbps,
                    },
                    {
                      key: 'upload',
                      label: 'Upload',
                      color: VX.line,
                      mark: 'line',
                      getValue: (p) => p.test.uploadMbps,
                    },
                  ]}
                  refLines={refLines.map((ref) => ({
                    value: ref.value,
                    color: ref.color,
                    dashed: true,
                  }))}
                  yDomain="auto"
                  formatValue={fmtMbps}
                  height={height}
                />
              )
            }}
          </ResponsiveChart>
        )}
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

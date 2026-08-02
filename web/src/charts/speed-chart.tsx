import { ChartCard, ChartLegend, MultiLine, ResponsiveChart, VX } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'
import { fmtMbps } from '../lib/format'
import { AXIS_LABEL_PX, fitTickCount, runAxisLabels } from '../lib/axis'

const SPEED_HEIGHT = 260

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
 * Titled for the runs rather than for the quantity. It was "Throughput", which is the title of a
 * different section on the same page measuring a different thing — what the line actually carried,
 * from the interface counters, rather than what it managed when asked to saturate. Two blocks a
 * screen apart carrying the same word for two different measurements is exactly the confusion the
 * Speed/Throughput split exists to prevent.
 */
export function SpeedChart({ tests, refLines = [] }: { tests: SpeedTest[]; refLines?: SpeedRefLine[] }) {
  // Oldest first. `GET /api/speedtests` answers newest-first — right for a list, backwards for a
  // time axis — and this chart plotted it in that order, so time ran right to left while every
  // other chart on the page ran left to right. A reader comparing a dip here against the latency
  // band above was reading two mirrored axes as though they aligned.
  const ordered = [...tests].sort((a, b) => a.ts - b.ts)
  // Pre-formatted, because `MultiLine` forwards no `tickFormat` to its x-axis and basalt's own
  // formatter reduces an ISO string to `DD.MM` — a 24 h window drew `01.08` twenty-four times.
  // See `runAxisLabels` for how collisions are avoided, which matters more here than on a bucketed
  // chart: run timestamps are whatever the cron fired at, not a grid.
  const labels = runAxisLabels(ordered.map((t) => t.ts))
  const points = ordered.map((test, i) => ({ test, label: labels[i] ?? '' }))

  return (
    <ChartCard
      title="Speed test runs"
      // The unit lives here, not on the y ticks. Formatting each tick as `600 Mbps` was the
      // obvious fix for a unitless axis and it made things worse: `MultiLine` draws its axis inside
      // basalt's shared 44 px gutter, sized for bare numbers, so every tick rendered as the bare
      // word `Mbps` with its number clipped off — a unitless axis replaced by a numberless one.
      subtitle="Download against upload, in Mbps · one point per run"
      // The x-axis is categorical: runs are drawn at equal spacing whatever the real interval
      // between them, so say so rather than let the spacing imply a cadence.
      tooltip="Ookla runs, one point each, drawn at equal spacing regardless of the gap between them. Download and upload share one axis."
    >
      {/* `MultiLine` measures its own width but exposes only a tick *count*, so the count has to be
          derived from a width measured out here — the same wrapper the latency comparison used for
          the same reason. Left to its default, every one of a 24 h window's runs got a tick and the
          axis rendered as one unbroken smear of overlapping timestamps. */}
      <ResponsiveChart height={SPEED_HEIGHT}>
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
              refLines={refLines.map((ref) => ({ value: ref.value, color: ref.color, dashed: true }))}
              yDomain="auto"
              formatValue={fmtMbps}
              height={SPEED_HEIGHT}
            />
          )
        }}
      </ResponsiveChart>
      {/* `MultiLine` draws ref lines but names none of them, and an unlabelled rule across a
          throughput chart is an assertion the reader has to guess at. The labels ride here, in
          their own reference-role legend, with the numbers their caller measured. */}
      {refLines.length > 0 && (
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

import { ChartCard, ChartLegend, MultiLine, VX } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'
import { fmtMbps } from '../lib/format'

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

export function SpeedChart({ tests, refLines = [] }: { tests: SpeedTest[]; refLines?: SpeedRefLine[] }) {
  return (
    <ChartCard
      title="Throughput"
      subtitle="Download / upload · one point per run"
      // The x-axis is categorical: runs are drawn at equal spacing whatever the real interval
      // between them, so say so rather than let the spacing imply a cadence.
      tooltip="Ookla runs, one point each, drawn at equal spacing regardless of the gap between them. Download and upload share one axis."
    >
      <MultiLine
        data={tests}
        chartId="speed-throughput"
        getX={(t) => new Date(t.ts).toISOString()}
        series={[
          {
            key: 'download',
            label: 'Download',
            color: VX.line,
            mark: 'line',
            getValue: (t) => t.downloadMbps,
          },
          {
            key: 'upload',
            label: 'Upload',
            color: VX.line2,
            mark: 'line',
            getValue: (t) => t.uploadMbps,
          },
        ]}
        refLines={refLines.map((ref) => ({ value: ref.value, color: ref.color, dashed: true }))}
        yDomain="auto"
        formatValue={fmtMbps}
        height={260}
      />
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

import { ChartCard, Heatmap, ResponsiveChart, VX } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'
import { fmtMbps } from '../lib/format'

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))

type Cell = { row: string; col: string; download: number }

/** Hourly "when is the line slow" heatmap, per DESIGN.md's "Speed" view. Cell intensity is the
 * deficit from the fastest hour observed in range, so the darkest cells are the slowest hours. */
export function SpeedHeatmap({ tests }: { tests: SpeedTest[] }) {
  const cells: Cell[] = tests.flatMap((t) => {
    if (t.downloadMbps === null) return []
    const d = new Date(t.ts)
    return [{ row: DAY_FORMAT.format(d), col: String(d.getHours()).padStart(2, '0'), download: t.downloadMbps }]
  })
  const rows = [...new Set(cells.map((c) => c.row))]
  const maxDownload = cells.reduce((max, c) => Math.max(max, c.download), 1)

  return (
    <ChartCard
      title="Throughput by hour"
      subtitle="When the line is slow"
      tooltip="Darker cells had lower download throughput that hour, relative to the fastest hour in range."
    >
      <ResponsiveChart height={Math.max(220, rows.length * 15)}>
        {({ width, height }) => (
          <Heatmap
            data={cells}
            width={width}
            height={height}
            chartId="speed-heatmap"
            getRow={(c) => c.row}
            getCol={(c) => c.col}
            getValue={(c) => Math.max(0, maxDownload - c.download)}
            rows={rows}
            cols={HOUR_LABELS}
            color={VX.accent}
            formatValue={(v) => fmtMbps(maxDownload - v)}
            // legend.min/.max are rendered as the strip's two captions, not as gradient colours.
            // Faint end is the low value — and the value here is the deficit from the fastest hour,
            // so faint means fast.
            legend={{ min: 'Fastest', max: 'Slowest' }}
          />
        )}
      </ResponsiveChart>
    </ChartCard>
  )
}

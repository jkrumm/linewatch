import { ChartCard, Heatmap, ResponsiveChart, VX, alpha } from 'basalt-ui/charts'
import type { ProbeBucket } from '../lib/types'
import { fmtPct } from '../lib/format'

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))

type Cell = { row: string; col: string; loss: number }

/** Day × hour availability grid, per DESIGN.md's "Uptime" view. Always the trailing 30 days
 * regardless of the outage list's own range filter — the two answer different questions ("when,
 * over the recent past, did the line dip" vs "list every outage in this period"). */
export function AvailabilityHeatmap({ buckets }: { buckets: ProbeBucket[] }) {
  const cells: Cell[] = buckets.map((b) => {
    const d = new Date(b.bucket)
    return {
      row: DAY_FORMAT.format(d),
      col: String(d.getHours()).padStart(2, '0'),
      loss: b.maxLossPct,
    }
  })
  const rows = [...new Set(cells.map((c) => c.row))]

  return (
    <ChartCard
      title="Availability"
      subtitle="Last 30 days, by hour"
      tooltip="Each cell is one hour's WAN availability — darker means more loss that hour."
    >
      <ResponsiveChart height={Math.max(220, rows.length * 15)}>
        {({ width, height }) => (
          <Heatmap
            data={cells}
            width={width}
            height={height}
            chartId="availability-heatmap"
            getRow={(c) => c.row}
            getCol={(c) => c.col}
            getValue={(c) => c.loss}
            rows={rows}
            cols={HOUR_LABELS}
            color={VX.bad}
            formatValue={(v) => fmtPct(100 - v)}
            legend={{ min: alpha(VX.bad, 0.08), max: VX.bad }}
          />
        )}
      </ResponsiveChart>
    </ChartCard>
  )
}

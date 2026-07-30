import { ChartCard, Heatmap, ResponsiveChart, TooltipRow, VX } from 'basalt-ui/charts'
import type { ProbeBucket } from '../lib/types'
import { fmtPct } from '../lib/format'

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))

type Cell = { row: string; col: string; loss: number; maxLoss: number; downCycles: number }

const cellKey = (row: string, col: string) => `${row}|${col}`

/** Day × hour availability grid, per DESIGN.md's "Uptime" view. Always the trailing 30 days
 * regardless of the outage list's own range filter — the two answer different questions ("when,
 * over the recent past, did the line dip" vs "list every outage in this period").
 *
 * Intensity is the bucket's aggregate `lossPct`, not `maxLossPct`: a single lost cycle in an hour
 * is ~0.03% of that hour, and colouring the cell by the worst cycle painted the whole hour as
 * fully down. The worst cycle and the fully-down count stay in the tooltip, where they inform
 * rather than mislead. */
export function AvailabilityHeatmap({ buckets }: { buckets: ProbeBucket[] }) {
  const cells: Cell[] = buckets.map((b) => {
    const d = new Date(b.bucket)
    return {
      row: DAY_FORMAT.format(d),
      col: String(d.getHours()).padStart(2, '0'),
      loss: b.lossPct,
      maxLoss: b.maxLossPct,
      downCycles: b.downCycles,
    }
  })
  const rows = [...new Set(cells.map((c) => c.row))]
  // Heatmap's renderTooltip is handed the resolved {row, col, value} cell, not the source datum,
  // so the extra columns have to be looked back up by category pair.
  const byCell = new Map(cells.map((c) => [cellKey(c.row, c.col), c]))

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
            // badSolid, not bad: Heatmap builds its own ramp as alpha(color, 0.08) → color, so
            // handing it the 18%-opacity fill token attenuates it twice into near-invisibility.
            color={VX.badSolid}
            formatValue={(v) => fmtPct(100 - v)}
            legend={{ min: 'Fully up', max: 'Worst loss' }}
            renderTooltip={(cell) => {
              const source = byCell.get(cellKey(cell.row, cell.col))
              if (!source) return null
              return (
                <>
                  <TooltipRow
                    color={VX.warnSolid}
                    shape="dot"
                    label="Worst cycle"
                    value={fmtPct(source.maxLoss)}
                  />
                  <TooltipRow
                    color={VX.badSolid}
                    shape="dot"
                    label="Cycles fully down"
                    value={String(source.downCycles)}
                  />
                </>
              )
            }}
          />
        )}
      </ResponsiveChart>
    </ChartCard>
  )
}

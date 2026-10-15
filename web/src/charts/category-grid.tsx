// MIGRATION-STUB(w7): the CategoryGrid row x column grid (cells, hatch, legend, floating tooltip)
import { ChartCard } from 'basalt-ui/charts'
import type { ReactNode } from 'react'

/**
 * What a cell is, which is the whole reason this grid is bespoke rather than basalt-ui's shipped
 * `Heatmap`.
 *
 * `measured` — a real reading; `intensity` (0–1) drives the fill.
 * `absent`   — inside the window, nothing recorded. Hatched, and it gets a tooltip.
 * `failed`   — the measurement ran and did not produce a value (a speed test that errored).
 *
 * `Heatmap` collapses the last two into its own missing-cell case: it fills them with
 * `alpha(VX.neutral, 0.04)` while a zero-loss cell is `alpha(color, 0)` — fully transparent — so an
 * unmeasured hour renders FAINTER than a perfect hour, and its hover handler is gated on the cell
 * existing so it has no tooltip at all. Those are precisely the states this dashboard exists to
 * keep apart.
 */
export type GridCellKind = 'measured' | 'absent' | 'failed'

export type GridCell = {
  row: string
  col: string
  kind: GridCellKind
  /** 0–1. Read only for `measured` cells; the caller decides the scale, and it must be an
   * ABSOLUTE one — a value/max ramp paints the worst cell of a flawless range full-dark. */
  intensity: number
}

export type CategoryGridProps = {
  cells: GridCell[]
  /** Row keys in draw order. Supplied in full, including rows with no cells: an unmeasured day
   * that never enters the data would otherwise vanish and silently compress the calendar. */
  rows: string[]
  cols: string[]
  width: number
  height: number
  chartId: string
  /** Base hue for `measured` cells. */
  color: string
  /** Hue for `failed` cells — hatched in this colour so a failed run cannot read as a slow one. */
  failedColor?: string
  rowLabel?: (row: string) => string
  colLabel?: (col: string) => string
  legend?: { min: string; max: string }
  /** Tooltip body for a cell. Called for every kind, including `absent`. */
  renderTooltip: (cell: GridCell) => ReactNode
}

/**
 * Row × column intensity grid that can draw absence.
 *
 * A `(row, col)` pair with no cell at all is neither measured nor absent — it is **outside the
 * queried window** (the hours of the first day that precede `from`). Those stay an unmarked track
 * with no tooltip, because hatching them would claim a measurement was owed there.
 */
export function CategoryGrid(_props: CategoryGridProps) {
  return <ChartCard state={{ empty: 'Migrating to basalt-ui 2.0' }} />
}

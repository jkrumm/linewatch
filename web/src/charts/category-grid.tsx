import type { ReactNode } from 'react'
import {
  ChartTooltip,
  Group,
  TooltipBody,
  TooltipHeader,
  VX,
  alpha,
  useChartTooltip,
  useTooltipStyles,
} from 'basalt-ui/charts'
import { HatchPattern, hatchFill } from './hatch'

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

const LABEL_FONT_FAMILY = 'var(--basalt-font-mono)'
const PAD_LEFT = 52
const PAD_BOTTOM = 24
const PAD_TOP = 8
const LEGEND_H = 8
const LEGEND_LABEL_H = 16
const CELL_GAP = 2
const CELL_RADIUS = 2
/**
 * Floor opacity for a *measured* cell, so "measured, and the value was zero" always outranks the
 * 0.04 tint of a cell outside the queried window. Mirrors AvailabilityStrip's constant of the same
 * name; the two grids must not disagree about how visible a perfect measurement is.
 */
const MEASURED_FLOOR_ALPHA = 0.14

/**
 * Composite key for the (row, col) cell map.
 *
 * The separator is written as the `\u0000` ESCAPE, never as a literal NUL byte: a raw NUL in
 * the source makes git classify this file as binary, which silently costs every diff, blame
 * and review on it. It is a NUL rather than a printable delimiter because row and column
 * labels are caller-supplied and any printable separator could appear inside one, collapsing
 * two distinct cells into a single key.
 */
const cellKey = (row: string, col: string) => `${row}\u0000${col}`

/**
 * Row × column intensity grid that can draw absence.
 *
 * A `(row, col)` pair with no cell at all is neither measured nor absent — it is **outside the
 * queried window** (the hours of the first day that precede `from`). Those stay an unmarked track
 * with no tooltip, because hatching them would claim a measurement was owed there.
 */
export function CategoryGrid({
  cells,
  rows,
  cols,
  width,
  height,
  chartId,
  color,
  failedColor = VX.warnSolid,
  rowLabel = (r) => r,
  colLabel = (c) => c,
  legend,
  renderTooltip,
}: CategoryGridProps) {
  const tooltipStyles = useTooltipStyles()
  const { tip, show, hide, tooltipRef } = useChartTooltip<GridCell>()
  const absentHatchId = `${chartId}-absent`
  const failedHatchId = `${chartId}-failed`

  const lookup = new Map(cells.map((c) => [cellKey(c.row, c.col), c]))

  // Derived from the labels actually being drawn, never a fixed inset. The row labels are
  // locale-formatted dates, so their width is not knowable at authoring time: the hardcoded 52 px
  // this replaced was sized for an English `30 Jul` and clipped the leading digits off a German
  // `30. Juli`, rendering the axis as `0. Juli` / `1. Aug.` — dates that are not merely ugly but
  // wrong, and wrong in a way that reads as real. Monospace advance is ~0.6em, and the label is
  // right-aligned 6 px off the grid.
  const labelChars = rows.reduce((widest, row) => Math.max(widest, rowLabel(row).length), 0)
  const padLeft = Math.max(PAD_LEFT, Math.ceil(labelChars * VX.axisFont * 0.62) + 10)

  const legendH = legend ? LEGEND_H + LEGEND_LABEL_H : 0
  const gridW = Math.max(0, width - padLeft)
  const gridH = Math.max(0, height - PAD_TOP - PAD_BOTTOM - legendH)
  const cellW = cols.length > 0 ? gridW / cols.length : 0
  const cellH = rows.length > 0 ? gridH / rows.length : 0
  const legendGradientId = `${chartId}-legend`

  return (
    <div style={{ position: 'relative' }}>
      <svg width={width} height={height}>
        <defs>
          <HatchPattern id={absentHatchId} color={VX.neutral} opacity={0.7} size={5} />
          <HatchPattern id={failedHatchId} color={failedColor} opacity={0.9} size={5} />
          {legend && (
            <linearGradient id={legendGradientId} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor={alpha(color, 0.08)} />
              <stop offset="100%" stopColor={color} />
            </linearGradient>
          )}
        </defs>
        <Group left={padLeft} top={PAD_TOP}>
          {rows.flatMap((row, ri) =>
            cols.map((col, ci) => {
              const cell = lookup.get(cellKey(row, col))
              return (
                <rect
                  key={cellKey(row, col)}
                  x={ci * cellW + CELL_GAP / 2}
                  y={ri * cellH + CELL_GAP / 2}
                  width={Math.max(0, cellW - CELL_GAP)}
                  height={Math.max(0, cellH - CELL_GAP)}
                  rx={CELL_RADIUS}
                  fill={cellFill(cell, color, absentHatchId, failedHatchId)}
                  style={{ cursor: cell ? 'pointer' : 'default' }}
                  onMouseMove={(e) => cell && show(cell, e)}
                  onMouseLeave={hide}
                />
              )
            }),
          )}
        </Group>
        <Group left={0} top={PAD_TOP}>
          {rows.map((row, ri) => (
            <text
              key={row}
              x={padLeft - 6}
              y={ri * cellH + cellH / 2 + 4}
              textAnchor="end"
              fontSize={VX.axisFont}
              fontFamily={LABEL_FONT_FAMILY}
              fill={VX.faint}
            >
              {rowLabel(row)}
            </text>
          ))}
        </Group>
        <Group left={padLeft} top={PAD_TOP + gridH}>
          {cols.map((col, ci) => (
            <text
              key={col}
              x={ci * cellW + cellW / 2}
              y={16}
              textAnchor="middle"
              fontSize={VX.axisFont}
              fontFamily={LABEL_FONT_FAMILY}
              fill={VX.faint}
            >
              {colLabel(col)}
            </text>
          ))}
        </Group>
        {legend && (
          <Group left={padLeft} top={PAD_TOP + gridH + PAD_BOTTOM}>
            <rect width={gridW} height={LEGEND_H} rx={2} fill={`url(#${legendGradientId})`} />
            <text
              x={0}
              y={LEGEND_H + 12}
              textAnchor="start"
              fontSize={VX.axisFont}
              fontFamily={LABEL_FONT_FAMILY}
              fill={VX.faint}
            >
              {legend.min}
            </text>
            <text
              x={gridW}
              y={LEGEND_H + 12}
              textAnchor="end"
              fontSize={VX.axisFont}
              fontFamily={LABEL_FONT_FAMILY}
              fill={VX.faint}
            >
              {legend.max}
            </text>
          </Group>
        )}
      </svg>
      <ChartTooltip tip={tip} tooltipRef={tooltipRef} styles={tooltipStyles}>
        {tip && (
          <>
            <TooltipHeader date={rowLabel(tip.data.row)} label={colLabel(tip.data.col)} />
            <TooltipBody>{renderTooltip(tip.data)}</TooltipBody>
          </>
        )}
      </ChartTooltip>
    </div>
  )
}

function cellFill(
  cell: GridCell | undefined,
  color: string,
  absentHatchId: string,
  failedHatchId: string,
): string {
  if (!cell) return alpha(VX.neutral, 0.04)
  if (cell.kind === 'absent') return hatchFill(absentHatchId)
  if (cell.kind === 'failed') return hatchFill(failedHatchId)
  // Floored, never a bare `alpha(color, intensity)`. A measured cell at intensity 0 — a perfect
  // hour, the most common cell on a healthy grid — would otherwise render fully transparent while
  // an out-of-window pad cell above renders at 0.04, i.e. the flawless measurement would be *less*
  // visible than the thing that was never measured. That is the inversion this file's own header
  // criticises in basalt-ui's shipped Heatmap, and AvailabilityStrip already solved it the same way.
  return alpha(color, MEASURED_FLOOR_ALPHA + (1 - MEASURED_FLOOR_ALPHA) * cell.intensity)
}

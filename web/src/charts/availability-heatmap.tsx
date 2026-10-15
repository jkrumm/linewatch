import { useMemo } from 'react'
import { ChartCard, Heatmap, type ChartTooltipRow } from 'basalt-ui/charts'
import { VX } from 'basalt-ui/tokens'
import type { ProbeBucket } from '../lib/types'
import { densifyBuckets } from '../lib/densify'
import { PROBE_CYCLE_MS } from '../lib/range'
import { fmtPct } from '../lib/format'
import { localDayKey, localDayStart, localHourKey } from './local-calendar'
import { dashboard } from '../lib/dashboard-store'

/**
 * The bucket size this grid is a grid OF. Exported so the route's query and the chart cannot
 * disagree: one cell is one hour, and any other bucket size would put two readings in one cell.
 */
export const AVAILABILITY_BUCKET_SECONDS = 3_600

/** Both axes are the reader's own zone — see `local-calendar.ts` for why, and for what happens on
 * the two days a year the local clock and the epoch-aligned bucket grid disagree. */
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
export const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))

/** Loss share at which a cell is painted at full strength. ABSOLUTE, not `value / max`: the
 * default domain is relative to the supplied data, so a month whose worst hour lost 0.02% would
 * paint that hour solid under a legend reading "worst". 5% of an hour's packets is a genuinely bad
 * hour on this line — the 2026-07-30 baseline is 0% loss over 30 packets. */
export const FULL_INTENSITY_LOSS_PCT = 5

/** `Heatmap` reads a `[0, max]` domain by default; this one is fixed so two months compare. */
const DOMAIN = [0, FULL_INTENSITY_LOSS_PCT] as const

/** Pixels per day row. The frame adds the x axis and the gradient legend on top. */
const ROW_PX = 15
const FRAME_CHROME_PX = 64

/** One grid position. `bucket` is `null` for an hour inside the window that nothing was recorded
 * in — which `Heatmap` draws flat neutral WITH a tooltip, unlike a position with no datum at all. */
export type AvailabilityCell = { row: string; col: string; bucket: ProbeBucket | null }

/**
 * The two buckets an autumn fall-back puts in one local hour, combined into the one reading that
 * cell stands for — MAX for the loss shares, SUM for the cycle counts.
 *
 * The same max-never-mean rule `foldColumns` states at length: averaging a fully-down bucket into
 * a clean one describes an hour that never happened. Counts are additive for the same reason they
 * are there, and `count` genuinely can exceed the hour's expected cycles in this one cell — which
 * is correct, because that local hour genuinely ran twice.
 */
function mergeBuckets(a: ProbeBucket | null, b: ProbeBucket | null): ProbeBucket | null {
  if (a === null) return b
  if (b === null) return a
  return {
    ...a,
    lossPct: Math.max(a.lossPct, b.lossPct),
    maxLossPct: Math.max(a.maxLossPct, b.maxLossPct),
    downCycles: a.downCycles + b.downCycles,
    count: a.count + b.count,
  }
}

/**
 * The window's cells and day rows, from the requested window and never from the buckets a response
 * happened to contain: a day nothing was recorded on must still be a row, or the calendar quietly
 * closes up and 30 days of history can render as three — every drawn cell true, the picture false.
 *
 * Merged by CELL, not pushed per slot: two hourly buckets land in one local hour on the autumn
 * fall-back, and a straight push would emit two datums for one coordinate while the grid kept only
 * the later (`Heatmap` indexes by row and column). See `local-calendar.ts`.
 */
export function availabilityCells(
  buckets: ProbeBucket[],
  from: number,
  to: number,
): { cells: AvailabilityCell[]; rows: string[] } {
  const slots = densifyBuckets(buckets, { from, to, bucketSeconds: AVAILABILITY_BUCKET_SECONDS })
  const byCell = new Map<string, AvailabilityCell>()
  for (const slot of slots) {
    const row = localDayKey(slot.bucketStart)
    const col = localHourKey(slot.bucketStart)
    const key = `${row} ${col}`
    const previous = byCell.get(key)
    if (previous === undefined) byCell.set(key, { row, col, bucket: slot.value })
    else previous.bucket = mergeBuckets(previous.bucket, slot.value)
  }
  const cells = [...byCell.values()]
  return { cells, rows: [...new Set(cells.map((c) => c.row))] }
}

/** Intensity is the bucket's aggregate `lossPct`, not `maxLossPct`: a single lost cycle in an hour
 * is ~0.03% of that hour, and colouring the cell by the worst cycle painted the whole hour as
 * fully down. `null` — nothing recorded — is the absent cell, never a zero. */
const cellValue = (c: AvailabilityCell): number | null => c.bucket?.lossPct ?? null

/** The worst cycle and the fully-down count stay in the tooltip, where they inform rather than
 * mislead; an hour nothing was recorded in says so instead of reading as a clean one. */
export function cellRows(c: AvailabilityCell, expectedCycles: number): ChartTooltipRow[] {
  const { bucket } = c
  if (bucket === null)
    return [{ label: 'Not measured', value: `0 of ${expectedCycles} expected cycles`, color: VX.neutral }]
  return [
    { label: 'Worst cycle', value: fmtPct(bucket.maxLossPct), color: VX.warnSolid },
    { label: 'Cycles fully down', value: String(bucket.downCycles), color: VX.badSolid },
    {
      label: 'Measured',
      value: `${bucket.count} of ${expectedCycles} expected cycles`,
      color: VX.neutral,
    },
  ]
}

const formatLoss = (v: number): string => fmtPct(v, 2)
const formatRow = (row: string): string => DAY_FORMAT.format(localDayStart(row))
const getRow = (c: AvailabilityCell): string => c.row
const getCol = (c: AvailabilityCell): string => c.col
const EXPECTED_CYCLES = Math.max(
  1,
  Math.round((AVAILABILITY_BUCKET_SECONDS * 1000) / PROBE_CYCLE_MS),
)
const TOOLTIP = { rows: (c: AvailabilityCell) => cellRows(c, EXPECTED_CYCLES), valueLabel: 'Loss' }
const LEGEND = { label: `Loss per hour — full colour at ${FULL_INTENSITY_LOSS_PCT}%` }

/** Day × hour availability grid, per DESIGN.md's "Uptime" view. Always the trailing 30 days
 * regardless of the outage list's own range filter — the two answer different questions ("when,
 * over the recent past, did the line dip" vs "list every outage in this period").
 *
 * **Absence is a flat neutral cell with a tooltip that says "Not measured".** `Heatmap` fills a
 * `null` value that way (2.8.0: a flat fill, no hatch) and keeps its tooltip when the position
 * carries a datum, so every in-window hour is given one; only the hours of the first day before
 * `from` have no datum, and those are an inert track with no tooltip, as in 1.x.
 *
 * **`isPending` guards the same fabrication `ThroughputChart` had to be given its own for.** The
 * heatmap's query is not in the route loader either, so on the pattern view's first render
 * `heatmapData?.buckets ?? []` densified to every cell absent and every tooltip reading "0 of 30
 * expected cycles" — a claim, over a window nobody had asked about, that thirty days of
 * measurement came back empty. The rows still come from the window, so the frame does not change
 * height when the query resolves. */
export function AvailabilityHeatmap({
  buckets,
  from,
  to,
  isPending,
}: {
  buckets: ProbeBucket[]
  from: number
  to: number
  /** True while the probe-buckets query behind this grid is in flight — see the component docblock. */
  isPending?: boolean
}) {
  const { cells, rows } = useMemo(() => availabilityCells(buckets, from, to), [buckets, from, to])
  const [compact] = dashboard.field.compact.use()

  return (
    <ChartCard
      // Titled in compact only, where there is no section heading to name the block — see
      // `GuidedChart` for the whole rule.
      title={compact ? 'Availability' : undefined}
      subtitle="Last 30 days, by hour of your day"
      info="Each cell is one hour's WAN availability, on your own clock — darker means more loss that hour, up to 5% which paints full. Grey cells were not measured at all, which is not the same as an hour with no loss."
    >
      {/* A floor under the frame: the height is already computed from the row count, this only
          stops it reporting 0 before the first measurement. */}
      <div style={{ minHeight: 220 }}>
        <Heatmap
          data={cells}
          getRow={getRow}
          getCol={getCol}
          getValue={cellValue}
          rows={rows}
          cols={HOUR_LABELS}
          // badSolid, not bad: the ramp is alpha(color, intensity), so handing it the
          // 18%-opacity fill token attenuates it twice into near-invisibility.
          color={VX.badSolid}
          domain={DOMAIN}
          formatValue={formatLoss}
          formatRow={formatRow}
          legend={LEGEND}
          tooltip={TOOLTIP}
          height={Math.max(220, rows.length * ROW_PX + FRAME_CHROME_PX)}
          state={{ pending: isPending === true }}
          ariaLabel="WAN availability by hour of day over the last 30 days, with unmeasured hours marked"
        />
      </div>
    </ChartCard>
  )
}

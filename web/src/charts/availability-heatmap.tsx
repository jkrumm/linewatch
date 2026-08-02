import { ChartCard, ResponsiveChart, TooltipRow, VX } from 'basalt-ui/charts'
import type { ProbeBucket } from '../lib/types'
import { densifyBuckets } from '../lib/densify'
import { PROBE_CYCLE_MS } from '../lib/range'
import { fmtPct } from '../lib/format'
import { CategoryGrid, type GridCell } from './category-grid'
import { localDayKey, localDayStart, localHourKey } from './local-calendar'
import { PendingChart } from './pending'
import { useCardTitle } from '../lib/compact'

/**
 * The bucket size this grid is a grid OF. Exported so the route's query and the chart cannot
 * disagree: one cell is one hour, and any other bucket size would put two readings in one cell.
 */
export const AVAILABILITY_BUCKET_SECONDS = 3_600

/** Both axes are the reader's own zone — see `local-calendar.ts` for why, and for what happens on
 * the two days a year the local clock and the epoch-aligned bucket grid disagree. */
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))

/** Loss share at which a cell is painted at full strength. ABSOLUTE, not `value / max`: the
 * shipped default is relative to the supplied data, so a month whose worst hour lost 0.02% paints
 * that hour solid under a legend reading "worst". 5% of an hour's packets is a genuinely bad hour
 * on this line — the 2026-07-30 baseline is 0% loss over 30 packets. */
const FULL_INTENSITY_LOSS_PCT = 5

const cellKey = (row: string, col: string) => `${row} ${col}`

type Source = { bucket: ProbeBucket | null }

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

/** Day × hour availability grid, per DESIGN.md's "Uptime" view. Always the trailing 30 days
 * regardless of the outage list's own range filter — the two answer different questions ("when,
 * over the recent past, did the line dip" vs "list every outage in this period").
 *
 * Rows and columns come from the requested window, not from the returned buckets. A day nothing
 * was recorded on never entered the old `rows` array at all, so the calendar quietly closed up and
 * 30 days of history could render as three — with every drawn cell true and the picture false.
 *
 * Intensity is the bucket's aggregate `lossPct`, not `maxLossPct`: a single lost cycle in an hour
 * is ~0.03% of that hour, and colouring the cell by the worst cycle painted the whole hour as
 * fully down. The worst cycle and the fully-down count stay in the tooltip, where they inform
 * rather than mislead.
 *
 * **`isPending` guards the same fabrication `ThroughputChart` had to be given its own for.** The
 * heatmap's query is not in the route loader either, so on the pattern view's first render
 * `heatmapData?.buckets ?? []` densified to every cell hatched-absent and every tooltip reading "0
 * of 30 expected cycles" — a claim, over a window nobody had asked about, that thirty days of
 * measurement came back empty. Hatching happens to be the conservative reading here (it never
 * claims the line was up), which is the one thing that kept this milder than `ThroughputChart`'s
 * version of the same bug — but it is the same class, and the fix is the same `isPending` prop. */
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
  const slots = densifyBuckets(buckets, {
    from,
    to,
    bucketSeconds: AVAILABILITY_BUCKET_SECONDS,
  })
  const expectedCycles = Math.max(
    1,
    Math.round((AVAILABILITY_BUCKET_SECONDS * 1000) / PROBE_CYCLE_MS),
  )

  // Merged by CELL, not pushed per slot. Two hourly buckets land in one local hour on the autumn
  // fall-back, and a straight push would emit two `GridCell`s for one coordinate while `sources`
  // kept only the later — the grid drawing one reading and the tooltip reporting the other. See
  // `local-calendar.ts`. `order` keeps the calendar chronological; a `Map` preserves insertion
  // order anyway, but relying on that for the row axis would be an invisible dependency.
  const sources = new Map<string, Source>()
  const order: string[] = []
  const coords = new Map<string, { row: string; col: string }>()
  for (const slot of slots) {
    const row = localDayKey(slot.bucketStart)
    const col = localHourKey(slot.bucketStart)
    const key = cellKey(row, col)
    const previous = sources.get(key)
    if (previous === undefined) {
      sources.set(key, { bucket: slot.value })
      coords.set(key, { row, col })
      order.push(key)
      continue
    }
    previous.bucket = mergeBuckets(previous.bucket, slot.value)
  }

  const cells: GridCell[] = order.map((key) => {
    const { row, col } = coords.get(key)!
    const bucket = sources.get(key)!.bucket
    return {
      row,
      col,
      kind: bucket === null ? 'absent' : 'measured',
      intensity: bucket === null ? 0 : Math.min(1, bucket.lossPct / FULL_INTENSITY_LOSS_PCT),
    }
  })
  // Rows come from the requested WINDOW (`slots`, densified over `from`/`to`), never from the
  // buckets a response happened to contain — so this stays the same 30 rows whether `isPending` is
  // true or not, and the grid height below can't jump the moment the query resolves.
  const rows = [...new Set(cells.map((c) => c.row))]
  const gridHeight = Math.max(220, rows.length * 15)

  return (
    <ChartCard
      title={useCardTitle("Availability")}
      subtitle="Last 30 days, by hour of your day"
      tooltip="Each cell is one hour's WAN availability, on your own clock — darker means more loss that hour, up to 5% which paints full. Hatched cells were not measured at all, which is not the same as an hour with no loss."
    >
      {/* See `availability-strip.tsx`'s identical wrapper for why this is a floor, not a height. Here
          the height itself is already computed (`rows.length * 15`), not fixed — this only stops it
          from momentarily reporting 0 before the first measurement. */}
      <div style={{ minHeight: 220 }}>
        {isPending === true ? (
          <PendingChart height={gridHeight} />
        ) : (
          <ResponsiveChart height={gridHeight}>
            {({ width, height }) => (
              <CategoryGrid
                cells={cells}
                rows={rows}
                cols={HOUR_LABELS}
                width={width}
                height={height}
                chartId="availability-heatmap"
                // badSolid, not bad: the ramp is alpha(color, intensity), so handing it the
                // 18%-opacity fill token attenuates it twice into near-invisibility.
                color={VX.badSolid}
                rowLabel={(row) => DAY_FORMAT.format(localDayStart(row))}
                legend={{ min: 'No loss', max: '≥5% loss' }}
                renderTooltip={(cell) => {
                  const bucket = sources.get(cellKey(cell.row, cell.col))?.bucket ?? null
                  if (bucket === null) {
                    return (
                      <TooltipRow
                        color={VX.neutral}
                        shape="bar"
                        label="Not measured"
                        value={`0 of ${expectedCycles} expected cycles`}
                      />
                    )
                  }
                  return (
                    <>
                      <TooltipRow
                        color={VX.badSolid}
                        shape="bar"
                        label="Loss"
                        value={fmtPct(bucket.lossPct, 2)}
                      />
                      <TooltipRow
                        color={VX.warnSolid}
                        shape="dot"
                        label="Worst cycle"
                        value={fmtPct(bucket.maxLossPct)}
                      />
                      <TooltipRow
                        color={VX.badSolid}
                        shape="dot"
                        label="Cycles fully down"
                        value={String(bucket.downCycles)}
                      />
                      <TooltipRow
                        color={VX.neutral}
                        shape="bar"
                        label="Measured"
                        value={`${bucket.count} of ${expectedCycles} expected cycles`}
                      />
                    </>
                  )
                }}
              />
            )}
          </ResponsiveChart>
        )}
      </div>
    </ChartCard>
  )
}

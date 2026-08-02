import { ChartCard, ResponsiveChart, TooltipRow, VX } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'
import { densifyBuckets } from '../lib/densify'
import { fmtMbps, fmtPct } from '../lib/format'
import { CategoryGrid, type GridCell } from './category-grid'
import { PendingChart } from './pending'

/** One cell is one UTC hour, matching the availability grid so the two calendars on this dashboard
 * are read the same way. Hourly is also the speed test's own cadence (DESIGN.md, "Cadence"). */
const HOUR_SECONDS = 3_600
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
})
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))

/**
 * How far below the fastest hour in range a cell has to be to paint full. ABSOLUTE, unlike the
 * `deficit / maxDeficit` ramp this chart used to hand the shipped `Heatmap`: on a perfectly steady
 * line the slowest hour is the largest deficit there is, so it painted maximally dark under a
 * legend reading "Slowest" — a stable line rendered as a nightly collapse. Half the fastest reading
 * is a real slowdown; 3% below it is not.
 */
const FULL_INTENSITY_DEFICIT_PCT = 50

/**
 * The grid draws at most this many days, however long the selected range is.
 *
 * Not cosmetic. The Speed view offers an `all` range of 365 days, and one row per day × 24 UTC
 * hours is 8 760 cells — past `densifyBuckets`'s slot cap, and unreadable long before it. Clamping
 * to the trailing month keeps this chart answering the question it is for ("which hours of the day
 * are slow") while the throughput line above it keeps the full range. The subtitle states this
 * constant, so the clamp is visible rather than a quiet disagreement with the range selector — as a
 * fixed ceiling, not a `${days} days` readout of the actual span drawn: the page's own range
 * control already states the selection, and echoing its day count here duplicated it every time the
 * selection was already under `MAX_DAYS`.
 */
const MAX_DAYS = 30

type HourRow = { bucket: number; downloads: number[]; failures: SpeedTest[] }

const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10)
const cellKey = (row: string, col: string) => `${row} ${col}`

/** Hourly "when is the line slow" heatmap, per DESIGN.md's "Speed" view.
 *
 * Three cell states, because a failed run used to be dropped by a bare `return []` and so became
 * pixel-identical to an hour nothing ran in: measured, hatched-warn for an hour whose only runs
 * errored, and hatched-neutral for an hour with no run at all. */
export function SpeedHeatmap({
  tests,
  from,
  to,
  isPending,
}: {
  tests: SpeedTest[]
  from: number
  to: number
  /**
   * True while the speed-tests query behind this grid is in flight.
   *
   * `tests ?? []` produced an empty run list, which is not an empty grid: every cell became
   * `absent` and every tooltip read "No run · Not measured", so the pending state rendered as a
   * flat claim that thirty days of hourly speed tests had never fired. The legend said it too —
   * "No successful run", derived from a `fastest` of `null`. Three separate assertions about the
   * line, all of them over a question nobody had answered yet.
   */
  isPending?: boolean
}) {
  const windowFrom = Math.max(from, to - MAX_DAYS * 86_400_000)

  const byHour = new Map<number, HourRow>()
  for (const test of tests) {
    if (test.ts < windowFrom || test.ts > to) continue
    const bucket = Math.floor(test.ts / (HOUR_SECONDS * 1000)) * HOUR_SECONDS * 1000
    const row = byHour.get(bucket) ?? { bucket, downloads: [], failures: [] }
    // `ok` alone is not the gate: a run can report ok with no download figure, and a number that
    // was never measured must not become a data point.
    if (test.ok && test.downloadMbps !== null) row.downloads.push(test.downloadMbps)
    else row.failures.push(test)
    byHour.set(bucket, row)
  }

  const slots = densifyBuckets([...byHour.values()], {
    from: windowFrom,
    to,
    bucketSeconds: HOUR_SECONDS,
  })

  const means = new Map<number, number>()
  for (const slot of slots) {
    const row = slot.value
    if (row === null || row.downloads.length === 0) continue
    means.set(slot.bucketStart, row.downloads.reduce((a, b) => a + b, 0) / row.downloads.length)
  }
  const fastest = means.size > 0 ? Math.max(...means.values()) : null

  const cells: GridCell[] = []
  const sources = new Map<string, { row: HourRow | null; mean: number | null }>()
  for (const slot of slots) {
    const row = dayKey(slot.bucketStart)
    const col = String(new Date(slot.bucketStart).getUTCHours()).padStart(2, '0')
    const mean = means.get(slot.bucketStart) ?? null
    const kind: GridCell['kind'] =
      mean !== null ? 'measured' : slot.value !== null ? 'failed' : 'absent'
    cells.push({
      row,
      col,
      kind,
      intensity:
        mean === null || fastest === null || fastest <= 0
          ? 0
          : Math.min(1, (100 * (fastest - mean)) / fastest / FULL_INTENSITY_DEFICIT_PCT),
    })
    sources.set(cellKey(row, col), { row: slot.value, mean })
  }
  const rows = [...new Set(cells.map((c) => c.row))]

  return (
    <ChartCard
      title="Throughput by hour"
      // Not `` `last ${days} days` `` — the page carries exactly one range control, and restating
      // the selected window's day count here duplicated it whenever the selection was already under
      // `MAX_DAYS`. What this view still has to self-report (the repo's own CLAUDE.md: this is the
      // one block the range does not fully scope) is the structural cap, stated once and
      // unconditionally rather than re-derived from the current selection.
      subtitle={`When the line is slow · never more than the trailing ${MAX_DAYS} days, by UTC hour.`}
      tooltip="Darker cells averaged lower download throughput that hour; a cell paints full at half the fastest hour in range. Hatched cells either had no run or had one that failed — the tooltip says which."
    >
      {/* See `availability-strip.tsx`'s identical wrapper for why this is a floor, not a height. Here
          the height itself is already computed (`rows.length * 15`), not fixed — this only stops it
          from momentarily reporting 0 before the first measurement. */}
      <div style={{ minHeight: 220 }}>
        {isPending === true ? (
          <PendingChart height={Math.max(220, rows.length * 15)} />
        ) : (
          <ResponsiveChart height={Math.max(220, rows.length * 15)}>
            {({ width, height }) => (
              <CategoryGrid
                cells={cells}
                rows={rows}
                cols={HOUR_LABELS}
                width={width}
                height={height}
                chartId="speed-heatmap"
                color={VX.accent}
                rowLabel={(row) => DAY_FORMAT.format(new Date(`${row}T00:00:00Z`))}
                // The captions are the strip's two ends, and they carry the real numbers rather than
                // bare superlatives: "Slowest" over a range-relative ramp was the lie itself.
                legend={{
                  min: fastest === null ? 'No successful run' : `Fastest ${fmtMbps(fastest)}`,
                  max: `≥${FULL_INTENSITY_DEFICIT_PCT}% slower`,
                }}
                renderTooltip={(cell) => {
                  const source = sources.get(cellKey(cell.row, cell.col))
                  const hour = source?.row ?? null
                  const mean = source?.mean ?? null
                  if (hour === null) {
                    return (
                      <TooltipRow
                        color={VX.neutral}
                        shape="bar"
                        label="No run"
                        value="Not measured"
                      />
                    )
                  }
                  return (
                    <>
                      {mean !== null && (
                        <TooltipRow
                          color={VX.accent}
                          shape="bar"
                          label={hour.downloads.length > 1 ? 'Download (mean)' : 'Download'}
                          value={fmtMbps(mean)}
                        />
                      )}
                      {mean !== null && fastest !== null && fastest > 0 && (
                        <TooltipRow
                          color={VX.neutral}
                          shape="bar"
                          label="Below fastest hour"
                          value={fmtPct((100 * (fastest - mean)) / fastest)}
                        />
                      )}
                      {hour.downloads.length > 0 && (
                        <TooltipRow
                          color={VX.neutral}
                          shape="bar"
                          label="Successful runs"
                          value={String(hour.downloads.length)}
                        />
                      )}
                      {hour.failures.length > 0 && (
                        <TooltipRow
                          color={VX.warnSolid}
                          shape="bar"
                          label="Failed runs"
                          value={`${hour.failures.length}${failureReason(hour.failures)}`}
                        />
                      )}
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

/** The first stored error, when there is one. A failed run with no `error` text stays a bare count
 * rather than borrowing another run's reason. */
function failureReason(failures: SpeedTest[]): string {
  const reason = failures.find((f) => f.error !== null)?.error
  return reason === undefined || reason === null ? '' : ` — ${reason}`
}

import { useMemo } from 'react'
import { ChartCard, Heatmap, type ChartTooltipRow } from 'basalt-ui/charts'
import { VX } from 'basalt-ui/tokens'
import type { SpeedTest } from '../lib/types'
import { densifyBuckets } from '../lib/densify'
import { fmtMbps, fmtPct } from '../lib/format'
import { HOUR_LABELS } from './availability-heatmap'
import { localDayKey, localDayStart, localHourKey } from './local-calendar'
import { dashboard } from '../lib/dashboard-store'

/** One cell is one hour of the reader's own day, matching the availability grid so the two
 * calendars on this dashboard are read the same way — `local-calendar.ts` carries the argument for
 * both. Hourly is also the speed test's own cadence (DESIGN.md, "Cadence"). */
const HOUR_SECONDS = 3_600
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/**
 * How far below the fastest hour in range a cell has to be to paint full. ABSOLUTE, unlike a
 * `deficit / maxDeficit` ramp: on a perfectly steady line the slowest hour is the largest deficit
 * there is, so it paints maximally dark under a legend reading "Slowest" — a stable line rendered
 * as a nightly collapse. Half the fastest reading is a real slowdown; 3% below it is not.
 */
export const FULL_INTENSITY_DEFICIT_PCT = 50
const DOMAIN = [0, FULL_INTENSITY_DEFICIT_PCT] as const

/**
 * The grid draws at most this many days, however long the selected range is.
 *
 * Not cosmetic. The Speed view offers an `all` range of 365 days, and one row per day × 24
 * hours is 8 760 cells — past `densifyBuckets`'s slot cap, and unreadable long before it. Clamping
 * to the trailing month keeps this chart answering the question it is for ("which hours of the day
 * are slow") while the throughput line above it keeps the full range. The subtitle states this
 * constant, so the clamp is visible rather than a quiet disagreement with the range selector — as a
 * fixed ceiling, not a `${days} days` readout of the actual span drawn: the page's own range
 * control already states the selection, and echoing its day count here duplicated it every time the
 * selection was already under `MAX_DAYS`.
 */
const MAX_DAYS = 30

const ROW_PX = 15
const FRAME_CHROME_PX = 64

type HourRow = { bucket: number; downloads: number[]; failures: SpeedTest[] }

/** One grid position. `hour` is `null` for an hour nothing ran in; a row with `downloads` empty and
 * `failures` not is an hour whose only runs errored. */
export type SpeedCell = {
  row: string
  col: string
  hour: HourRow | null
  /** Mean download over the hour's successful runs; `null` when it had none. */
  mean: number | null
  /** Percent below the fastest hour in range; `null` exactly when `mean` is. */
  deficitPct: number | null
}

/** The two hourly buckets an autumn fall-back puts in one local hour, combined. Runs concatenate —
 * both sets of runs really did happen in that local hour — and the cell's mean is then taken over
 * the union, which is the same figure it would have been had the clock not moved. */
function mergeHours(a: HourRow | null, b: HourRow | null): HourRow | null {
  if (a === null) return b
  if (b === null) return a
  return {
    bucket: a.bucket,
    downloads: [...a.downloads, ...b.downloads],
    failures: [...a.failures, ...b.failures],
  }
}

const REASON_MAX_CHARS = 80

/** The first stored error's first line, capped. A failed run with no `error` text stays a bare count
 * rather than borrowing another run's reason. The cap is not cosmetic: the speedtest CLI's
 * licence-prompt failure stores ~2 KB of multi-line text, which broke the tooltip's layout. */
export function failureReason(failures: SpeedTest[]): string {
  const raw = failures.find((f) => f.error !== null)?.error
  const line = raw?.split('\n').find((l) => l.trim() !== '')?.trim()
  if (!line) return ''
  return ` — ${line.length > REASON_MAX_CHARS ? `${line.slice(0, REASON_MAX_CHARS - 1)}…` : line}`
}

/**
 * The window's cells, day rows and the fastest hour's mean.
 *
 * Slots are folded onto their LOCAL cell before any mean is taken, because the fall-back hour puts
 * two of them in one cell and a mean of the union is not the mean of two means. See
 * `local-calendar.ts`.
 */
export function speedCells(
  tests: SpeedTest[],
  from: number,
  to: number,
): { cells: SpeedCell[]; rows: string[]; fastest: number | null } {
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

  const byCell = new Map<string, SpeedCell>()
  for (const slot of slots) {
    const row = localDayKey(slot.bucketStart)
    const col = localHourKey(slot.bucketStart)
    const key = `${row} ${col}`
    const previous = byCell.get(key)
    if (previous === undefined)
      byCell.set(key, { row, col, hour: slot.value, mean: null, deficitPct: null })
    else previous.hour = mergeHours(previous.hour, slot.value)
  }

  const cells = [...byCell.values()]
  for (const cell of cells) {
    const runs = cell.hour?.downloads ?? []
    if (runs.length > 0) cell.mean = runs.reduce((a, b) => a + b, 0) / runs.length
  }
  const means = cells.map((c) => c.mean).filter((m): m is number => m !== null)
  const fastest = means.length > 0 ? Math.max(...means) : null
  for (const cell of cells) {
    // A measured hour always has a value: when the fastest mean is itself 0 nothing is slower than
    // it, so the deficit is 0 — never `null`, which is the absent fill.
    if (cell.mean !== null && fastest !== null)
      cell.deficitPct = fastest > 0 ? (100 * (fastest - cell.mean)) / fastest : 0
  }
  return { cells, rows: [...new Set(cells.map((c) => c.row))], fastest }
}

/**
 * What `Heatmap`'s own value row cannot say: the run counts and the failure reason. The three
 * states are told apart by their fill (`speedCellState`) and the value row names the state, so an
 * hour nothing ran in has no row of its own to add.
 */
export function speedCellRows(c: SpeedCell): ChartTooltipRow[] {
  const { hour, mean } = c
  if (hour === null) return []
  const rows: ChartTooltipRow[] = []
  if (mean !== null)
    rows.push({
      label: hour.downloads.length > 1 ? 'Download (mean)' : 'Download',
      value: fmtMbps(mean),
      color: VX.accent,
    })
  if (hour.downloads.length > 0)
    rows.push({ label: 'Successful runs', value: String(hour.downloads.length), color: VX.neutral })
  if (hour.failures.length > 0)
    rows.push({
      label: 'Failed runs',
      value: `${hour.failures.length}${failureReason(hour.failures)}`,
      color: VX.warnSolid,
    })
  return rows
}

const getRow = (c: SpeedCell): string => c.row
const getCol = (c: SpeedCell): string => c.col
const getValue = (c: SpeedCell): number | null => c.deficitPct

/** The two non-measurements, each its own fill. `failed` is an hour whose only runs errored;
 * `absent` an hour nothing ran in. Neither is a zero and neither stretches the ramp's domain. */
export type SpeedCellState = 'failed' | 'absent'
export const speedCellState = (c: SpeedCell): SpeedCellState | undefined => {
  if (c.hour === null) return 'absent'
  return c.mean === null ? 'failed' : undefined
}
const STATES = [
  { key: 'failed', label: 'Failed run', color: VX.status.warn, fillOpacity: 0.6 },
  { key: 'absent', label: 'No run', color: VX.neutral, fillOpacity: 0.12 },
] as const

// The tooltip's value row carries the unit; the legend labels its two ends only, so it gets the
// compact form (`formatLegend`) and the row gets the sentence.
const formatValue = (v: number): string => `${fmtPct(v)} below the fastest hour`
const formatLegend = (v: number): string => fmtPct(v)
const formatRow = (row: string): string => DAY_FORMAT.format(localDayStart(row))
const TOOLTIP = { rows: speedCellRows, valueLabel: 'Slowdown' }

/** Hourly "when is the line slow" heatmap, per DESIGN.md's "Speed" view.
 *
 * Three cell states, because a failed run used to be dropped by a bare `return []` and so became
 * pixel-identical to an hour nothing ran in: measured (a ramp), failed (an hour whose only runs
 * errored) and absent (an hour with no run at all). Since basalt-ui 2.11.0 each has its own fill
 * (`getState`/`states`) and the legend names the two non-measurements. */
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
  const { cells, rows, fastest } = useMemo(() => speedCells(tests, from, to), [tests, from, to])
  const [compact] = dashboard.field.compact.use()
  // The caption carries the real figure rather than a bare superlative: "Slowest" over a
  // range-relative ramp was the lie itself. While pending `state` conceals the legend, so the
  // "No successful run" a `fastest` of `null` would print is never readable over an unanswered query.
  const legend = {
    label:
      fastest === null
        ? 'No successful run'
        : `% below the fastest hour (${fmtMbps(fastest)}) — full colour at ${FULL_INTENSITY_DEFICIT_PCT}%`,
  }

  return (
    <ChartCard
      // Titled in compact only, where there is no section heading to name the block — see
      // `GuidedChart` for the whole rule.
      title={compact ? 'Throughput by hour' : undefined}
      // Not `` `last ${days} days` `` — the page carries exactly one range control, and restating
      // the selected window's day count here duplicated it whenever the selection was already under
      // `MAX_DAYS`. What this view still has to self-report (the repo's own AGENTS.md: this is the
      // one block the range does not fully scope) is the structural cap, stated once and
      // unconditionally rather than re-derived from the current selection.
      subtitle={`When the line is slow · never more than the trailing ${MAX_DAYS} days, by hour of your day.`}
      info="Darker cells averaged lower download throughput that hour; a cell paints full at half the fastest hour in range. Amber cells only had runs that failed; grey cells had no run at all."
    >
      {/* A floor under the frame: the height is already computed from the row count, this only
          stops it reporting 0 before the first measurement. */}
      <div style={{ minHeight: 220 }}>
        <Heatmap
          data={cells}
          getRow={getRow}
          getCol={getCol}
          getValue={getValue}
          rows={rows}
          cols={HOUR_LABELS}
          color={VX.accent}
          domain={DOMAIN}
          formatValue={formatValue}
          formatLegend={formatLegend}
          getState={speedCellState}
          states={STATES}
          formatRow={formatRow}
          legend={legend}
          tooltip={TOOLTIP}
          height={Math.max(220, rows.length * ROW_PX + FRAME_CHROME_PX)}
          state={{ pending: isPending === true }}
          ariaLabel="Download throughput by hour of day, with hours that had no run or a failed run marked"
        />
      </div>
    </ChartCard>
  )
}

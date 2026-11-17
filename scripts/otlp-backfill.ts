/**
 * One-time replay of the SQLite history through the export path, with the rows'
 * original timestamps. Run on the mini once the live export is on:
 *
 *   make otlp-backfill
 *
 * Resumable (the position is stored per batch in `export_cursor`), rate-limited
 * (`LINEWATCH_BACKFILL_DELAY_MS`, 1 s between batches by default: ~2,600 batches, ~45 min, ~3 GB of JSON for four months), and bounded
 * to what existed when the export first ran — the live tail owns everything after,
 * so no row goes out twice. A finished stream is skipped on a rerun.
 */
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { createExporter } from '../src/export/index.js'

const exporter = createExporter()
if (exporter === null) {
  console.error('LINEWATCH_OTLP_ENDPOINT is not set (or not a URL): nothing to export to')
  process.exit(2)
}
exporter.ensureCursors()

const delayMs = Number(process.env['LINEWATCH_BACKFILL_DELAY_MS'] ?? 1000)
let lastLine = 0
// The agent's memory limiter answers 503 when it is saturated. The position is stored per batch,
// so a refused batch is simply retried after a pause; only a long outage of the agent ends the run.
const MAX_REFUSALS = 30
let refusals = 0
let reports: Awaited<ReturnType<typeof exporter.backfill>> = []
for (;;) {
  try {
    reports = await exporter.backfill({
      delayMs,
      onBatch: (report) => {
        refusals = 0
        const now = Date.now()
        if (now - lastLine < 5_000) return
        lastLine = now
        console.log(
          `  ${report.stream}: ${report.rows} rows, ${report.points} points, ${report.logs} logs`,
        )
      },
    })
    break
  } catch (error) {
    refusals += 1
    if (refusals > MAX_REFUSALS) throw error
    console.error(
      `  batch refused (${refusals}/${MAX_REFUSALS}): ${error instanceof Error ? error.message : String(error)} — retrying in 30 s`,
    )
    await Bun.sleep(30_000)
  }
}

console.log('\nbackfill sent (this run):')
let rows = 0
for (const report of reports) {
  rows += report.rows
  console.log(
    `  ${report.stream.padEnd(14)} ${String(report.rows).padStart(9)} rows  ${String(report.points).padStart(10)} points  ${String(report.logs).padStart(5)} logs`,
  )
}
console.log(`  ${'total'.padEnd(14)} ${String(rows).padStart(9)} rows`)

console.log('\nstate (rows at or below each stream start, all runs):')
for (const row of db.all<{ stream: string; start: number; backfilled_at: number | null }>(
  sql`SELECT stream, start, backfilled_at FROM export_cursor ORDER BY stream`,
)) {
  console.log(
    `  ${row.stream.padEnd(14)} start=${row.start} ${row.backfilled_at === null ? 'NOT FINISHED' : 'done'}`,
  )
}

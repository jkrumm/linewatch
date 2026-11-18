import { Cron } from 'croner'
import { sql } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { exportCursor } from '../db/schema.js'
import type * as schema from '../db/schema.js'
import { STREAMS } from '../export/streams.js'

/**
 * Retention floor. The longest lookback anything automatic reads is the watchdog's
 * 48 h arming window over `router_line_sample` (Makefile `READINESS_WINDOW_H`) and its
 * 2-day action ledger. Thirty days is the least that keeps every automatic
 * reader far inside the store.
 */
export const MIN_RETENTION_DAYS = 30

/** Rows deleted per statement: small enough that the single connection is never held for long. */
const DELETE_BATCH = 5_000
const PAUSE_BETWEEN_BATCHES_MS = 100

type Db = BunSQLiteDatabase<typeof schema>

/**
 * Each pruned table, the export stream that carries it, and how a row is proven
 * exported. `id` tables compare against the stream's cursor; `probe_cycle` has no
 * stream of its own (its path attributes ride on the probe samples), so it is
 * bounded by the timestamp of the newest exported probe sample.
 *
 * Kept on purpose, so absent here: `outage`, `event` and `speed_test` (small, and
 * the record of what happened), and `router_eth_port` / `router_host` (not samples;
 * about 12k rows in four months).
 */
const PRUNED: readonly { table: string; stream: string; byTs?: boolean }[] = [
  { table: 'probe_sample', stream: 'probe' },
  { table: 'probe_cycle', stream: 'probe', byTs: true },
  { table: 'wifi_sample', stream: 'wifi' },
  { table: 'router_line_sample', stream: 'router_line' },
  { table: 'router_wan_sample', stream: 'router_wan' },
  { table: 'router_intf_sample', stream: 'router_intf' },
]

export type RetentionResult =
  | { ran: true; cutoffMs: number; deleted: Record<string, number> }
  | { ran: false; reason: string }

/**
 * Deletes high-volume samples older than `days` that the export has delivered.
 * Refuses unless every stream's backfill has finished: until then SQLite is the
 * only copy of the history this would remove. A row the live tail has not reached
 * yet is also kept, so a long outage of the agent cannot turn into data loss.
 */
export async function runRetention(
  database: Db,
  options: { days: number; now?: number; pauseMs?: number },
): Promise<RetentionResult> {
  if (options.days < MIN_RETENTION_DAYS) {
    return {
      ran: false,
      reason: `retention of ${options.days} days is under the ${MIN_RETENTION_DAYS}-day floor`,
    }
  }
  const cursors = new Map(
    database
      .select()
      .from(exportCursor)
      .all()
      .map((row) => [row.stream, row]),
  )
  const unfinished = STREAMS.filter((stream) => cursors.get(stream.name)?.backfilledAt == null)
  if (unfinished.length > 0) {
    return {
      ran: false,
      reason: `backfill not finished for ${unfinished.map((stream) => stream.name).join(', ')}`,
    }
  }

  const cutoffMs = (options.now ?? Date.now()) - options.days * 86_400_000
  const deleted: Record<string, number> = {}
  for (const { table, stream, byTs } of PRUNED) {
    const cursor = cursors.get(stream)?.cursor ?? 0
    // Table names come from the constant above, never from input.
    const exportedBound = byTs
      ? `ts <= (SELECT ts FROM probe_sample WHERE id = ${cursor})`
      : `id <= ${cursor}`
    let total = 0
    for (;;) {
      const changes = database.all(
        sql.raw(
          `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ts < ${cutoffMs} AND ${exportedBound} LIMIT ${DELETE_BATCH}) RETURNING id`,
        ),
      ).length
      total += changes
      if (changes < DELETE_BATCH) break
      await Bun.sleep(options.pauseMs ?? PAUSE_BETWEEN_BATCHES_MS)
    }
    deleted[table] = total
  }
  return { ran: true, cutoffMs, deleted }
}

/**
 * The daily job, off unless `LINEWATCH_RETENTION_DAYS` is set. It deletes only; the
 * single VACUUM that returns the space is `make db-vacuum`, because a VACUUM inside
 * this process would hold the one connection the whole API shares.
 */
export function startRetention(): Cron | null {
  const days = config.retentionDays
  if (days === null) return null
  return new Cron('30 3 * * *', async () => {
    try {
      const result = await runRetention(db, { days })
      console.log(`[retention] ${JSON.stringify(result)}`)
    } catch (error) {
      console.error(`[retention] failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

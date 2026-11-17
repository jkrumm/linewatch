import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import type * as schema from './schema.js'
import { bucketProbes, bucketVantage } from './bucket-probes.js'
import { bucketThroughput } from './bucket-throughput.js'
import { rangeSummary } from './range-summary.js'
import { collectVerdictInput } from '../lib/verdict-queries.js'

/**
 * The range reads that scan a window of `probe_sample` / `probe_cycle`.
 *
 * They are synchronous (bun:sqlite) and a 30-day window costs seconds of CPU —
 * measured 2026-11-14: `/api/probes` 7 s, `/api/outages` 3 s, `/api/verdicts`
 * 4 s once the cross join was gone, more on a loaded host. On the main thread
 * every one of those is a window in which the app answers nothing, including the
 * collector's POST, the heartbeat's read and `/health`, and the dashboard's
 * 30–60 s refetch of six such routes kept the queue full. Twice that night the
 * line monitor went down for a line that was fine. They run in a worker on their
 * own read-only connection instead (`heavy-read-worker.ts`); WAL lets it read
 * while the main thread writes.
 *
 * Nothing here may touch the main thread's connection — the worker has its own.
 */
const HEAVY_READS = {
  bucketProbes,
  bucketVantage,
  bucketThroughput,
  rangeSummary,
  collectVerdictInput,
} as const

export type HeavyReadName = keyof typeof HEAVY_READS
export type HeavyReadParams<K extends HeavyReadName> = Parameters<(typeof HEAVY_READS)[K]>[1]
export type HeavyReadResult<K extends HeavyReadName> = ReturnType<(typeof HEAVY_READS)[K]>

export type WorkerRequest =
  | { type: 'init'; dbPath: string }
  | { type: 'read'; id: number; name: HeavyReadName; params: unknown }

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }

/** Runs one heavy read against `db`. The worker's and the in-memory test path's shared body. */
export function runHeavyRead(
  db: BunSQLiteDatabase<typeof schema>,
  name: HeavyReadName,
  params: unknown,
): unknown {
  const read = HEAVY_READS[name] as (
    db: BunSQLiteDatabase<typeof schema>,
    params: unknown,
  ) => unknown
  return read(db, params)
}

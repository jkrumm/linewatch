import { eq } from 'drizzle-orm'
import { exportCursor } from '../db/schema.js'
import type { Sink } from './otlp.js'
import { STREAMS } from './streams.js'
import type { Db, MapContext, Stream } from './streams.js'

/** Rows read per batch. A probe row is up to 8 points: 500 rows is ~1 MB of JSON. */
export const DEFAULT_BATCH_ROWS = 500

/** A tick that is far behind (the agent was away) catches up this many batches at a time. */
const MAX_BATCHES_PER_TICK = 20

export interface StreamReport {
  stream: string
  rows: number
  points: number
  logs: number
}

export interface BackfillOptions {
  /** Pause after each accepted batch, so a replay of months cannot saturate the agent. */
  delayMs: number
  onBatch?: (report: StreamReport) => void
}

/**
 * Exports what SQLite has recorded as OTLP, reading it back rather than being
 * called from the write paths. That is the whole reason it cannot affect them: no
 * hook runs inside the probe ingest or the router poll, a rolled-back transaction
 * is never exported, and a refused batch is simply read again next tick, because
 * the cursor moves only after the agent accepted it. Delivery is at-least-once;
 * the cursor commit and the send are not one atomic step, so a crash between them
 * repeats one batch.
 */
export class Exporter {
  private readonly batchRows: number

  constructor(
    private readonly db: Db,
    private readonly sink: Sink,
    private readonly ctx: MapContext,
    batchRows: number = DEFAULT_BATCH_ROWS,
  ) {
    this.batchRows = batchRows
  }

  /**
   * First run: start every stream's live tail at what is already recorded; the
   * history below that line is the backfill's. Idempotent, and shared by the app
   * and the backfill script, so whichever runs first fixes the line.
   */
  ensureCursors(): void {
    for (const stream of STREAMS) {
      const head = stream.head(this.db)
      this.db
        .insert(exportCursor)
        .values({ stream: stream.name, cursor: head, start: head, updatedAt: Date.now() })
        .onConflictDoNothing()
        .run()
    }
  }

  private cursorRow(stream: Stream) {
    const row = this.db
      .select()
      .from(exportCursor)
      .where(eq(exportCursor.stream, stream.name))
      .get()
    if (!row) throw new Error(`no export cursor for ${stream.name}: ensureCursors() first`)
    return row
  }

  /**
   * One live pass over every stream. Throws on the first refused batch, leaving
   * that stream's cursor where it was. Returns the rows exported.
   */
  async tick(): Promise<number> {
    let exported = 0
    for (const stream of STREAMS) {
      let cursor = this.cursorRow(stream).cursor
      for (let batches = 0; batches < MAX_BATCHES_PER_TICK; batches += 1) {
        const step = stream.step(this.db, {
          after: cursor,
          upTo: null,
          limit: this.batchRows,
          ctx: this.ctx,
        })
        if (step === null) break
        await this.sink.send(step.batch)
        cursor = step.lastKey
        this.db
          .update(exportCursor)
          .set({ cursor, updatedAt: Date.now() })
          .where(eq(exportCursor.stream, stream.name))
          .run()
        exported += step.rows
        if (step.rows < this.batchRows) break
      }
    }
    return exported
  }

  /**
   * Replays everything at or below each stream's `start`, with the rows' own
   * timestamps. Resumable: the position is stored per batch, a finished stream is
   * skipped, and a refused batch throws with the position intact.
   */
  async backfill(options: BackfillOptions): Promise<StreamReport[]> {
    const reports: StreamReport[] = []
    for (const stream of STREAMS) {
      const report: StreamReport = { stream: stream.name, rows: 0, points: 0, logs: 0 }
      reports.push(report)
      const row = this.cursorRow(stream)
      if (row.backfilledAt !== null) continue
      let position = row.backfillCursor
      for (;;) {
        const step = stream.step(this.db, {
          after: position,
          upTo: row.start,
          limit: this.batchRows,
          ctx: this.ctx,
        })
        if (step === null) break
        await this.sink.send(step.batch)
        position = step.lastKey
        this.db
          .update(exportCursor)
          .set({ backfillCursor: position, updatedAt: Date.now() })
          .where(eq(exportCursor.stream, stream.name))
          .run()
        report.rows += step.rows
        report.points += step.batch.points.length
        report.logs += step.batch.logs.length
        options.onBatch?.(report)
        if (options.delayMs > 0) await Bun.sleep(options.delayMs)
      }
      this.db
        .update(exportCursor)
        .set({ backfilledAt: Date.now(), updatedAt: Date.now() })
        .where(eq(exportCursor.stream, stream.name))
        .run()
    }
    return reports
  }
}

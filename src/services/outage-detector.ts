import { and, eq, isNull } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { outage } from '../db/schema.js'
import type * as schema from '../db/schema.js'

export type Scope = 'gateway' | 'wan'

export interface TargetCycleResult {
  target: string
  scope: Scope
  /** true when this target's cycle had zero received replies. */
  down: boolean
}

interface OpenOutage {
  id: number
  startedAt: number
  /** ts of the most recently processed cycle for this outage — the idempotency watermark. */
  lastTs: number
  cycles: number
}

/**
 * The outage state machine (docs/DESIGN.md "outage"). One open outage row per
 * scope at a time. `scope` is `gateway` when the gateway target itself is
 * down, `wan` when every wan-scoped target is down in the same cycle.
 *
 * Injected `db` (ports-and-adapters — see rules/code-style.md) rather than
 * importing the app singleton, so tests run against a throwaway in-memory
 * database with no process-level config/token dependency.
 */
export class OutageDetector {
  private readonly open = new Map<Scope, OpenOutage>()
  private loaded = false

  constructor(private readonly db: BunSQLiteDatabase<typeof schema>) {}

  /**
   * Reload any outage rows still open (`ended_at IS NULL`) from the DB — call
   * once on boot so a process restart resumes an in-flight outage instead of
   * losing it or opening a duplicate. Idempotent; safe to call more than once.
   */
  load(): void {
    const rows = this.db.select().from(outage).where(isNull(outage.endedAt)).all()
    this.open.clear()
    for (const row of rows) {
      // lastTs is unknown across a restart — startedAt is the best available
      // watermark, so a replay of the exact opening cycle (the only cycle a
      // freshly-booted process could possibly have seen before) is still caught.
      this.open.set(row.scope, { id: row.id, startedAt: row.startedAt, lastTs: row.startedAt, cycles: row.cycles })
    }
    this.loaded = true
  }

  /**
   * Feed one probe cycle's per-target results. Opens an outage row on the
   * first failing cycle for a scope, extends it (`cycles += 1`) on each
   * subsequent failing cycle, and closes it (`ended_at`, `duration_s`) on the
   * first recovering cycle. A cycle whose `ts` is not newer than the scope's
   * last-processed cycle is a no-op — protects a spool replay from
   * double-counting an already-ingested cycle.
   */
  ingest(ts: number, results: TargetCycleResult[]): void {
    if (!this.loaded) this.load()

    const gatewayResult = results.find((r) => r.scope === 'gateway')
    const gatewayDown = gatewayResult?.down ?? false
    const gatewayEvidence = gatewayDown && gatewayResult ? [gatewayResult.target] : []
    this.evaluateScope('gateway', ts, gatewayDown, gatewayEvidence)

    const wanResults = results.filter((r) => r.scope === 'wan')
    const wanDown = wanResults.length > 0 && wanResults.every((r) => r.down)
    const wanEvidence = wanResults.filter((r) => r.down).map((r) => r.target)
    this.evaluateScope('wan', ts, wanDown, wanEvidence)
  }

  private evaluateScope(scope: Scope, ts: number, down: boolean, evidence: string[]): void {
    const current = this.open.get(scope)

    // A cycle at or before the last one already applied to this open outage
    // can only be a stale replay (a spool resend, a restarted process
    // reprocessing the same batch) — skip it rather than double-count.
    if (current && ts <= current.lastTs) return

    if (down) {
      if (current) {
        const cycles = current.cycles + 1
        this.db.update(outage).set({ cycles, evidence: JSON.stringify(evidence) }).where(eq(outage.id, current.id)).run()
        this.open.set(scope, { ...current, lastTs: ts, cycles })
        return
      }

      const inserted = this.db
        .insert(outage)
        .values({ scope, startedAt: ts, cycles: 1, evidence: JSON.stringify(evidence) })
        .returning({ id: outage.id })
        .get()
      this.open.set(scope, { id: inserted.id, startedAt: ts, lastTs: ts, cycles: 1 })
      return
    }

    if (current) {
      const durationS = Math.round((ts - current.startedAt) / 1000)
      this.db
        .update(outage)
        .set({ endedAt: ts, durationS })
        .where(and(eq(outage.id, current.id), isNull(outage.endedAt)))
        .run()
      this.open.delete(scope)
    }
  }
}

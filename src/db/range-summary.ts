import { sql } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import type * as schema from './schema.js'
import { homeLineVerdict, type HomeLineVerdict } from './bucket-probes.js'

export interface RangeSummaryParams {
  from: number
  to: number
  /** Probe cadence in seconds — the divisor for how many cycles the range *should* hold. */
  probeCycleSeconds: number
  /** Per-cycle loss share (0–100) at or above which a cycle counts as degraded. */
  degradedLossPct: number
  /**
   * Names of the **WAN-scoped** targets (`src/config.ts` `Target.scope === 'wan'`),
   * i.e. the anchors a home-line degradation has to be visible on. Scope, not
   * name: renaming a target must not change what "degraded" means.
   *
   * Optional only so the sole call site can be updated independently. Omitted
   * (or empty), the gateway cannot be told apart from the anchors and the
   * fallback is the strictest rule left — *every* target sampled in the cycle
   * degraded. That can never over-count a home-line problem, but it does
   * under-count one (a WAN degradation with a healthy gateway is missed), so
   * the call site should always pass this.
   */
  wanTargets?: readonly string[]
}

export interface RangeSummary {
  from: number
  to: number
  /** Distinct cycle timestamps actually recorded in the range. */
  recordedCycles: number
  /** How many the probe cadence should have produced across the whole range. */
  expectedCycles: number
  /**
   * recordedCycles / expectedCycles × 100, clamped to 100 — and `null` when
   * `expectedCycles` is 0, i.e. the range is shorter than one probe cycle and
   * coverage is not expressible. Reporting `0` there claimed a fully-measured
   * window was unmeasured, which is the same lie this field exists to prevent,
   * only inverted.
   */
  coveragePct: number | null
  /** First and last cycle in the range — null when nothing was recorded. */
  firstTs: number | null
  lastTs: number | null
  /**
   * Cycles in which **every WAN anchor** lost at least `degradedLossPct` of its
   * packets while no outage row covered them. The outage state machine only
   * fires on `received === 0`, so these are real degradation the outage table
   * cannot show.
   *
   * All WAN anchors, not the worst target: docs/DESIGN.md puts three anchors on
   * three different networks precisely so one provider deprioritising ICMP
   * cannot register as a line problem, and `MAX(loss_pct)` over every target
   * threw that away. The gateway is excluded outright — it is a diagnostic that
   * separates "router down" from "WAN down", so gateway loss is a *local*
   * problem and folding it in would report the LAN as a home-line degradation.
   */
  degradedCycles: number
  degradedLossPct: number
  /** Vantage roll-up over the range — see HomeLineVerdict. */
  onHomeLine: HomeLineVerdict
  homeLineCycles: number
  offHomeLineCycles: number
  unknownHomeLineCycles: number
}

interface CoverageRow {
  recorded_cycles: number
  first_ts: number | null
  last_ts: number | null
}

interface VantageRow {
  home_cycles: number
  off_cycles: number
}

/**
 * The honesty layer for any "downtime over the last N hours" figure. Three
 * separate lies are possible without it and all three have a field here:
 *
 * 1. *Omission* — "24 h: 0 min downtime" over a database holding 96 minutes.
 *    `recordedCycles` vs `expectedCycles` makes the gap visible; a range the
 *    collector was not running through is not a range that was up.
 * 2. *Degradation swallowed* — the outage table only holds cycles where nothing
 *    came back at all, so an 80%-loss cycle reads as perfect uptime.
 *    `degradedCycles` counts what the outage table structurally cannot, using
 *    the same WAN-anchor quorum an outage does (see the field's doc comment):
 *    one anchor losing packets is that anchor's problem, not the line's.
 * 3. *Wrong line* — cycles taken over Wi-Fi or cellular say nothing about the
 *    home line. `onHomeLine`/`unknownHomeLineCycles` refuse to fold those in.
 *
 * All three counts are computed in SQL: the same 4.2M-rows/year constraint that
 * forces `GET /api/probes` to bucket server-side applies here.
 */
export function rangeSummary(db: BunSQLiteDatabase<typeof schema>, params: RangeSummaryParams): RangeSummary {
  const { from, to, probeCycleSeconds, degradedLossPct } = params
  const cycleMs = Math.max(1, Math.round(probeCycleSeconds * 1000))
  const wanTargets = params.wanTargets && params.wanTargets.length > 0 ? params.wanTargets : null

  const [coverage] = db.all<CoverageRow>(sql`
    SELECT
      COUNT(DISTINCT ts) AS recorded_cycles,
      MIN(ts) AS first_ts,
      MAX(ts) AS last_ts
    FROM probe_sample
    WHERE ts >= ${from} AND ts <= ${to}
  `)

  // "Degraded" is per *cycle*, not per row, and it means the same thing an
  // outage means minus the totality: `MIN(loss_pct)` over the cycle's WAN
  // anchors is the *best* anchor it reached, so the threshold only trips when
  // every one of them was hurting. One anchor deprioritising ICMP is not a line
  // problem — that is exactly why three of them sit on three networks. Cycles
  // already inside a materialised outage are excluded so a real outage is not
  // double-counted as degradation.
  const targetFilter = wanTargets ? sql`AND target IN (${sql.join(wanTargets.map((name) => sql`${name}`), sql`, `)})` : sql``
  const [degraded] = db.all<{ degraded_cycles: number }>(sql`
    SELECT COUNT(*) AS degraded_cycles FROM (
      SELECT ts
      FROM probe_sample
      WHERE ts >= ${from} AND ts <= ${to} ${targetFilter}
      GROUP BY ts
      HAVING MIN(loss_pct) >= ${degradedLossPct}
    ) AS d
    WHERE NOT EXISTS (
      SELECT 1 FROM outage AS o
      WHERE o.started_at <= d.ts AND (o.ended_at IS NULL OR o.ended_at >= d.ts)
    )
  `)

  const [vantage] = db.all<VantageRow>(sql`
    SELECT
      SUM(CASE WHEN on_home_line = 1 THEN 1 ELSE 0 END) AS home_cycles,
      SUM(CASE WHEN on_home_line = 0 THEN 1 ELSE 0 END) AS off_cycles
    FROM probe_cycle
    WHERE ts >= ${from} AND ts <= ${to}
  `)

  const recordedCycles = coverage?.recorded_cycles ?? 0
  const expectedCycles = Math.max(0, Math.round((to - from) / cycleMs))
  const homeLineCycles = vantage?.home_cycles ?? 0
  const offHomeLineCycles = vantage?.off_cycles ?? 0

  return {
    from,
    to,
    recordedCycles,
    expectedCycles,
    // Unknown, not 0. A range shorter than one probe cycle expects less than a
    // whole cycle, and there is no share of it that "recorded 1 of 0" describes.
    // The clamp is for the opposite case — cycles arriving faster than cadence.
    coveragePct: expectedCycles === 0 ? null : Math.min(100, (100 * recordedCycles) / expectedCycles),
    firstTs: coverage?.first_ts ?? null,
    lastTs: coverage?.last_ts ?? null,
    degradedCycles: degraded?.degraded_cycles ?? 0,
    degradedLossPct,
    onHomeLine: homeLineVerdict(recordedCycles, homeLineCycles, offHomeLineCycles),
    homeLineCycles,
    offHomeLineCycles,
    unknownHomeLineCycles: recordedCycles - homeLineCycles - offHomeLineCycles,
  }
}

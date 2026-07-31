import { sql, type SQL } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import type * as schema from '../db/schema.js'
import { rangeSummary } from '../db/range-summary.js'
import {
  VERDICT_THRESHOLDS,
  type AnchorReply,
  type GatewayOutageContradiction,
  type LinkState,
  type LinkVsSync,
  type PathStall,
  type ResyncCluster,
  type ResyncOutage,
  type SymmetricLoss,
  type SymmetricLossExampleTarget,
  type ThroughputCandidate,
  type VerdictInput,
} from './verdict.js'

/**
 * The only place the verdict layer touches SQL. `verdict.ts` sees plain data, so
 * every rule is testable from a fixture and nothing in it can accidentally
 * depend on a database being present.
 *
 * Every query is range-bounded and index-backed (`probe_ts`, `probe_cycle_ts`,
 * `speed_ts`, `router_line_ts`, `outage_started`, `event_ts`). The two that are
 * not bounded below — collector liveness and the "newest reading at or before
 * `to`" lookups — are descending index scans with `LIMIT 1`.
 *
 * Config arrives as parameters rather than through an import of `src/config.ts`,
 * the same shape `rangeSummary` uses: which targets are WAN anchors is
 * configuration, and a module that reads the process environment cannot be
 * exercised from a plain fixture.
 */
export interface CollectVerdictInputParams {
  from: number
  to: number
  /** Injected rather than read from the clock, so the whole layer stays deterministic. */
  now: number
  probeCycleSeconds: number
  degradedLossPct: number
  /** Names of the WAN-scoped targets — scope, not name, decides what an anchor is. */
  wanTargets: readonly string[]
  /** Name of the gateway-scoped target. Null when the target list has none configured. */
  gatewayTarget: string | null
  /** How many targets a complete cycle holds; a cycle with fewer is excluded, not patched. */
  expectedTargetCount: number
  router: {
    enabled: boolean
    disabledReason: string | null
    pollIntervalMs: number
  }
}

interface CountRow {
  n: number | null
}

function one<T>(rows: T[]): T | null {
  return rows[0] ?? null
}

/** `target IN (…)` for a non-empty name list. */
function inTargets(names: readonly string[]): SQL {
  return sql.join(
    names.map((name) => sql`${name}`),
    sql`, `,
  )
}

/**
 * Link sampler coverage over an arbitrary interval.
 *
 * `SUM(link_watch_s)` is null when no cycle in the interval reported the column
 * at all, and that null is carried through rather than folded to 0: "no sampler
 * ran" and "the sampler watched nothing" are the same number but not the same
 * claim, and only the null keeps the distinction available upstream.
 *
 * Transitions count only sampler-written `link_change` events. The router
 * poller writes its own from the carrier side; those describe the line, not the
 * host link this gate is about.
 */
function linkStateOver(db: BunSQLiteDatabase<typeof schema>, from: number, to: number): LinkState {
  const watched = one(
    db.all<{ watched_s: number | null }>(sql`
      SELECT SUM(link_watch_s) AS watched_s FROM probe_cycle WHERE ts >= ${from} AND ts <= ${to}
    `),
  )
  const transitions = one(
    db.all<CountRow>(sql`
      SELECT COUNT(*) AS n FROM event
      WHERE kind = 'link_change' AND ts >= ${from} AND ts <= ${to}
        AND json_extract(detail, '$.source') = 'link-sampler'
    `),
  )
  return {
    watchedS: watched?.watched_s ?? null,
    windowS: (to - from) / 1000,
    transitions: transitions?.n ?? 0,
  }
}

/**
 * Speed tests in the range, each carried next to the fastest link speed recorded
 * anywhere in it. The threshold itself is applied in `verdict.ts` so it has one
 * home; the row count here is bounded by the hourly speed-test cadence.
 *
 * `bytes_down`/`duration_s` null, or a non-positive duration, drops the row in
 * SQL — a rate needs both terms and neither may be substituted.
 */
function throughputCandidates(db: BunSQLiteDatabase<typeof schema>, from: number, to: number): ThroughputCandidate[] {
  const rows = db.all<{
    id: number
    ts: number
    bytes_down: number
    duration_s: number
    wire_mbps: number
    max_link: number | null
    n: number
  }>(sql`
    WITH t AS (
      SELECT id, ts, bytes_down, duration_s, bytes_down * 8.0 / 1e6 / duration_s AS wire_mbps
      FROM speed_test
      WHERE ok = 1 AND bytes_down IS NOT NULL AND duration_s IS NOT NULL AND duration_s > 0
        AND ts >= ${from} AND ts <= ${to}
    ),
    v AS (
      SELECT MAX(link_mbit) AS max_link, COUNT(*) AS n
      FROM probe_cycle WHERE link_mbit IS NOT NULL AND ts >= ${from} AND ts <= ${to}
    )
    SELECT t.id, t.ts, t.bytes_down, t.duration_s, t.wire_mbps, v.max_link, v.n
    FROM t, v
    ORDER BY t.ts
  `)

  // A range with no link speed on record has nothing to contradict, so there is
  // no verdict — not a comparison against an assumed rate.
  return rows
    .filter((row): row is typeof row & { max_link: number } => row.max_link !== null && row.n > 0)
    .map((row) => ({
      speedTestId: row.id,
      ts: row.ts,
      bytesDown: row.bytes_down,
      durationS: row.duration_s,
      wireMbps: row.wire_mbps,
      maxLinkMbit: row.max_link,
      vantageCycles: row.n,
    }))
}

/**
 * The newest link, sync and download readings at or before `to`, plus what the
 * range says about the vantage. Four separate queries rather than the cross
 * join they read as: a cross join with one empty side returns no row at all,
 * which collapses four distinguishable "this term is missing" cases into one.
 */
function linkVsSync(db: BunSQLiteDatabase<typeof schema>, from: number, to: number): LinkVsSync {
  const vantage = one(
    db.all<{
      link_mbit: number
      link_max_mbit: number | null
      link_media: string | null
      link_duplex: 'full' | 'half' | null
      path_if: string | null
    }>(sql`
      SELECT link_mbit, link_max_mbit, link_media, link_duplex, path_if
      FROM probe_cycle WHERE ts <= ${to} AND link_mbit IS NOT NULL ORDER BY ts DESC LIMIT 1
    `),
  )
  const line = one(
    db.all<{ down_sync_kbps: number; ts: number }>(sql`
      SELECT down_sync_kbps, ts FROM router_line_sample
      WHERE down_sync_kbps IS NOT NULL AND ts <= ${to} ORDER BY ts DESC LIMIT 1
    `),
  )
  const speed = one(
    db.all<{ download_mbps: number }>(sql`
      SELECT download_mbps FROM speed_test
      WHERE ok = 1 AND download_mbps IS NOT NULL AND ts <= ${to} ORDER BY ts DESC LIMIT 1
    `),
  )
  // `SUM(CASE WHEN on_home_line = 1 …)` fails closed on both 0 and NULL, so a
  // cycle that never reported a vantage can never be counted as the home line.
  const spread = one(
    db.all<{ n_link: number; home: number | null; n: number }>(sql`
      SELECT COUNT(DISTINCT link_mbit) AS n_link,
             SUM(CASE WHEN on_home_line = 1 THEN 1 ELSE 0 END) AS home,
             COUNT(*) AS n
      FROM probe_cycle WHERE ts >= ${from} AND ts <= ${to} AND link_mbit IS NOT NULL
    `),
  )

  return {
    linkMbit: vantage?.link_mbit ?? null,
    linkMaxMbit: vantage?.link_max_mbit ?? null,
    linkMedia: vantage?.link_media ?? null,
    linkDuplex: vantage?.link_duplex ?? null,
    pathIf: vantage?.path_if ?? null,
    downSyncKbps: line?.down_sync_kbps ?? null,
    syncObservedAt: line?.ts ?? null,
    downloadMbps: speed?.download_mbps ?? null,
    distinctLinkMbits: spread?.n_link ?? 0,
    vantageCycles: spread?.n ?? 0,
    homeLineCycles: spread?.home ?? 0,
  }
}

/**
 * `ts − showtime_start_s × 1000` for every poll that reported showtime,
 * clustered into the events they describe.
 *
 * Clustering happens here rather than in SQL because the tolerance chains: two
 * instants belong together when they are within 60 s of each other, not of the
 * first one. `showtime_start_s IS NOT NULL` is enforced in SQL — a coalesce to 0
 * would date every resync to the poll instant itself.
 */
function resyncClusters(db: BunSQLiteDatabase<typeof schema>, from: number, to: number): ResyncCluster[] {
  const rows = db.all<{ up_at: number }>(sql`
    SELECT (ts - showtime_start_s * 1000) AS up_at
    FROM router_line_sample
    WHERE showtime_start_s IS NOT NULL AND ts >= ${from} AND ts <= ${to}
    ORDER BY up_at
  `)

  const groups: number[][] = []
  for (const row of rows) {
    const current = groups[groups.length - 1]
    const previous = current?.[current.length - 1]
    if (current === undefined || previous === undefined || row.up_at - previous > VERDICT_THRESHOLDS.resyncClusterToleranceMs) {
      groups.push([row.up_at])
      continue
    }
    current.push(row.up_at)
  }

  return groups.map((instants) => {
    const first = instants[0] ?? 0
    const last = instants[instants.length - 1] ?? first
    // The cluster's own midpoint would smooth the disagreement away; the
    // earliest instant is the one a counter carried forward unchanged.
    const upAt = first
    const window = VERDICT_THRESHOLDS.resyncOutageWindowMs
    const outage = one(
      db.all<{ id: number; ended_at: number | null; duration_s: number | null }>(sql`
        SELECT id, ended_at, duration_s FROM outage
        WHERE scope = 'wan' AND started_at <= ${upAt + window}
          AND (ended_at IS NULL OR ended_at >= ${upAt - window})
        ORDER BY started_at DESC LIMIT 1
      `),
    )
    const matched: ResyncOutage | null = outage === null ? null : { id: outage.id, endedAt: outage.ended_at, durationS: outage.duration_s }
    return {
      upAt,
      samples: instants.length,
      spreadMs: last - first,
      outage: matched,
      // The gate for this rule is the interval the attribution rests on, not the
      // request window: an outage two minutes from `upAt` is explained or not
      // explained by what the link did around `upAt`.
      linkState: linkStateOver(db, upAt - window, upAt + window),
    }
  })
}

/**
 * Cycles where every target's worst round trip blew out together at zero loss.
 *
 * `n = expectedTargetCount` excludes a cycle that was missing a target outright,
 * rather than letting SQL's NULL comparison drop it silently. `med_ms > 0` in
 * the ratio avoids a divide by zero instead of defaulting it.
 */
function pathStalls(db: BunSQLiteDatabase<typeof schema>, from: number, to: number, expectedTargetCount: number): PathStall[] {
  const rows = db.all<{ ts: number; min_ratio: number; max_loss: number }>(sql`
    WITH c AS (
      SELECT ts,
        COUNT(*) AS n,
        MIN(CASE WHEN med_ms > 0 THEN max_ms / med_ms END) AS min_ratio,
        MAX(loss_pct) AS max_loss
      FROM probe_sample
      WHERE ts >= ${from} AND ts <= ${to} AND med_ms IS NOT NULL AND max_ms IS NOT NULL
      GROUP BY ts
    )
    SELECT ts, min_ratio, max_loss
    FROM c
    WHERE n = ${expectedTargetCount} AND min_ratio >= ${VERDICT_THRESHOLDS.pathStallMinRatio} AND max_loss = 0
    ORDER BY ts
  `)
  if (rows.length === 0) return []

  const stallTs = rows.map((row) => row.ts)
  const detail = db.all<{ ts: number; target: string; med_ms: number; max_ms: number }>(sql`
    SELECT ts, target, med_ms, max_ms FROM probe_sample
    WHERE ts IN (${sql.join(
      stallTs.map((ts) => sql`${ts}`),
      sql`, `,
    )}) AND med_ms IS NOT NULL AND max_ms IS NOT NULL
    ORDER BY ts, target
  `)
  const watch = db.all<{ ts: number; link_watch_s: number | null }>(sql`
    SELECT ts, link_watch_s FROM probe_cycle
    WHERE ts IN (${sql.join(
      stallTs.map((ts) => sql`${ts}`),
      sql`, `,
    )})
  `)
  const watchByTs = new Map(watch.map((row) => [row.ts, row.link_watch_s]))

  return rows.map((row) => {
    const perTarget = detail.filter((d) => d.ts === row.ts).map((d) => ({ target: d.target, medMs: d.med_ms, maxMs: d.max_ms }))
    return {
      ts: row.ts,
      targetCount: perTarget.length,
      minRatio: row.min_ratio,
      maxLossPct: row.max_loss,
      // Absent row and null column both mean the sampler did not back this
      // cycle. Neither becomes 0 — 0 would read as "sampled, saw nothing".
      linkWatchS: watchByTs.get(row.ts) ?? null,
      perTarget,
    }
  })
}

/**
 * Gateway outages whose own cycle contradicts them, with the vantage needed to
 * decide whether the contradiction is real. The two suppressing facts
 * (`on_home_line`, `gateway_addr` against the previous cycle) are fetched, not
 * assumed, and the rule refuses on either being null.
 */
function gatewayOutages(
  db: BunSQLiteDatabase<typeof schema>,
  from: number,
  to: number,
  gatewayTarget: string,
  wanTargets: readonly string[],
): GatewayOutageContradiction[] {
  if (wanTargets.length === 0) return []

  const rows = db.all<{
    id: number
    started_at: number
    gw_sent: number | null
    gw_received: number | null
    gw_loss: number | null
    wan_alive: number
    wan_med: number | null
  }>(sql`
    SELECT o.id, o.started_at,
      MAX(CASE WHEN p.target = ${gatewayTarget} THEN p.sent END) AS gw_sent,
      MAX(CASE WHEN p.target = ${gatewayTarget} THEN p.received END) AS gw_received,
      MAX(CASE WHEN p.target = ${gatewayTarget} THEN p.loss_pct END) AS gw_loss,
      COUNT(CASE WHEN p.target IN (${inTargets(wanTargets)}) AND p.received > 0 THEN 1 END) AS wan_alive,
      AVG(CASE WHEN p.target IN (${inTargets(wanTargets)}) THEN p.med_ms END) AS wan_med
    FROM outage o
    JOIN probe_sample p ON p.ts = o.started_at
    WHERE o.scope = 'gateway' AND o.started_at >= ${from} AND o.started_at <= ${to}
    GROUP BY o.id
    HAVING gw_loss = 100 AND wan_alive >= ${VERDICT_THRESHOLDS.gatewayOutageMinWanAlive}
    ORDER BY o.started_at
  `)

  return rows.map((row) => {
    const anchors = db
      .all<{ target: string; received: number; sent: number; med_ms: number | null }>(sql`
        SELECT target, received, sent, med_ms FROM probe_sample
        WHERE ts = ${row.started_at} AND target IN (${inTargets(wanTargets)})
        ORDER BY target
      `)
      .map((a): AnchorReply => ({ target: a.target, received: a.received, sent: a.sent, medMs: a.med_ms }))

    const cycle = one(
      db.all<{ on_home_line: number | null; gateway_addr: string | null }>(sql`
        SELECT on_home_line, gateway_addr FROM probe_cycle WHERE ts = ${row.started_at}
      `),
    )
    const previous = one(
      db.all<{ gateway_addr: string | null }>(sql`
        SELECT gateway_addr FROM probe_cycle WHERE ts < ${row.started_at} ORDER BY ts DESC LIMIT 1
      `),
    )

    return {
      outageId: row.id,
      ts: row.started_at,
      // Carried through nullable rather than `?? 0`. The SQL's `HAVING gw_loss = 100` happens to
      // guarantee a gateway probe row exists, so a coalesce is safe *today* — but nothing in the
      // type says so, and relaxing that HAVING (to catch partial gateway loss, say) would turn a
      // cycle that never probed the gateway into the sentence "the gateway returned 0 of 0
      // replies", asserted as a measured contradiction. The rest of this module refuses rather
      // than coalescing; this is the one place that did not.
      gatewaySent: row.gw_sent,
      gatewayReceived: row.gw_received,
      wanAliveCount: row.wan_alive,
      wanMedMs: row.wan_med,
      anchors,
      onHomeLine: cycle?.on_home_line ?? null,
      gatewayAddr: cycle?.gateway_addr ?? null,
      previousGatewayAddr: previous?.gateway_addr ?? null,
    }
  })
}

/**
 * Cycles that lost packets on the gateway and on every WAN anchor at once,
 * within a narrow spread and short of a total loss.
 *
 * `n = expectedTargetCount` again excludes an incomplete cycle: without it `gw`
 * is NULL, `ABS(gw − wan_max)` is NULL, and SQL drops the row without saying so.
 * `gw < 100` hands the total-loss case to `gateway_outage_uncorroborated`.
 */
function symmetricLoss(
  db: BunSQLiteDatabase<typeof schema>,
  from: number,
  to: number,
  gatewayTarget: string,
  wanTargets: readonly string[],
  expectedTargetCount: number,
): SymmetricLoss | null {
  if (wanTargets.length === 0) return null

  const qualifying = sql`
    WITH c AS (
      SELECT ts,
        MAX(CASE WHEN target = ${gatewayTarget} THEN loss_pct END) AS gw,
        MIN(CASE WHEN target IN (${inTargets(wanTargets)}) THEN loss_pct END) AS wan_min,
        MAX(CASE WHEN target IN (${inTargets(wanTargets)}) THEN loss_pct END) AS wan_max,
        MAX(med_ms) AS worst_med,
        COUNT(*) AS n
      FROM probe_sample WHERE ts >= ${from} AND ts <= ${to} GROUP BY ts
    )
    SELECT ts, worst_med FROM c
    WHERE n = ${expectedTargetCount}
      AND gw >= ${VERDICT_THRESHOLDS.symmetricLossMinPct}
      AND wan_min >= ${VERDICT_THRESHOLDS.symmetricLossMinPct}
      AND ABS(gw - wan_max) <= ${VERDICT_THRESHOLDS.symmetricLossMaxSpreadPct}
      AND gw < 100
  `
  const summary = one(
    db.all<{ cycles: number; first_ts: number | null; last_ts: number | null; worst_med_ms: number | null }>(sql`
      SELECT COUNT(*) AS cycles, MIN(ts) AS first_ts, MAX(ts) AS last_ts, MAX(worst_med) AS worst_med_ms
      FROM (${qualifying})
    `),
  )
  if (summary === null || summary.cycles === 0 || summary.first_ts === null || summary.last_ts === null) return null

  const exampleTargets = db
    .all<{ target: string; loss_pct: number; med_ms: number | null }>(sql`
      SELECT target, loss_pct, med_ms FROM probe_sample WHERE ts = ${summary.first_ts} ORDER BY target
    `)
    .map((row): SymmetricLossExampleTarget => ({ target: row.target, lossPct: row.loss_pct, medMs: row.med_ms }))

  // Cumulative counters, so the movement across the window is last − first. Both
  // ends come from a row that reported them; `if_ierrs` gates the selection
  // because the three arrive from one netstat read.
  const firstCounters = one(
    db.all<{ if_ierrs: number; if_oerrs: number | null; if_coll: number | null }>(sql`
      SELECT if_ierrs, if_oerrs, if_coll FROM probe_cycle
      WHERE ts >= ${summary.first_ts} AND ts <= ${summary.last_ts} AND if_ierrs IS NOT NULL ORDER BY ts ASC LIMIT 1
    `),
  )
  const lastCounters = one(
    db.all<{ if_ierrs: number; if_oerrs: number | null; if_coll: number | null }>(sql`
      SELECT if_ierrs, if_oerrs, if_coll FROM probe_cycle
      WHERE ts >= ${summary.first_ts} AND ts <= ${summary.last_ts} AND if_ierrs IS NOT NULL ORDER BY ts DESC LIMIT 1
    `),
  )

  return {
    cycles: summary.cycles,
    firstTs: summary.first_ts,
    lastTs: summary.last_ts,
    wanTargetCount: wanTargets.length,
    worstMedMs: summary.worst_med_ms,
    exampleTs: summary.first_ts,
    exampleTargets,
    ifIerrsDelta: counterDelta(firstCounters?.if_ierrs ?? null, lastCounters?.if_ierrs ?? null),
    ifOerrsDelta: counterDelta(firstCounters?.if_oerrs ?? null, lastCounters?.if_oerrs ?? null),
    ifCollDelta: counterDelta(firstCounters?.if_coll ?? null, lastCounters?.if_coll ?? null),
  }
}

/**
 * Movement of a cumulative counter, or null when it cannot be stated. A counter
 * that went backwards was reset (an interface reset, a reboot), and the traffic
 * before the reset is unknown — a clamp to 0 there would report "no errors" for
 * a window whose errors were thrown away.
 */
function counterDelta(first: number | null, last: number | null): number | null {
  if (first === null || last === null || last < first) return null
  return last - first
}

/** Carrier-side poll coverage of the window, including the worst gap between polls. */
function routerCoverage(db: BunSQLiteDatabase<typeof schema>, from: number, to: number, pollIntervalMs: number) {
  const row = one(
    db.all<{ polls: number; last_ts: number | null; worst_gap_ms: number | null }>(sql`
      SELECT COUNT(*) AS polls, MAX(ts) AS last_ts,
        (SELECT MAX(gap) FROM (
           SELECT ts - LAG(ts) OVER (ORDER BY ts) AS gap
           FROM router_line_sample WHERE ts >= ${from} AND ts <= ${to})) AS worst_gap_ms
      FROM router_line_sample WHERE ts >= ${from} AND ts <= ${to}
    `),
  )
  const interval = Math.max(1, pollIntervalMs)
  return {
    polls: row?.polls ?? 0,
    // A window shorter than one interval is still due its endpoints' poll.
    expectedPolls: Math.max(0, Math.floor((to - from) / interval) + 1),
    worstGapMs: row?.worst_gap_ms ?? null,
    lastPollTs: row?.last_ts ?? null,
  }
}

/** Everything the nine rules read, over one window. */
export function collectVerdictInput(db: BunSQLiteDatabase<typeof schema>, params: CollectVerdictInputParams): VerdictInput {
  const { from, to, now, probeCycleSeconds, degradedLossPct, wanTargets, gatewayTarget, expectedTargetCount } = params

  const lastProbe = one(db.all<{ last_ts: number | null }>(sql`SELECT MAX(ts) AS last_ts FROM probe_sample`))
  const linkChanges = one(
    db.all<CountRow>(sql`SELECT COUNT(*) AS n FROM event WHERE kind = 'link_change' AND ts >= ${from} AND ts <= ${to}`),
  )
  const coverage = rangeSummary(db, { from, to, probeCycleSeconds, degradedLossPct, wanTargets })
  const router = routerCoverage(db, from, to, params.router.pollIntervalMs)

  return {
    now,
    from,
    to,
    probeCycleSeconds,
    linkState: linkStateOver(db, from, to),
    lastProbeTs: lastProbe?.last_ts ?? null,
    coverage,
    router: {
      enabled: params.router.enabled,
      disabledReason: params.router.disabledReason,
      polls: router.polls,
      expectedPolls: router.expectedPolls,
      worstGapMs: router.worstGapMs,
      lastPollTs: router.lastPollTs,
      pollIntervalS: Math.round(params.router.pollIntervalMs / 1000),
    },
    throughput: throughputCandidates(db, from, to),
    linkVsSync: linkVsSync(db, from, to),
    resyncClusters: resyncClusters(db, from, to),
    pathStalls: pathStalls(db, from, to, expectedTargetCount),
    // Both of these separate the gateway from the anchors, so neither is
    // computable without a configured gateway-scoped target.
    gatewayOutages: gatewayTarget === null ? [] : gatewayOutages(db, from, to, gatewayTarget, wanTargets),
    symmetricLoss: gatewayTarget === null ? null : symmetricLoss(db, from, to, gatewayTarget, wanTargets, expectedTargetCount),
    linkChangeEvents: linkChanges?.n ?? 0,
  }
}

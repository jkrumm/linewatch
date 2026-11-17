import { and, asc, gt, inArray, isNotNull, lte, max, eq } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import {
  event,
  outage,
  probeCycle,
  probeSample,
  routerIntfSample,
  routerLineSample,
  routerWanSample,
  speedTest,
  wifiSample,
} from '../db/schema.js'
import type * as schema from '../db/schema.js'
import type { Attrs, Batch } from './otlp.js'

export type Db = BunSQLiteDatabase<typeof schema>

/** What the mapping needs from the app's configuration, injected so tests need none. */
export interface MapContext {
  /** The scope of a probe target, or null for one this install does not know. */
  scopeOf(target: string, addr: string): 'gateway' | 'wan' | null
}

export type StreamName =
  | 'probe'
  | 'wifi'
  | 'router_line'
  | 'router_wan'
  | 'router_intf'
  | 'speed_test'
  | 'outage_open'
  | 'outage_close'
  | 'intervention'

export interface StepResult {
  rows: number
  /** The key of the last row read: the cursor value once the batch is accepted. */
  lastKey: number
  batch: Batch
}

export interface StepArgs {
  /** Exclusive lower bound on the stream's key. */
  after: number
  /** Inclusive upper bound, or null for the live tail. */
  upTo: number | null
  limit: number
  ctx: MapContext
}

/**
 * One exported table (or one slice of it). `step` reads the next rows in key
 * order and maps them to OTLP points and log records; it never writes. The same
 * step serves the live tail and the backfill, so the two cannot disagree about
 * what a row means.
 */
export interface Stream {
  name: StreamName
  /** The highest key present now: where a first run starts its live tail. */
  head(db: Db): number
  step(db: Db, args: StepArgs): StepResult | null
}

function makeStream<R>(spec: {
  name: StreamName
  read(db: Db, args: StepArgs): R[]
  key(row: R): number
  head(db: Db): number
  map(rows: R[], db: Db, ctx: MapContext, batch: Batch): void
}): Stream {
  return {
    name: spec.name,
    head: (db) => spec.head(db),
    step(db, args) {
      const rows = spec.read(db, args)
      const last = rows.at(-1)
      if (last === undefined) return null
      const batch: Batch = { points: [], logs: [] }
      spec.map(rows, db, args.ctx, batch)
      return { rows: rows.length, lastKey: spec.key(last), batch }
    },
  }
}

function inRange(column: SQLiteColumn, { after, upTo }: StepArgs): SQL | undefined {
  return and(gt(column, after), upTo === null ? undefined : lte(column, upTo))
}

function maxOf(db: Db, table: SQLiteTable, column: SQLiteColumn, where?: SQL): number {
  const row = db
    .select({ value: max(column) })
    .from(table)
    .where(where)
    .get()
  return Number(row?.value ?? 0)
}

/** A reading that is null (never measured) emits no point: absent is not zero. */
function gauge(
  batch: Batch,
  name: string,
  unit: string,
  tsMs: number,
  value: number | null | undefined,
  attrs: Attrs,
): void {
  if (value === null || value === undefined || !Number.isFinite(value)) return
  batch.points.push({ name, unit, tsMs, value, attrs })
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

// --- probe_sample (+ the cycle's path attributes) -------------------------------

const probe = makeStream({
  name: 'probe',
  read: (db, args) =>
    db
      .select()
      .from(probeSample)
      .where(inRange(probeSample.id, args))
      .orderBy(asc(probeSample.id))
      .limit(args.limit)
      .all(),
  key: (row) => row.id,
  head: (db) => maxOf(db, probeSample, probeSample.id),
  map(rows, db, ctx, batch) {
    const stamps = [...new Set(rows.map((row) => row.ts))]
    const cycles = new Map(
      db
        .select()
        .from(probeCycle)
        .where(inArray(probeCycle.ts, stamps))
        .all()
        .map((c) => [c.ts, c]),
    )
    for (const row of rows) {
      const cycle = cycles.get(row.ts)
      const attrs: Attrs = {
        target: row.target,
        scope: ctx.scopeOf(row.target, row.addr),
        // Absent when the cycle recorded no vantage. on_home_line is three-state in
        // the schema (1 / 0 / null = unknown) and null must never become a value.
        path_class: cycle?.pathClass ?? null,
        on_home_line: cycle?.onHomeLine == null ? null : cycle.onHomeLine === 1,
        link_mbit: cycle?.linkMbit ?? null,
      }
      gauge(batch, 'line.probe.sent', '{packet}', row.ts, row.sent, attrs)
      gauge(batch, 'line.probe.received', '{packet}', row.ts, row.received, attrs)
      gauge(batch, 'line.probe.loss', '%', row.ts, row.lossPct, attrs)
      gauge(batch, 'line.probe.rtt.min', 'ms', row.ts, row.minMs, attrs)
      gauge(batch, 'line.probe.rtt.median', 'ms', row.ts, row.medMs, attrs)
      gauge(batch, 'line.probe.rtt.max', 'ms', row.ts, row.maxMs, attrs)
      gauge(batch, 'line.probe.rtt.avg', 'ms', row.ts, row.avgMs, attrs)
      gauge(batch, 'line.probe.jitter', 'ms', row.ts, row.jitterMs, attrs)
    }
  },
})

// --- wifi_sample ----------------------------------------------------------------

const wifi = makeStream({
  name: 'wifi',
  read: (db, args) =>
    db
      .select()
      .from(wifiSample)
      .where(inRange(wifiSample.id, args))
      .orderBy(asc(wifiSample.id))
      .limit(args.limit)
      .all(),
  key: (row) => row.id,
  head: (db) => maxOf(db, wifiSample, wifiSample.id),
  map(rows, _db, _ctx, batch) {
    for (const row of rows) {
      const attrs: Attrs = { iface: row.iface, band: row.band, status: row.status }
      gauge(batch, 'line.wifi.rssi', 'dBm', row.ts, row.rssiDbm, attrs)
      gauge(batch, 'line.wifi.noise', 'dBm', row.ts, row.noiseDbm, attrs)
      gauge(batch, 'line.wifi.tx_rate', 'Mbit/s', row.ts, row.txRateMbps, attrs)
      gauge(batch, 'line.wifi.rtt.median', 'ms', row.ts, row.rttMedMs, attrs)
      gauge(batch, 'line.wifi.loss', '%', row.ts, row.lossPct, attrs)
    }
  },
})

// --- router_line_sample ---------------------------------------------------------

const routerLine = makeStream({
  name: 'router_line',
  read: (db, args) =>
    db
      .select()
      .from(routerLineSample)
      .where(inRange(routerLineSample.id, args))
      .orderBy(asc(routerLineSample.id))
      .limit(args.limit)
      .all(),
  key: (row) => row.id,
  head: (db) => maxOf(db, routerLineSample, routerLineSample.id),
  map(rows, _db, _ctx, batch) {
    for (const row of rows) {
      const base: Attrs = { carrier: row.carrier, status: row.status, profile: row.profile }
      const down: Attrs = { ...base, direction: 'down' }
      const up: Attrs = { ...base, direction: 'up' }
      gauge(batch, 'line.router.sync_rate', 'kbit/s', row.ts, row.downSyncKbps, down)
      gauge(batch, 'line.router.sync_rate', 'kbit/s', row.ts, row.upSyncKbps, up)
      gauge(batch, 'line.router.current_rate', 'kbit/s', row.ts, row.downCurrKbps, down)
      gauge(batch, 'line.router.current_rate', 'kbit/s', row.ts, row.upCurrKbps, up)
      gauge(batch, 'line.router.noise_margin', 'dB', row.ts, row.downNoiseMarginDb, down)
      gauge(batch, 'line.router.noise_margin', 'dB', row.ts, row.upNoiseMarginDb, up)
      gauge(batch, 'line.router.attenuation', 'dB', row.ts, row.downAttenuationDb, down)
      gauge(batch, 'line.router.errored_seconds', 's', row.ts, row.erroredSecs, base)
      gauge(
        batch,
        'line.router.severely_errored_seconds',
        's',
        row.ts,
        row.severelyErroredSecs,
        base,
      )
      gauge(batch, 'line.router.showtime', 's', row.ts, row.showtimeStartS, base)
    }
  },
})

// --- router_wan_sample ----------------------------------------------------------

const routerWan = makeStream({
  name: 'router_wan',
  read: (db, args) =>
    db
      .select()
      .from(routerWanSample)
      .where(inRange(routerWanSample.id, args))
      .orderBy(asc(routerWanSample.id))
      .limit(args.limit)
      .all(),
  key: (row) => row.id,
  head: (db) => maxOf(db, routerWanSample, routerWanSample.id),
  map(rows, _db, _ctx, batch) {
    for (const row of rows) {
      const base: Attrs = {
        conn_type: row.connType,
        last_conn_error: row.lastConnError,
        selected_by: row.selectedBy,
      }
      // v4 reads `Connecting` and uptime 0 forever on a DS-Lite line (schema.ts):
      // exported as recorded, so the consumer decides which stack is the live one.
      for (const [version, status, uptime] of [
        ['v4', row.connStatusV4, row.uptimeV4S],
        ['v6', row.connStatusV6, row.uptimeV6S],
      ] as const) {
        const attrs: Attrs = { ...base, ip_version: version, status }
        gauge(batch, 'line.wan.session_uptime', 's', row.ts, uptime, attrs)
        gauge(
          batch,
          'line.wan.connected',
          '1',
          row.ts,
          status === null ? null : Number(status === 'Connected'),
          attrs,
        )
      }
    }
  },
})

// --- router_intf_sample ---------------------------------------------------------

const routerIntf = makeStream({
  name: 'router_intf',
  read: (db, args) =>
    db
      .select()
      .from(routerIntfSample)
      .where(inRange(routerIntfSample.id, args))
      .orderBy(asc(routerIntfSample.id))
      .limit(args.limit)
      .all(),
  key: (row) => row.id,
  head: (db) => maxOf(db, routerIntfSample, routerIntfSample.id),
  map(rows, _db, _ctx, batch) {
    for (const row of rows) {
      const attrs: Attrs = { interface: row.name, role: row.role }
      gauge(batch, 'line.router.interface.rx_rate', 'kbit/s', row.ts, row.rxKbps, attrs)
      gauge(batch, 'line.router.interface.tx_rate', 'kbit/s', row.ts, row.txKbps, attrs)
    }
  },
})

// --- speed_test -----------------------------------------------------------------

const speedtests = makeStream({
  name: 'speed_test',
  read: (db, args) =>
    db
      .select()
      .from(speedTest)
      .where(inRange(speedTest.id, args))
      .orderBy(asc(speedTest.id))
      .limit(args.limit)
      .all(),
  key: (row) => row.id,
  head: (db) => maxOf(db, speedTest, speedTest.id),
  map(rows, _db, _ctx, batch) {
    for (const row of rows) {
      const attrs: Attrs = { backend: row.backend }
      if (!row.ok) {
        batch.logs.push({
          name: 'line.speedtest.failed',
          tsMs: row.ts,
          severity: 'WARN',
          attrs: { ...attrs, error: clip(row.error ?? '', 300), duration_s: row.durationS },
        })
        continue
      }
      gauge(batch, 'line.speedtest.download', 'Mbit/s', row.ts, row.downloadMbps, attrs)
      gauge(batch, 'line.speedtest.upload', 'Mbit/s', row.ts, row.uploadMbps, attrs)
      gauge(batch, 'line.speedtest.ping', 'ms', row.ts, row.pingMs, attrs)
      gauge(batch, 'line.speedtest.jitter', 'ms', row.ts, row.jitterMs, attrs)
      gauge(batch, 'line.speedtest.loaded_latency', 'ms', row.ts, row.latencyDownMs, {
        ...attrs,
        direction: 'down',
      })
      gauge(batch, 'line.speedtest.loaded_latency', 'ms', row.ts, row.latencyUpMs, {
        ...attrs,
        direction: 'up',
      })
      gauge(batch, 'line.speedtest.packet_loss', '%', row.ts, row.packetLoss, attrs)
    }
  },
})

// --- outage ---------------------------------------------------------------------

const outageOpen = makeStream({
  name: 'outage_open',
  read: (db, args) =>
    db
      .select()
      .from(outage)
      .where(inRange(outage.id, args))
      .orderBy(asc(outage.id))
      .limit(args.limit)
      .all(),
  key: (row) => row.id,
  head: (db) => maxOf(db, outage, outage.id),
  map(rows, _db, _ctx, batch) {
    for (const row of rows) {
      batch.logs.push({
        name: 'line.outage.opened',
        tsMs: row.startedAt,
        severity: 'WARN',
        attrs: { scope: row.scope, evidence: clip(row.evidence, 1000) },
      })
    }
  },
})

/**
 * Keyed on `ended_at`, not `id`: two outages of different scopes can overlap and
 * close out of id order. Rows closing in the same instant share a write and arrive
 * together; the outage table holds a few dozen rows, far under the batch limit, so
 * a tie never straddles two reads.
 *
 * The duration also goes out as a gauge: logs are kept 30 days in ClickStack,
 * metrics 400, and an outage must outlive the log.
 */
const outageClose = makeStream({
  name: 'outage_close',
  read: (db, args) =>
    db
      .select()
      .from(outage)
      .where(and(isNotNull(outage.endedAt), inRange(outage.endedAt, args)))
      .orderBy(asc(outage.endedAt))
      .limit(args.limit)
      .all(),
  key: (row) => row.endedAt ?? 0,
  head: (db) => maxOf(db, outage, outage.endedAt),
  map(rows, _db, _ctx, batch) {
    for (const row of rows) {
      if (row.endedAt === null) continue
      const attrs: Attrs = { scope: row.scope }
      batch.logs.push({
        name: 'line.outage.closed',
        tsMs: row.endedAt,
        severity: 'INFO',
        attrs: {
          ...attrs,
          started_at_ms: row.startedAt,
          duration_s: row.durationS,
          cycles: row.cycles,
          evidence: clip(row.evidence, 1000),
        },
      })
      gauge(batch, 'line.outage.duration', 's', row.endedAt, row.durationS, attrs)
    }
  },
})

// --- event (interventions only) -------------------------------------------------

function parseDetail(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const interventions = makeStream({
  name: 'intervention',
  read: (db, args) =>
    db
      .select()
      .from(event)
      .where(and(eq(event.kind, 'intervention'), inRange(event.id, args)))
      .orderBy(asc(event.id))
      .limit(args.limit)
      .all(),
  key: (row) => row.id,
  head: (db) => maxOf(db, event, event.id, eq(event.kind, 'intervention')),
  map(rows, _db, _ctx, batch) {
    for (const row of rows) {
      const detail = parseDetail(row.detail)
      const text = (key: string, limit: number): string | null => {
        const value = detail[key]
        return typeof value === 'string' ? clip(value, limit) : null
      }
      batch.logs.push({
        name: 'line.intervention',
        tsMs: row.ts,
        severity: 'WARN',
        attrs: {
          source: text('source', 100),
          action: text('action', 100),
          outcome: text('outcome', 100),
          note: text('note', 500),
          // Whole detail, bounded: the steps and the pre-action snapshot are the evidence.
          detail: clip(row.detail, 4000),
        },
      })
    }
  },
})

/** Every stream, in the order a tick visits them. */
export const STREAMS: readonly Stream[] = [
  probe,
  wifi,
  routerLine,
  routerWan,
  routerIntf,
  speedtests,
  outageOpen,
  outageClose,
  interventions,
]

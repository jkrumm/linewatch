import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * One row per target per probe cycle. `samples` keeps the raw RTTs so the UI can
 * draw a SmokePing-style spread band rather than a single averaged line.
 */
export const probeSample = sqliteTable(
  'probe_sample',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    target: text('target').notNull(),
    addr: text('addr').notNull(),
    sent: integer('sent').notNull(),
    received: integer('received').notNull(),
    lossPct: real('loss_pct').notNull(),
    minMs: real('min_ms'),
    medMs: real('med_ms'),
    maxMs: real('max_ms'),
    avgMs: real('avg_ms'),
    jitterMs: real('jitter_ms'),
    samples: text('samples'),
  },
  (t) => [index('probe_target_ts').on(t.target, t.ts), index('probe_ts').on(t.ts)],
)

/**
 * Materialised on ingest by the outage state machine. `ended_at` null means
 * ongoing. Single-cycle blips are recorded honestly and filtered on read.
 */
export const outage = sqliteTable(
  'outage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scope: text('scope', { enum: ['wan', 'gateway'] }).notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    durationS: integer('duration_s'),
    cycles: integer('cycles').notNull().default(1),
    evidence: text('evidence').notNull(),
  },
  (t) => [index('outage_started').on(t.startedAt), index('outage_scope_started').on(t.scope, t.startedAt)],
)

export const speedTest = sqliteTable(
  'speed_test',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    backend: text('backend', { enum: ['ookla', 'cloudflare'] }).notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    downloadMbps: real('download_mbps'),
    uploadMbps: real('upload_mbps'),
    pingMs: real('ping_ms'),
    jitterMs: real('jitter_ms'),
    // Latency measured while the link is saturated — the bufferbloat signal.
    latencyDownMs: real('latency_down_ms'),
    latencyUpMs: real('latency_up_ms'),
    packetLoss: real('packet_loss'),
    serverName: text('server_name'),
    serverLocation: text('server_location'),
    serverId: text('server_id'),
    isp: text('isp'),
    externalIp: text('external_ip'),
    bytesDown: integer('bytes_down'),
    bytesUp: integer('bytes_up'),
    resultUrl: text('result_url'),
    durationS: real('duration_s'),
    error: text('error'),
  },
  (t) => [index('speed_ts').on(t.ts)],
)

/**
 * Timeline overlay. Nothing writes `intervention` or `link_change` in v1 — they
 * exist so router control (TP-Link reconnect, LAN/WLAN failover) can correlate an
 * action with the recovery it caused without a migration.
 */
export const event = sqliteTable(
  'event',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    kind: text('kind', {
      enum: ['intervention', 'link_change', 'config_change', 'note'],
    }).notNull(),
    detail: text('detail').notNull(),
  },
  (t) => [index('event_ts').on(t.ts)],
)

import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
    // Both nullable rather than `default 0`: null means "the collector that wrote
    // this row did not report the number", which is what every row predating the
    // clause-by-clause ping parser is. A 0 there would claim it was measured.
    duplicates: integer('duplicates'),
    // > 0 means replies arrived after `-W` and were counted in `received` but
    // never timed, so min/med/max/jitter for that row are a floor computed from
    // the fast replies only — the censored ones are precisely the slow ones.
    outOfWaitTime: integer('out_of_wait_time'),
  },
  (t) => [index('probe_target_ts').on(t.target, t.ts), index('probe_ts').on(t.ts)],
)

/**
 * What the cycle measured *through*. One row per probe cycle, not per target:
 * the vantage point is a property of the cycle, so recording it here instead of
 * on probe_sample keeps it from being duplicated four times across the ~4.2M
 * rows/year that table grows by.
 *
 * Without this table every probe_sample row only *implicitly* means "the home
 * line over Ethernet", which makes five different situations indistinguishable:
 * WAN down, gateway down, en0 renegotiated to 100baseTX (a throughput cap, not
 * an outage), failover to Wi-Fi, and failover to cellular — which is not the
 * home line at all.
 *
 * Everything except id/ts is nullable, deliberately. The collector runs natively
 * under launchd and the API runs in Docker, so they deploy independently: a
 * collector predating any of these fields must still write a valid row, and the
 * 945 rows that predate the table have no vantage to claim.
 */
export const probeCycle = sqliteTable(
  'probe_cycle',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Matches probe_sample.ts for the same cycle. Unique so ingest is
    // idempotent: the collector spools failed batches and replays them, and a
    // replayed cycle must not append a second vantage row for the same instant.
    ts: integer('ts').notNull(),
    // Interface carrying the default route when the cycle ran, e.g. `en0`.
    pathIf: text('path_if'),
    pathClass: text('path_class', { enum: ['ethernet', 'wifi', 'cellular', 'other'] }),
    // Raw media token, e.g. `1000baseT`, kept next to the parsed speed so a
    // token the parser doesn't know yet is still recoverable after the fact.
    linkMedia: text('link_media'),
    linkMbit: integer('link_mbit'),
    linkDuplex: text('link_duplex', { enum: ['full', 'half'] }),
    // Gateway from the default route. Compared against the configured home
    // gateway to decide on_home_line — a different gateway means a different
    // line, however healthy the probes look.
    gatewayAddr: text('gateway_addr'),
    // Cumulative counters straight from netstat, not per-cycle deltas: a
    // counter survives a missed cycle, a delta silently loses those errors.
    ifIerrs: integer('if_ierrs'),
    ifOerrs: integer('if_oerrs'),
    ifColl: integer('if_coll'),
    // The refuse-to-lie column. 1 = Ethernet *and* the configured home gateway;
    // 0 = anything else (Wi-Fi, cellular, an unexpected gateway) i.e. this cycle
    // did not measure the home line; null = not reported, i.e. unknown.
    // Read paths that present data as "the home line" must treat null as
    // unknown and 0 as not-the-home-line. Never coalesce null to 1.
    onHomeLine: integer('on_home_line'),
  },
  (t) => [uniqueIndex('probe_cycle_ts').on(t.ts)],
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

/**
 * Carrier-side line health, one row per poll of the router. Says *why* the line
 * is slow or flapping, which no amount of probing from the host can: sync rate
 * is the ceiling the probes live under, and noise margin is the early warning.
 *
 * `carrier` is data, not a column-name prefix, so moving from G.fast to GPON
 * adds rows rather than a migration. All fields nullable — every one of them is
 * a field the router may stop exposing after a firmware change, and a poll that
 * still got `status` is worth keeping.
 *
 * Units are in the names. The `*_kbps` columns hold the router's own integers
 * verbatim. The router reports margin and attenuation in *tenths* of a dB (61
 * means 6.1); the poller divides by 10 at the write site so the value stored
 * here is real dB and no consumer has to remember the encoding.
 */
export const routerLineSample = sqliteTable(
  'router_line_sample',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    carrier: text('carrier', { enum: ['gfast', 'dsl', 'gpon'] }),
    status: text('status'),
    // Sync = what the line negotiated; curr = what it is carrying now. Both,
    // because a saturated line and a downgraded line look identical otherwise.
    downSyncKbps: integer('down_sync_kbps'),
    upSyncKbps: integer('up_sync_kbps'),
    downCurrKbps: integer('down_curr_kbps'),
    upCurrKbps: integer('up_curr_kbps'),
    downNoiseMarginDb: real('down_noise_margin_db'),
    upNoiseMarginDb: real('up_noise_margin_db'),
    downAttenuationDb: real('down_attenuation_db'),
    profile: text('profile'),
    // Seconds since the line reached showtime. A drop in this value between two
    // polls is a resync — the honest signal for an `event` of kind link_change.
    showtimeStartS: integer('showtime_start_s'),
    erroredSecs: integer('errored_secs'),
    severelyErroredSecs: integer('severely_errored_secs'),
  },
  (t) => [index('router_line_ts').on(t.ts)],
)

/**
 * Per-interface throughput as the router sees it, one row per interface per
 * poll. This is the counterpart to the speed tests: it shows load on the WAN
 * without generating any, so a latency spike can be attributed to the household
 * saturating the uplink rather than to the line degrading.
 */
export const routerIntfSample = sqliteTable(
  'router_intf_sample',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    // e.g. `ppp0`, `br0`. Not null: a rate with no interface attached to it is
    // not a measurement of anything.
    name: text('name').notNull(),
    // Position in the router's own interface stack, kept as reported so an
    // interface can be tied back to its entry there.
    stack: integer('stack'),
    role: text('role', { enum: ['wan', 'lan', 'other'] }),
    rxKbps: integer('rx_kbps'),
    txKbps: integer('tx_kbps'),
    // Cumulative, same reasoning as probe_cycle's error counters: the counter
    // survives a missed poll, a computed delta would swallow the traffic.
    bytesRx: integer('bytes_rx'),
    bytesTx: integer('bytes_tx'),
  },
  (t) => [index('router_intf_ts').on(t.ts), index('router_intf_name_ts').on(t.name, t.ts)],
)

/**
 * The router's view of each LAN port's negotiated link, per poll. Read together
 * with probe_cycle.link_media this settles which end dropped to 100baseTX —
 * host NIC or router port — instead of leaving it a guess.
 *
 * Deliberately no MAC column: this repo is public and the database gets dumped
 * into support contexts, and the port alias already identifies the port. A MAC
 * would buy nothing and leak a stable device identifier.
 */
export const routerEthPort = sqliteTable(
  'router_eth_port',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    name: text('name'),
    alias: text('alias'),
    status: text('status'),
    maxBitRate: integer('max_bit_rate'),
    duplexMode: text('duplex_mode'),
  },
  (t) => [index('router_eth_ts').on(t.ts)],
)

/**
 * Who was connected, per poll. Context for an outage's blast radius and for
 * correlating a throughput dip with a device that appeared.
 *
 * No MAC column here either, for the reason given on router_eth_port — and the
 * hostnames are already personal enough that this table should never be pasted
 * anywhere the rest of the data goes.
 */
export const routerHost = sqliteTable(
  'router_host',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    ip: text('ip'),
    interfaceType: text('interface_type'),
    active: integer('active'),
    clientType: text('client_type'),
    hostName: text('host_name'),
  },
  (t) => [index('router_host_ts').on(t.ts)],
)

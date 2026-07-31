import { desc, eq, gte } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import type * as schema from '../../db/schema.js'
import {
  event,
  probeCycle,
  routerEthPort,
  routerHost,
  routerIntfSample,
  routerLineSample,
} from '../../db/schema.js'
import { RouterReadError, type RouterOperation } from './client.js'
import { compareVantage, detectResync, disagreementSignature, type Disagreement, type HostVantage, type RouterVantage } from './derive.js'
import {
  checkListLength,
  parseEthPorts,
  parseHostCount,
  parseHosts,
  parseIntfSamples,
  parseLineSample,
  parseLiveWan,
  resolveHostPort,
  type EthPort,
} from './parse.js'
import type { RouterRow } from './redact.js'

/**
 * One poll of the router: one login, eight reads over that session, then one
 * atomic write.
 *
 * The reads are individually isolated — a firmware revision that drops one OID
 * costs that OID's columns, not the poll — but a failed login or a lost session
 * aborts the whole poll, because continuing would write a half-empty record that
 * looks like the router reporting zeros. A poll that could not log in stores
 * nothing at all: the gap in `router_line_sample` is the honest record of it.
 */

/** Reads spaced out slightly: this device answers 406 under its own load. */
const READ_SPACING_MS = 250

/**
 * How stale the host's own vantage may be before the corroboration is skipped.
 * Deliberately tied to the collector's cadence, not the poll's: probe cycles
 * land every 30s, so a vantage this old means the collector is not running and a
 * "disagreement" would be an artefact of comparing a live router reading against
 * a dead host reading.
 */
const HOST_VANTAGE_MAX_AGE_MS = 5 * 60 * 1000

interface ReadPlan {
  readonly oid: string
  readonly operation: RouterOperation
}

/**
 * `gl` everywhere except the two genuine singletons. Getting this wrong is not
 * loud: `go` on a list silently returns only the first instance.
 */
const READS = {
  fastLine: { oid: 'DEV2_FAST_LINE', operation: 'gl' },
  lineStats: { oid: 'DEV2_DSL_LINE_STATS', operation: 'gl' },
  adtWan: { oid: 'DEV2_ADT_WAN', operation: 'gl' },
  ipIntf: { oid: 'DEV2_IP_INTF', operation: 'gl' },
  ipIntfStats: { oid: 'DEV2_IP_INTF_STATS', operation: 'gl' },
  ethIntf: { oid: 'DEV2_ETH_INTF', operation: 'gl' },
  hosts: { oid: 'DEV2_HOSTS', operation: 'go' },
  hostEntry: { oid: 'DEV2_HOST_ENTRY', operation: 'gl' },
} as const satisfies Record<string, ReadPlan>

export interface RouterReader {
  /**
   * Establishes the session this poll reads over, discarding any earlier one.
   * Throwing here is a poll that never happened, which is the point: see fact 1
   * in `client.ts`.
   */
  startSession(): Promise<void>
  read(oid: string, operation: RouterOperation): Promise<RouterRow[]>
}

export interface RouterPollerDeps {
  db: BunSQLiteDatabase<typeof schema>
  client: RouterReader
  /** LAN address of the host running the native collector — the vantage to corroborate. */
  collectorHostIp: string
  now?: () => number
  /** Injected in tests to keep a poll instant. */
  sleep?: (ms: number) => Promise<void>
}

export interface RouterPollSummary {
  ts: number
  /** Status as the carrier reports it (`DEV2_FAST_LINE`, the one status field that does not lie). */
  lineStatus: string | null
  downSyncKbps: number | null
  upSyncKbps: number | null
  wanIfName: string | null
  wanRxKbps: number | null
  wanTxKbps: number | null
  lanRxKbps: number | null
  lanTxKbps: number | null
  intfRows: number
  portRows: number
  hostRows: number
  disagreements: Disagreement[]
  resync: boolean
  /** Non-fatal problems: a refused OID, a list that failed its count cross-check. */
  warnings: string[]
}

export class RouterPoller {
  private readonly db: BunSQLiteDatabase<typeof schema>
  private readonly client: RouterReader
  private readonly collectorHostIp: string
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  /**
   * Signature of the disagreements recorded at the previous poll, so an ongoing
   * disagreement produces one event rather than 288 a day. In memory on purpose:
   * after a restart the first poll re-announces a still-open disagreement once,
   * which is information (the process restarted and the conflict is still there)
   * rather than noise.
   */
  private lastDisagreementSignature: string | null = null

  constructor(deps: RouterPollerDeps) {
    this.db = deps.db
    this.client = deps.client
    this.collectorHostIp = deps.collectorHostIp
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => Bun.sleep(ms))
  }

  async poll(): Promise<RouterPollSummary> {
    // One fresh login per poll rather than a session kept alive between them.
    // The held session cost 64% of the carrier-side record: an eviction put the
    // client into a 15-minute re-login backoff, so 20 of 55 due polls over 4.5
    // hours were stored. At the 10-minute cadence this is 72 logins/day against
    // ~144 for repairing a session, it removes that failure mode instead of
    // tuning it, and it loses nothing measurable — `down_sync_kbps` had zero
    // variance across all 20 samples the old scheme did store.
    await this.client.startSession()

    const ts = this.now()
    const warnings: string[] = []

    const rows = {
      fastLine: [] as RouterRow[],
      lineStats: [] as RouterRow[],
      adtWan: [] as RouterRow[],
      ipIntf: [] as RouterRow[],
      ipIntfStats: [] as RouterRow[],
      ethIntf: [] as RouterRow[],
      hosts: [] as RouterRow[],
      hostEntry: [] as RouterRow[],
    }

    let first = true
    for (const [key, plan] of Object.entries(READS) as Array<[keyof typeof READS, ReadPlan]>) {
      if (!first) await this.sleep(READ_SPACING_MS)
      first = false
      try {
        rows[key] = await this.client.read(plan.oid, plan.operation)
      } catch (error) {
        // Only a genuinely per-OID failure degrades to a warning. Anything else
        // — no session, no route to the device, backing off — invalidates every
        // remaining read too, and continuing would record a poll made of
        // absences that reads exactly like a router reporting zeros.
        if (!(error instanceof RouterReadError)) throw error
        warnings.push(`${plan.oid}: ${error.message}`)
      }
    }

    const line = parseLineSample({ fastLine: rows.fastLine[0], lineStats: rows.lineStats[0] })
    const wan = parseLiveWan(rows.adtWan)
    const interfaces = parseIntfSamples({
      intf: rows.ipIntf,
      stats: rows.ipIntfStats,
      wanIfName: wan?.ifName ?? null,
    })
    const ports = parseEthPorts(rows.ethIntf)
    const hosts = parseHosts(rows.hostEntry)

    const hostCountMismatch = checkListLength({
      oid: READS.hostEntry.oid,
      rows: hosts,
      expected: parseHostCount(rows.hosts),
    })
    if (hostCountMismatch !== null) warnings.push(hostCountMismatch)

    // Only the live WAN and the LAN bridge are persisted. The other five
    // interfaces are configured-but-idle WAN profiles (USB 3G/4G, SFP, the two
    // spare PPPoE profiles for the fibre migration) reporting zeros; storing
    // them would be half a million rows a year of "0".
    const persistedInterfaces = interfaces.filter((intf) => intf.role === 'wan' || intf.role === 'lan')
    // Only active hosts. An inactive DEV2_HOST_ENTRY row is a stale DHCP lease,
    // not a connection, so its absence from a poll is the truthful record.
    const activeHosts = hosts.filter((host) => host.active === 1)

    const previousShowtime = this.db
      .select({ showtimeStartS: routerLineSample.showtimeStartS, ts: routerLineSample.ts })
      .from(routerLineSample)
      .orderBy(desc(routerLineSample.ts))
      .limit(1)
      .all()[0]
    const resync = detectResync(previousShowtime?.showtimeStartS ?? null, line.showtimeStartS)

    const collectorHost = hosts.find((host) => host.ip === this.collectorHostIp)
    const collectorPort = resolveHostPort({ host: collectorHost, ports })
    const hostVantage = this.latestHostVantage(ts)
    const disagreements =
      hostVantage === null
        ? []
        : compareVantage(hostVantage, this.routerVantage(collectorHost, collectorPort))

    const hasLineReading = rows.fastLine.length > 0 || rows.lineStats.length > 0
    const signature = disagreementSignature(disagreements)
    const signatureChanged = hostVantage !== null && signature !== this.lastDisagreementSignature

    this.db.transaction((tx) => {
      if (hasLineReading) {
        tx.insert(routerLineSample)
          .values({
            ts,
            carrier: line.carrier,
            status: line.status,
            downSyncKbps: line.downSyncKbps,
            upSyncKbps: line.upSyncKbps,
            downCurrKbps: line.downCurrKbps,
            upCurrKbps: line.upCurrKbps,
            // Already divided by 10 in parseLineSample: the router reports
            // margin and attenuation in tenths of a dB (61 = 6.1 dB) and the
            // column name promises real dB, so the conversion happens here at
            // the write site rather than in every consumer.
            downNoiseMarginDb: line.downNoiseMarginDb,
            upNoiseMarginDb: line.upNoiseMarginDb,
            downAttenuationDb: line.downAttenuationDb,
            profile: line.profile,
            showtimeStartS: line.showtimeStartS,
            erroredSecs: line.erroredSecs,
            severelyErroredSecs: line.severelyErroredSecs,
          })
          .run()
      }

      for (const intf of persistedInterfaces) {
        tx.insert(routerIntfSample)
          .values({
            ts,
            name: intf.name,
            stack: intf.stack,
            role: intf.role,
            rxKbps: intf.rxKbps,
            txKbps: intf.txKbps,
            bytesRx: intf.bytesRx,
            bytesTx: intf.bytesTx,
          })
          .run()
      }

      for (const port of ports) {
        tx.insert(routerEthPort)
          .values({
            ts,
            name: port.name,
            alias: port.alias,
            status: port.status,
            maxBitRate: port.maxBitRate,
            duplexMode: port.duplexMode,
          })
          .run()
      }

      for (const host of activeHosts) {
        tx.insert(routerHost)
          .values({
            ts,
            ip: host.ip,
            interfaceType: host.interfaceType,
            active: host.active,
            clientType: host.clientType,
          })
          .run()
      }

      if (resync) {
        tx.insert(event)
          .values({
            ts,
            kind: 'link_change',
            detail: JSON.stringify({
              source: 'router-poller',
              reason: 'line_resync',
              showtimeStartS: line.showtimeStartS,
              previousShowtimeStartS: previousShowtime?.showtimeStartS ?? null,
              previousPollTs: previousShowtime?.ts ?? null,
            }),
          })
          .run()
      }

      // The `event.kind` enum is fixed by the schema, so the precise reason
      // lives in `detail.reason`; both readings are kept and neither side is
      // declared correct.
      if (signatureChanged && disagreements.length > 0) {
        tx.insert(event)
          .values({
            ts,
            kind: 'link_change',
            detail: JSON.stringify({
              source: 'router-poller',
              reason: 'vantage_disagreement',
              hostCycleTs: hostVantage?.ts ?? null,
              disagreements,
            }),
          })
          .run()
      }
      if (signatureChanged && disagreements.length === 0 && this.lastDisagreementSignature !== null) {
        tx.insert(event)
          .values({
            ts,
            kind: 'link_change',
            detail: JSON.stringify({
              source: 'router-poller',
              reason: 'vantage_agreement_restored',
              hostCycleTs: hostVantage?.ts ?? null,
            }),
          })
          .run()
      }
    })

    if (signatureChanged) this.lastDisagreementSignature = signature

    const wanIntf = interfaces.find((intf) => intf.role === 'wan')
    const lanIntf = interfaces.find((intf) => intf.role === 'lan')
    return {
      ts,
      lineStatus: line.status,
      downSyncKbps: line.downSyncKbps,
      upSyncKbps: line.upSyncKbps,
      wanIfName: wan?.ifName ?? null,
      wanRxKbps: wanIntf?.rxKbps ?? null,
      wanTxKbps: wanIntf?.txKbps ?? null,
      lanRxKbps: lanIntf?.rxKbps ?? null,
      lanTxKbps: lanIntf?.txKbps ?? null,
      intfRows: persistedInterfaces.length,
      portRows: ports.length,
      hostRows: activeHosts.length,
      disagreements,
      resync,
      warnings,
    }
  }

  /** The collector's most recent vantage row, or null when it is too old to compare against. */
  private latestHostVantage(ts: number): HostVantage | null {
    const row = this.db
      .select()
      .from(probeCycle)
      .where(gte(probeCycle.ts, ts - HOST_VANTAGE_MAX_AGE_MS))
      .orderBy(desc(probeCycle.ts))
      .limit(1)
      .all()[0]
    if (row === undefined) return null
    return {
      ts: row.ts,
      pathClass: row.pathClass ?? null,
      linkMbit: row.linkMbit ?? null,
      linkDuplex: row.linkDuplex ?? null,
      onHomeLine: row.onHomeLine ?? null,
    }
  }

  private routerVantage(
    collectorHost: { ip: string | null; interfaceType: string | null; active: number | null } | undefined,
    port: EthPort | null,
  ): RouterVantage {
    return {
      port:
        port === null
          ? null
          : {
              name: port.name,
              alias: port.alias,
              status: port.status,
              maxBitRate: port.maxBitRate,
              duplexMode: port.duplexMode,
            },
      host:
        collectorHost === undefined
          ? null
          : {
              ip: collectorHost.ip,
              interfaceType: collectorHost.interfaceType,
              active: collectorHost.active,
            },
    }
  }
}

/**
 * A stored reading with the age it had when it was read.
 *
 * Every part of `GET /api/router` is wrapped in one of these because the parts
 * age independently and a WAN outage is exactly the case where they diverge:
 * the router still answers for the LAN bridge while `DEV2_ADT_WAN` reports no
 * connected instance, so no row with `role = 'wan'` is written at all. Serving
 * the last WAN row beside a fresh LAN row with nothing to tell them apart
 * presents a pre-outage number as the current throughput — the same class of
 * lie as a fabricated ICMP reply.
 */
export interface Observation<T> {
  /** Unix ms of the poll that produced this value. */
  observedAt: number
  /** Age at snapshot time. Negative only under clock skew, and reported as measured. */
  ageMs: number
  /** `ageMs > staleAfterMs`: this is history, not a current reading. */
  stale: boolean
  value: T
}

export interface RouterSnapshotParams {
  collectorHostIp: string
  /** Age at which a value stops being current — `routerConfig.staleAfterMs` in production. */
  staleAfterMs: number
  now?: number
}

type LineRow = typeof routerLineSample.$inferSelect
type IntfRow = typeof routerIntfSample.$inferSelect
type HostRow = typeof routerHost.$inferSelect
type EthPortRow = typeof routerEthPort.$inferSelect

export interface RouterSnapshot {
  /** When the snapshot was taken — the reference for every `ageMs` below. */
  now: number
  staleAfterMs: number
  line: Observation<LineRow> | null
  wan: Observation<IntfRow> | null
  lan: Observation<IntfRow> | null
  collector: Observation<HostRow> | null
  /** Every port from the newest port poll, as one observation: they share a `ts`. */
  ports: Observation<EthPortRow[]> | null
}

/**
 * The most recent reading from each router table, for `GET /api/router`.
 *
 * Every part is fetched independently rather than by joining on one poll's `ts`:
 * a poll where one OID was refused writes some tables and not others, and a
 * snapshot that hid the rest of that poll would report "no data" for a router
 * that answered. That independence is why each part carries its own
 * `observedAt`/`stale` — see `Observation`. Nothing is dropped for being old;
 * it is labelled, because "the WAN interface was last seen 40 minutes ago" is
 * itself the finding.
 *
 * The host/router corroboration is deliberately *not* recomputed here. It is
 * materialised into `event` at poll time, like outages — the port a host sits on
 * is resolved through a firmware pointer that is not persisted, so a read path
 * could only guess it.
 */
export function readRouterSnapshot(
  db: BunSQLiteDatabase<typeof schema>,
  params: RouterSnapshotParams,
): RouterSnapshot {
  const now = params.now ?? Date.now()
  const { staleAfterMs } = params

  function observe<T>(value: T, observedAt: number): Observation<T> {
    const ageMs = now - observedAt
    return { observedAt, ageMs, stale: ageMs > staleAfterMs, value }
  }

  const observeRow = <T extends { ts: number }>(row: T | undefined): Observation<T> | null =>
    row === undefined ? null : observe(row, row.ts)

  const latestIntfByRole = (role: 'wan' | 'lan') =>
    observeRow(
      db
        .select()
        .from(routerIntfSample)
        .where(eq(routerIntfSample.role, role))
        .orderBy(desc(routerIntfSample.ts))
        .limit(1)
        .all()[0],
    )

  const line = observeRow(db.select().from(routerLineSample).orderBy(desc(routerLineSample.ts)).limit(1).all()[0])
  const collector = observeRow(
    db
      .select()
      .from(routerHost)
      .where(eq(routerHost.ip, params.collectorHostIp))
      .orderBy(desc(routerHost.ts))
      .limit(1)
      .all()[0],
  )
  const latestPortTs = db.select({ ts: routerEthPort.ts }).from(routerEthPort).orderBy(desc(routerEthPort.ts)).limit(1).all()[0]
  const ports =
    latestPortTs === undefined
      ? null
      : observe(db.select().from(routerEthPort).where(eq(routerEthPort.ts, latestPortTs.ts)).all(), latestPortTs.ts)

  return { now, staleAfterMs, line, wan: latestIntfByRole('wan'), lan: latestIntfByRole('lan'), collector, ports }
}

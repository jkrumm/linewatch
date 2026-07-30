import { desc, lt } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { event, probeCycle } from '../db/schema.js'
import type * as schema from '../db/schema.js'

export type PathClass = 'ethernet' | 'wifi' | 'cellular' | 'other'
export type LinkDuplex = 'full' | 'half'

/**
 * What one probe cycle measured *through*, as reported by the collector. Every
 * field is nullable: the collector is native under launchd and the API is in
 * Docker, so they deploy independently and a field the running collector does
 * not report yet must read as "unknown", never as a default.
 */
export interface CycleVantage {
  pathIf?: string | null | undefined
  pathClass?: PathClass | null | undefined
  linkMedia?: string | null | undefined
  linkMbit?: number | null | undefined
  linkDuplex?: LinkDuplex | null | undefined
  gatewayAddr?: string | null | undefined
  ifIerrs?: number | null | undefined
  ifOerrs?: number | null | undefined
  ifColl?: number | null | undefined
  /**
   * The collector's own verdict, if it computed one. `0`/`1` is what
   * collector/vantage.ts sends (it mirrors the SQLite column); a boolean is
   * accepted too so neither side has to be redeployed for the other's spelling.
   */
  onHomeLine?: boolean | 0 | 1 | null | undefined
}

/** The fields whose change is a link change worth an `event` row. */
const WATCHED = ['pathIf', 'pathClass', 'linkMbit', 'linkDuplex'] as const
type WatchedField = (typeof WATCHED)[number]

/** Just the fields the diff looks at — both `probe_cycle` rows and fresh input satisfy it. */
export interface WatchedVantage {
  pathIf: string | null
  pathClass: PathClass | null
  linkMbit: number | null
  linkDuplex: LinkDuplex | null
}

export interface FieldChange {
  before: string | number
  after: string | number
}

export type LinkChangeDetail = { changed: Partial<Record<WatchedField, FieldChange>> }

export interface RecordCycleVantageResult {
  /** false when a row for this `ts` already existed — a spool replay. */
  inserted: boolean
  /** id of the `link_change` event written for this cycle, if any. */
  linkChangeEventId: number | null
}

/**
 * What the reported *facts* say on their own, ignoring the collector's verdict.
 *
 * Disqualifying evidence needs only one disqualifying fact, so a missing field
 * never rescues a cycle:
 *
 * - a known `pathClass` that is not `ethernet` is `false` **whether or not a
 *   gateway was reported** — cellular is not the home line, and no gateway
 *   (or the absence of one) can make it so;
 * - a known gateway that is not the home gateway is `false` for the same
 *   reason, whatever the path class: that default route did not go through the
 *   home router;
 * - `true` requires both halves to be present *and* right;
 * - anything else is genuine absence of evidence → `null`.
 *
 * The mirror of collector/vantage.ts `deriveOnHomeLine`, and deliberately so:
 * Ethernet with no gateway on the default route is `null` there and here, since
 * a default route can legitimately carry no gateway (host-side PPPoE, a VPN
 * owning the route) and scoring that `false` would discard the real home line.
 */
function deriveFromFacts(vantage: CycleVantage, homeGatewayAddr: string): boolean | null {
  const pathClass = vantage.pathClass ?? null
  const gatewayAddr = vantage.gatewayAddr ?? null

  if (pathClass !== null && pathClass !== 'ethernet') return false
  if (gatewayAddr !== null && gatewayAddr !== homeGatewayAddr) return false
  if (pathClass === 'ethernet' && gatewayAddr === homeGatewayAddr) return true
  return null
}

/**
 * The refuse-to-lie decision, kept pure so its three states are testable
 * without a database.
 *
 * - `true`  — the cycle ran over Ethernet *and* through the configured home
 *   gateway, i.e. it really did measure the home line.
 * - `false` — anything else: Wi-Fi, cellular (the mini has two cellular paths
 *   in its service order — a hotspot and iPhone USB), or an unexpected gateway.
 * - `null`  — not reported, i.e. unknown. Never coalesce this to `true`.
 *
 * The two directions are deliberately asymmetric, because the two claims are
 * not equally cheap to make:
 *
 * - **Either party may disqualify a cycle.** The collector saying `0`, a
 *   non-Ethernet path class, or a foreign gateway each resolve to `false` on
 *   their own — a disagreement therefore also resolves to `false`.
 * - **Only the server may affirm one.** `true` is returned when *the facts*
 *   prove it; a collector verdict of `1` with nothing to check it against is
 *   `null`, not `true`. "Which gateway is home" is server configuration, so a
 *   collector running against a different gateway target must not be able to
 *   assert this line by itself — and this is the exact hole that let a cycle
 *   with `pathClass: 'cellular'` and no gateway be stored as the home line.
 */
export function resolveOnHomeLine(vantage: CycleVantage, homeGatewayAddr: string): boolean | null {
  const raw = vantage.onHomeLine ?? null
  const reported = raw === null ? null : Boolean(raw)
  const derived = deriveFromFacts(vantage, homeGatewayAddr)

  if (derived === false || reported === false) return false
  return derived === true ? true : null
}

/**
 * Diff the vantage against the previous cycle. `null` on either side is
 * *unknown*, not a value, so `null → 'en0'` (the collector being upgraded) and
 * `'en0' → null` (the collector losing the ability to report) are both silence.
 * Only a genuine value-to-value difference is a link change.
 */
export function diffVantage(previous: WatchedVantage | null, current: WatchedVantage): LinkChangeDetail['changed'] {
  const changed: LinkChangeDetail['changed'] = {}
  if (!previous) return changed

  for (const field of WATCHED) {
    const before: string | number | null = previous[field]
    const after: string | number | null = current[field]
    if (before === null || after === null) continue
    if (before === after) continue
    changed[field] = { before, after }
  }
  return changed
}

/**
 * Persist one cycle's vantage and materialise a `link_change` event when the
 * path actually changed — the same architecture as the outage state machine
 * (services/outage-detector.ts): written once on ingest, never derived on read,
 * so the timeline the dashboard draws is a record rather than a recomputation.
 *
 * Idempotent on `ts`: `probe_cycle.ts` is UNIQUE and the collector replays
 * spooled batches verbatim, so a replay must be a no-op rather than a 500 or a
 * duplicate event. The event is only considered when the insert actually
 * happened.
 *
 * Injected `db` (ports-and-adapters, rules/code-style.md) and an injected home
 * gateway rather than the config singleton, so tests need no process config.
 */
export function recordCycleVantage(
  db: BunSQLiteDatabase<typeof schema>,
  args: { ts: number; vantage: CycleVantage; homeGatewayAddr: string },
): RecordCycleVantageResult {
  const { ts, vantage, homeGatewayAddr } = args

  const onHomeLine = resolveOnHomeLine(vantage, homeGatewayAddr)
  const row = {
    ts,
    pathIf: vantage.pathIf ?? null,
    pathClass: vantage.pathClass ?? null,
    linkMedia: vantage.linkMedia ?? null,
    linkMbit: vantage.linkMbit ?? null,
    linkDuplex: vantage.linkDuplex ?? null,
    gatewayAddr: vantage.gatewayAddr ?? null,
    ifIerrs: vantage.ifIerrs ?? null,
    ifOerrs: vantage.ifOerrs ?? null,
    ifColl: vantage.ifColl ?? null,
    onHomeLine: onHomeLine === null ? null : Number(onHomeLine),
  }

  // Read the predecessor *before* inserting, so "previous" cannot be this row.
  // Strictly `< ts`: an out-of-order spool replay of an older cycle must be
  // compared against what preceded *it*, not against the newest cycle on record.
  const previous = db.select().from(probeCycle).where(lt(probeCycle.ts, ts)).orderBy(desc(probeCycle.ts)).limit(1).get() ?? null

  const insertedRow = db.insert(probeCycle).values(row).onConflictDoNothing({ target: probeCycle.ts }).returning({ id: probeCycle.id }).get()
  if (!insertedRow) return { inserted: false, linkChangeEventId: null }

  // The very first cycle on record has no predecessor, so there is nothing it
  // could have changed *from* — emitting "changed from null" there would invent
  // an event out of the start of the dataset.
  const changed = diffVantage(previous, row)
  if (Object.keys(changed).length === 0) return { inserted: true, linkChangeEventId: null }

  const detail: LinkChangeDetail = { changed }
  const eventRow = db.insert(event).values({ ts, kind: 'link_change', detail: JSON.stringify(detail) }).returning({ id: event.id }).get()
  return { inserted: true, linkChangeEventId: eventRow.id }
}

/** The most recent cycle's vantage, or null when none was ever recorded. */
export function currentVantage(db: BunSQLiteDatabase<typeof schema>) {
  return db.select().from(probeCycle).orderBy(desc(probeCycle.ts)).limit(1).get() ?? null
}

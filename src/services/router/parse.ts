import type { RouterRow } from './redact.js'

/**
 * Pure parsers over redacted router rows.
 *
 * Every field mapping here is a measured fact about this firmware, not a reading
 * of the TR-181 data model — the two disagree constantly on this unit. The
 * corrections that cost the most to find:
 *
 * - `DEV2_FAST_LINE` carries sync rates, SNR margin, attenuation, profile and a
 *   *truthful* status. `DEV2_FAST_LINE_STATS` is all zero.
 * - `DEV2_DSL_LINE_STATS` carries the byte counters and `showtimeStart` for the
 *   active line even though `DEV2_DSL_LINE.status` reads `Down` while it is up.
 * - `X_TP_DownstreamCurrRate` means different things per OID: ~804700 (kbps, a
 *   line rate) on `DEV2_FAST_LINE`, ~3600 on `DEV2_DSL_LINE_STATS`. The name is
 *   not a unit, so only the `DEV2_FAST_LINE` pair is stored.
 * - `DEV2_IP_INTF_STATS` has no `name`; it pairs with `DEV2_IP_INTF` by `stack`.
 * - Noise margin and attenuation are in tenths of a dB (61 = 6.1 dB).
 */

/** Values the redactor replaced are absent as far as a parser is concerned. */
function present(value: string | undefined): value is string {
  return value !== undefined && value !== '' && !value.startsWith('<')
}

function str(row: RouterRow | undefined, key: string): string | null {
  const value = row?.[key]
  return present(value) ? value : null
}

function int(row: RouterRow | undefined, key: string): number | null {
  const value = str(row, key)
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

/** The router reports margin and attenuation in tenths of a dB: 61 means 6.1 dB. */
function tenthsToDb(tenths: number | null): number | null {
  return tenths === null ? null : tenths / 10
}

/** First non-null of several keys — firmware moves fields between revisions. */
function firstInt(row: RouterRow | undefined, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = int(row, key)
    if (value !== null) return value
  }
  return null
}

function firstStr(row: RouterRow | undefined, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = str(row, key)
    if (value !== null) return value
  }
  return null
}

export type Carrier = 'gfast' | 'dsl' | 'gpon'
export type IntfRole = 'wan' | 'lan' | 'other'

export interface LineSample {
  carrier: Carrier | null
  status: string | null
  downSyncKbps: number | null
  upSyncKbps: number | null
  downCurrKbps: number | null
  upCurrKbps: number | null
  downNoiseMarginDb: number | null
  upNoiseMarginDb: number | null
  downAttenuationDb: number | null
  profile: string | null
  showtimeStartS: number | null
  erroredSecs: number | null
  severelyErroredSecs: number | null
}

/**
 * Carrier health from the two half-populated families that between them describe
 * the active line: `DEV2_FAST_LINE` (`fastLine`) and `DEV2_DSL_LINE_STATS`
 * (`lineStats`). Either may be missing; every field is independently nullable
 * because a poll that only got `status` is still worth recording.
 *
 * `down/up_curr_kbps` come from `DEV2_FAST_LINE`'s `X_TP_*CurrRate`, which on
 * this OID tracks the line's *current attainable* rate (measured 804707 against
 * a negotiated 803140), not utilisation. Utilisation is `router_intf_sample`.
 */
export function parseLineSample(input: {
  fastLine: RouterRow | undefined
  lineStats: RouterRow | undefined
}): LineSample {
  const { fastLine, lineStats } = input
  return {
    // The G.fast family answering at all is what identifies the carrier; a GPON
    // unit will populate a different OID and report `gpon` from its own parser.
    carrier: fastLine !== undefined ? 'gfast' : null,
    status: str(fastLine, 'status'),
    downSyncKbps: int(fastLine, 'downstreamMaxBitRate'),
    upSyncKbps: int(fastLine, 'upstreamMaxBitRate'),
    downCurrKbps: int(fastLine, 'X_TP_DownstreamCurrRate'),
    upCurrKbps: int(fastLine, 'X_TP_UpstreamCurrRate'),
    downNoiseMarginDb: tenthsToDb(int(fastLine, 'downstreamNoiseMargin')),
    upNoiseMarginDb: tenthsToDb(int(fastLine, 'upstreamNoiseMargin')),
    downAttenuationDb: tenthsToDb(int(fastLine, 'downstreamAttenuation')),
    // Measured 2026-07-30: this firmware exposes `allowedProfiles` (`106a;212a`)
    // but not the profile actually in use, so this stays null rather than
    // storing the allowed set under a column that promises the active one. The
    // key list is a fallback for a firmware that starts reporting it.
    profile: firstStr(fastLine, ['X_TP_Profile', 'currentProfile', 'profile']),
    // Seconds since the line reached showtime. Only DEV2_DSL_LINE_STATS has it;
    // the G.fast STATS family reads zero across every field.
    showtimeStartS: int(lineStats, 'showtimeStart'),
    // Present in the DSL error-counter families, which are all zero on this unit
    // because they belong to the inactive carrier. Left null rather than stored
    // as 0 — a fabricated zero would read as "no errors measured".
    erroredSecs: firstInt(lineStats, ['erroredSecs', 'X_TP_ErroredSecs']),
    severelyErroredSecs: firstInt(lineStats, ['severelyErroredSecs', 'X_TP_SeverelyErroredSecs']),
  }
}

export interface LiveWan {
  /** The connection's configured name, e.g. `ipoe_ptm_0_0_d`. */
  name: string | null
  /** The interface it runs over, e.g. `ppp0` — the join key into DEV2_IP_INTF. */
  ifName: string | null
  connType: string | null
  connStatusV4: string | null
  connStatusV6: string | null
}

/**
 * Picks the live WAN connection out of `DEV2_ADT_WAN`'s six instances.
 *
 * Selected by status, never by index: the index is firmware layout, not a
 * contract, and the other five instances are configured-but-idle profiles
 * (USB 3G/4G, SFP, two spare PPPoE profiles for the fibre migration).
 *
 * `connStatusV4` reads `Connecting` on this line as its steady state — IPv4 is
 * carried over DS-Lite (`X_TP_DsliteEnable=1`) while `connStatusV6` reads
 * `Connected` and the line passes traffic. So "not Disconnected" is the test,
 * and a v6-connected instance qualifies too.
 */
export function parseLiveWan(rows: readonly RouterRow[]): LiveWan | null {
  const candidates = rows.filter(
    (row) => str(row, 'connStatusV4') !== 'Disconnected' || str(row, 'connStatusV6') === 'Connected',
  )
  const chosen =
    candidates.find((row) => str(row, 'connStatusV4') === 'Connected') ?? candidates[0] ?? null
  if (chosen === null) return null
  return {
    name: str(chosen, 'name'),
    ifName: str(chosen, 'ifName'),
    connType: str(chosen, 'connType'),
    connStatusV4: str(chosen, 'connStatusV4'),
    connStatusV6: str(chosen, 'connStatusV6'),
  }
}

export interface IntfSample {
  name: string
  stack: number | null
  role: IntfRole
  /**
   * Rates in kbps, and on the WAN row `rx` is the downstream direction.
   *
   * Both facts are measured, not inferred: under a ~190 Mbit/s download the WAN
   * interface reported `rxKbps` 152682 while its own byte counters averaged
   * 123948 kbps over the same window, and the LAN bridge mirrored it (`txKbps`
   * 154179).
   *
   * The router computes these over its own ~30-second window
   * (`X_TP_LastPeriod` reads 33), so two polls less than that apart return the
   * identical value. At the 10-minute cadence each sample is therefore a 30s
   * average taken at poll time, *not* a 10-minute mean — which is why the
   * cumulative byte counters are stored alongside: they give the true average
   * between any two polls.
   */
  rxKbps: number | null
  txKbps: number | null
  bytesRx: number | null
  bytesTx: number | null
}

/** `"4,0,0,0,0,0"` identifies instance 4. */
function stackHead(row: RouterRow | undefined): number | null {
  const raw = str(row, 'stack')
  if (raw === null) return null
  const head = Number(raw.split(',')[0])
  return Number.isFinite(head) ? head : null
}

/**
 * Per-interface throughput, joining `DEV2_IP_INTF` (names, connection type) to
 * `DEV2_IP_INTF_STATS` (rates, byte counters) on the `stack` string — the stats
 * OID carries no name at all, so the join is the only thing that makes its
 * numbers mean anything.
 *
 * `role` is resolved by name against the live WAN interface rather than by stack
 * position. The measured layout happens to be stack 4 = `ppp0` = WAN and stack 1
 * = `br0` = LAN, and it will change when the fibre ONT replaces the G.fast WAN.
 *
 * Interfaces the firmware reports without a name are dropped: a rate with no
 * interface attached to it is not a measurement of anything.
 */
export function parseIntfSamples(input: {
  intf: readonly RouterRow[]
  stats: readonly RouterRow[]
  wanIfName: string | null
}): IntfSample[] {
  const statsByStack = new Map<string, RouterRow>()
  for (const row of input.stats) {
    const stack = str(row, 'stack')
    if (stack !== null) statsByStack.set(stack, row)
  }

  const samples: IntfSample[] = []
  for (const row of input.intf) {
    const name = str(row, 'name')
    if (name === null) continue
    const stackKey = str(row, 'stack')
    const stats = stackKey === null ? undefined : statsByStack.get(stackKey)
    const role: IntfRole =
      input.wanIfName !== null && name === input.wanIfName
        ? 'wan'
        : str(row, 'X_TP_ConnType') === 'LAN'
          ? 'lan'
          : 'other'
    samples.push({
      name,
      stack: stackHead(row),
      role,
      rxKbps: int(stats, 'X_TP_RxThroughput'),
      txKbps: int(stats, 'X_TP_TxThroughput'),
      bytesRx: int(stats, 'bytesReceived'),
      bytesTx: int(stats, 'bytesSent'),
    })
  }
  return samples
}

export interface EthPort {
  name: string | null
  alias: string | null
  status: string | null
  maxBitRate: number | null
  duplexMode: string | null
  /** Instance number, kept to match a host's `layer1Interface` reference. Not persisted. */
  stack: number | null
}

/** The router's own view of each LAN/WAN port's negotiated link (`DEV2_ETH_INTF`). */
export function parseEthPorts(rows: readonly RouterRow[]): EthPort[] {
  return rows.map((row) => ({
    name: str(row, 'name'),
    alias: str(row, 'X_TP_IfNameAlias'),
    status: str(row, 'status'),
    maxBitRate: int(row, 'maxBitRate'),
    duplexMode: str(row, 'duplexMode'),
    stack: stackHead(row),
  }))
}

export interface HostEntry {
  ip: string | null
  interfaceType: string | null
  active: number | null
  clientType: string | null
  /** `Device.Ethernet.Interface.N.` — the router's own pointer at the port. */
  layer1Interface: string | null
}

/**
 * Connected devices (`DEV2_HOST_ENTRY`, which must be read with `gl`).
 *
 * The device name (`hostName`/`X_TP_HostName`) is deliberately not read. A fifth
 * of the names this router hands out are vendor defaults of the form three-letter
 * prefix + 12 hex digits — a MAC with its separators stripped — so storing the
 * name stored the MAC. `redact.ts` now blanks the key as well, but the parser not
 * asking is the guard that survives a firmware calling the field something else.
 */
export function parseHosts(rows: readonly RouterRow[]): HostEntry[] {
  return rows.map((row) => ({
    ip: str(row, 'IPAddress'),
    interfaceType: str(row, 'interfaceType'),
    active: int(row, 'active'),
    clientType: str(row, 'X_TP_ClientType'),
    layer1Interface: str(row, 'layer1Interface') ?? str(row, 'X_TP_Layer2Interface'),
  }))
}

/**
 * The Ethernet port a host is attached to, resolved through the firmware's own
 * `Device.Ethernet.Interface.N.` reference rather than guessed.
 *
 * The guess is not survivable: on this unit LAN1 negotiated 1000 Mbit and LAN2
 * negotiated 100 Mbit, both `Up`. Picking "the first port that is up" would have
 * compared the collector host's 1000baseT against LAN2's 100 and reported a
 * link-speed disagreement that does not exist.
 */
export function resolveHostPort(input: {
  host: HostEntry | undefined
  ports: readonly EthPort[]
}): EthPort | null {
  const reference = input.host?.layer1Interface
  if (reference === undefined || reference === null) return null
  const instance = Number(reference.match(/Device\.Ethernet\.Interface\.(\d+)\.?$/)?.[1])
  if (!Number.isFinite(instance)) return null
  return input.ports.find((port) => port.stack === instance) ?? null
}

/**
 * Guards against the silent-truncation failure this protocol invites: `go` on a
 * LIST object returns only the first instance without reporting an error, so a
 * plausible one-row answer is indistinguishable from the truth unless the row
 * count is checked against the firmware's own count field.
 *
 * Returns a description of the mismatch, or null when the list is trustworthy.
 */
export function checkListLength(input: {
  oid: string
  rows: readonly unknown[]
  expected: number | null
}): string | null {
  if (input.expected === null) return null
  if (input.rows.length === input.expected) return null
  const truncation = input.rows.length === 1 && input.expected > 1 ? ' (the "go" truncation shape)' : ''
  return `${input.oid} returned ${input.rows.length} instances, firmware reports ${input.expected}${truncation}`
}

/** `DEV2_HOSTS.hostNumberOfEntries` — the count that validates the host list. */
export function parseHostCount(rows: readonly RouterRow[]): number | null {
  return int(rows[0], 'hostNumberOfEntries')
}

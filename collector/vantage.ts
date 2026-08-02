/**
 * Captures the *vantage point* of a probe cycle: not what the line measured,
 * but what it was measured **through**. Every probe_sample row used to be
 * implicitly "the home line over Ethernet" — prose in docs/DESIGN.md rather
 * than a column — which made five different situations look identical: WAN
 * down, gateway down, en0 renegotiated to 100baseTX (a throughput *cap*, not
 * an outage), the host failed over to Wi-Fi, and the host failed over to
 * cellular (not the home line at all). The last one is real on this host: the
 * service order carries two cellular egresses, a mobile hotspot and phone USB
 * tethering, either of which macOS will use if the wired path goes away.
 *
 * Dependency-free by design, exactly like ping-parser.ts (see probe.ts's
 * header): pure string parsing plus one thin impure caller that shells out to
 * `route`, `ifconfig`, `netstat`, `networksetup` and `ipconfig`. No npm deps,
 * no import of src/config.ts or anything pulling in elysia/drizzle/zod.
 *
 * Two rules the parsers exist to enforce:
 *
 * 1. **Unparseable is `null`, never a default.** A fabricated `1000` for
 *    link_mbit or an assumed `ethernet` for path_class is precisely the lie
 *    this module was added to prevent — worse than no data, because it reads
 *    as measured. The converse matters just as much: only *genuine absence of
 *    evidence* yields `null`. Evidence that positively rules the home line out
 *    (a cellular path class) is a `0`, not an "unknown".
 * 2. **The default route is authoritative.** path_if/gateway_addr come from
 *    `route -n get default` every cycle, never from configuration. Config says
 *    what *should* carry the traffic; only the routing table knows what did.
 * 3. **Looking and finding nothing is a measurement.** A cycle with no default
 *    route at all still returns a vantage — an all-null one. Returning nothing
 *    would make the most diagnostic state on this host (link down) identical on
 *    the wire to a collector too old to have looked.
 */

export type PathClass = 'ethernet' | 'wifi' | 'cellular' | 'other'
export type LinkDuplex = 'full' | 'half'

/** The probe_cycle contract (src/db/schema.ts `probeCycle`), minus id/ts. */
export interface Vantage {
  pathIf: string | null
  pathClass: PathClass | null
  linkMedia: string | null
  linkMbit: number | null
  linkDuplex: LinkDuplex | null
  gatewayAddr: string | null
  /** Cumulative since boot, straight from netstat — the API/UI diffs them. */
  ifIerrs: number | null
  ifOerrs: number | null
  ifColl: number | null
  /** Cumulative byte counters, same row and same contract as the error counters
   * above: the difference between consecutive cycles is the throughput history.
   * A negative difference is a reboot resetting them, never negative traffic. */
  ifIbytes: number | null
  ifObytes: number | null
  /**
   * 1 = Ethernet *and* the expected home gateway; 0 = measured through
   * something else; null = could not be determined. Never coalesce null to 1.
   */
  onHomeLine: 0 | 1 | null
  /** Fastest *supported* media, from `ifconfig -m` — see parseSupportedMedia. */
  linkMaxMbit: number | null
  /** DHCP lease start on path_if, unix ms — see parseDhcpLeaseStart. */
  dhcpBoundAt: number | null
  /**
   * Seconds of 1 Hz link sampling backing this cycle. Null here on purpose:
   * this collector has no link sampler yet, and null reads as "link state
   * unknown for this cycle" rather than "stable". The field is on the wire
   * already so the server can store it the day the sampler lands.
   */
  linkWatchS: number | null
}

// ---------------------------------------------------------------------------
// `route -n get default`
// ---------------------------------------------------------------------------

export interface DefaultRoute {
  iface: string | null
  gateway: string | null
}

const ROUTE_INTERFACE = /^\s*interface:\s*(\S+)\s*$/
const ROUTE_GATEWAY = /^\s*gateway:\s*(\S+)\s*$/

/**
 * A route can legitimately have an interface and no gateway (measured:
 * `route -n get 255.255.255.255` prints an `interface:` line and no
 * `gateway:`), so the two fields are parsed independently and either may be
 * null.
 */
export function parseDefaultRoute(output: string): DefaultRoute {
  let iface: string | null = null
  let gateway: string | null = null

  for (const line of output.split('\n')) {
    const ifaceMatch = ROUTE_INTERFACE.exec(line)
    if (ifaceMatch?.[1] !== undefined) iface = ifaceMatch[1]
    const gatewayMatch = ROUTE_GATEWAY.exec(line)
    if (gatewayMatch?.[1] !== undefined) gateway = gatewayMatch[1]
  }

  return { iface, gateway }
}

// ---------------------------------------------------------------------------
// `ifconfig <if>` — negotiated media
// ---------------------------------------------------------------------------

export interface LinkState {
  linkMedia: string | null
  linkMbit: number | null
  linkDuplex: LinkDuplex | null
}

const MEDIA_LINE = /^\s*media:\s*(.+?)\s*$/
/**
 * Splits a media descriptor into candidate tokens. `media:` lines wrap the
 * token in parentheses and angle brackets — `autoselect (1000baseT
 * <full-duplex>)` — and a manually configured line has none of that. Splitting
 * on those delimiters first is what lets MEDIA_TOKEN be **anchored**, and the
 * anchoring is the whole point (see below).
 */
const MEDIA_DELIMITERS = /[\s()<>,]+/
/**
 * Matches the media token in every form macOS prints, **whole-token only**.
 * Measured on this host's en0 (`ifconfig -m`): `10baseT/UTP`, `100baseTX`,
 * `1000baseT`. A 2.5G Thunderbolt adapter is a planned upgrade (docs/DESIGN.md
 * "Known limits") and that family prints `2500Base-T` / `5000Base-T` /
 * `10Gbase-T` / `2.5GBase-T` / `5GBase-T` — hence case-insensitive, hence the
 * optional `G` multiplier, and hence the optional decimal.
 *
 * The `^…$` anchors are load-bearing. Unanchored, this pattern matched the tail
 * of `2.5GBase-T` and reported a 2.5 Gbit link as `5GBase-T` at 5000 Mbit — a
 * fabricated speed *and* a media string the driver never printed, on precisely
 * the adapter the upgrade would install.
 */
const MEDIA_TOKEN = /^(\d+(?:\.\d+)?)(G)?base([\w/-]*)$/i

export function parseLinkState(output: string): LinkState {
  for (const line of output.split('\n')) {
    const media = MEDIA_LINE.exec(line)
    const descriptor = media?.[1]
    if (descriptor === undefined) continue

    const token = findMediaToken(descriptor)
    return {
      // The token when there is one (`autoselect (1000baseT <full-duplex>)` →
      // `1000baseT`), otherwise the descriptor as printed. Wi-Fi reports a bare
      // `media: autoselect` and an idle bridge reports `<unknown type>`; keeping
      // those verbatim means a shape this parser does not understand yet is
      // still recoverable from the record afterwards.
      linkMedia: token?.[0] ?? descriptor,
      linkMbit: mbitFromToken(token),
      linkDuplex: duplexFromDescriptor(descriptor),
    }
  }

  return { linkMedia: null, linkMbit: null, linkDuplex: null }
}

function findMediaToken(descriptor: string): RegExpExecArray | null {
  for (const candidate of descriptor.split(MEDIA_DELIMITERS)) {
    const token = MEDIA_TOKEN.exec(candidate)
    if (token !== null) return token
  }
  return null
}

function mbitFromToken(token: RegExpExecArray | null): number | null {
  const digits = token?.[1]
  if (digits === undefined) return null
  const value = Number(digits)
  if (!Number.isFinite(value) || value <= 0) return null
  // `10Gbase-T` is 10 000 Mbit/s, `2.5GBase-T` is 2500, `1000baseT` is 1000.
  const mbit = token?.[2] === undefined ? value : value * 1000
  // link_mbit is an integer column. A decimal that does not resolve to a whole
  // number of Mbit is a token shape this parser does not understand, and a
  // rounded guess would read as measured — so it is null, like every other
  // unparseable input here.
  return Number.isInteger(mbit) ? mbit : null
}

function duplexFromDescriptor(descriptor: string): LinkDuplex | null {
  const lower = descriptor.toLowerCase()
  if (lower.includes('full-duplex')) return 'full'
  if (lower.includes('half-duplex')) return 'half'
  return null
}

// ---------------------------------------------------------------------------
// `ifconfig -m <if>` — supported media
// ---------------------------------------------------------------------------

/**
 * Only lines that are part of a media list are considered, so a stray numeric
 * token elsewhere in `ifconfig -m` output can never be read as a speed. Both
 * spellings appear: the supported list prints `media 1000baseT mediaopt
 * full-duplex`, the negotiated line prints `media: autoselect (1000baseT …)`.
 */
const MEDIA_ENTRY_LINE = /(?:^|\s)media[\s:]/

/**
 * The **ceiling** of the interface, from its supported-media list — not the
 * speed it negotiated (that is `parseLinkState`). The two together are what
 * make a 100 Mbit link actionable: a NIC that supports 1000 and negotiated 100
 * is a cable or switch-port fault, while a NIC whose maximum *is* 100 is
 * hardware, and the suggested fix is the opposite in each case.
 *
 * Measured on this host's en0: `10baseT/UTP`, `100baseTX`, `1000baseT`.
 * The maximum recognised token wins; an unrecognised one contributes nothing
 * rather than becoming a guess, and no recognised token at all — a failed
 * command, Wi-Fi's bare `media: autoselect` — is `null`. A fabricated 1000
 * would invent a cable fault out of a NIC that never had the capability.
 */
export function parseSupportedMedia(output: string): number | null {
  let maxMbit: number | null = null

  for (const line of output.split('\n')) {
    if (!MEDIA_ENTRY_LINE.test(line)) continue
    for (const candidate of line.split(MEDIA_DELIMITERS)) {
      const mbit = mbitFromToken(MEDIA_TOKEN.exec(candidate))
      if (mbit === null) continue
      if (maxMbit === null || mbit > maxMbit) maxMbit = mbit
    }
  }

  return maxMbit
}

// ---------------------------------------------------------------------------
// `ipconfig getsummary <if>` — DHCP lease start
// ---------------------------------------------------------------------------

/**
 * Local time, no zone marker — measured format `07/30/2026 15:48:29`. Appears
 * exactly once in the summary.
 */
const DHCP_LEASE_START = /^\s*LeaseStartTime\s*:\s*(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}:\d{2})\s*$/m

/**
 * When the interface last took a DHCP lease, as unix ms. The host-side analogue
 * of the router's `showtime_start_s`: an absolute instant the OS carries
 * forward, so one sample dates the last re-bind retroactively instead of only
 * from the moment the collector started watching.
 *
 * Asymmetric evidence, hence the field name. A *change* in this value proves
 * the interface re-bound; an unchanged value proves nothing about link
 * stability — measured on this host, two logged en0 link-downs left the lease
 * untouched, so reading "same lease" as "the link held" would be an inference
 * dressed as a measurement.
 *
 * Everything else `ipconfig getsummary` prints is deliberately ignored. The
 * output embeds the raw DHCP packet — this host's MAC in `chaddr`, the DHCP
 * server identifier — and this is a public repo, so only this one line is ever
 * extracted, and the raw output is never logged, spooled or stored. The three
 * `State :` lines (BOUND / InformComplete / Acquired) are not parsed either:
 * which of them describes the interface is ambiguous, and no rule consumes it.
 */
export function parseDhcpLeaseStart(output: string): number | null {
  const match = DHCP_LEASE_START.exec(output)
  const [, month, day, year, time] = match ?? []
  if (month === undefined || day === undefined || year === undefined || time === undefined) return null

  // No trailing `Z`: a bare date-time is parsed as *local* time, which is what
  // the OS printed and what handles DST correctly. Appending `Z` would shift
  // every lease by the UTC offset and silently move re-binds across hours.
  const ms = new Date(`${year}-${month}-${day}T${time}`).getTime()
  return Number.isNaN(ms) ? null : ms
}

// ---------------------------------------------------------------------------
// `netstat -I <if> -b` — cumulative error counters
// ---------------------------------------------------------------------------

export interface IfCounters {
  ifIerrs: number | null
  ifOerrs: number | null
  ifColl: number | null
  /**
   * Cumulative bytes in and out on this interface since boot — the same `<Link#N>`
   * row the error counters come from, two columns over.
   *
   * These are the only byte counters this host offers without a second always-on
   * sampler, and they are **cumulative, not a rate**: the rate is the difference
   * between consecutive cycles divided by the time between them, and computing it
   * is the reader's job, not this parser's. They reset on reboot and start from
   * zero on a new interface, so a negative difference is a counter reset and must
   * read as *unknown*, never as an idle line.
   */
  ifIbytes: number | null
  ifObytes: number | null
}

const NO_COUNTERS: IfCounters = {
  ifIerrs: null,
  ifOerrs: null,
  ifColl: null,
  ifIbytes: null,
  ifObytes: null,
}

/**
 * `netstat -I en0 -b` prints one row per address family — measured: five rows
 * for en0 — and **only the `<Link#N>` row carries numeric Ierrs/Oerrs/Coll.
 * The fe80/inet/inet6 rows print `-`.** So the row is selected by "Ierrs
 * parses as an integer", not by position.
 *
 * Columns are read as offsets from the *right*, because the Address column can
 * be missing: measured, `netstat -I utun0 -b` prints its Link row with ten
 * fields where en0's has eleven. Left-indexing that short row shifts every
 * column past the gap by one — it reads Obytes as Oerrs (measured: 80 instead
 * of 0) and runs off the end of the row looking for Coll.
 */
export function parseIfCounters(output: string): IfCounters {
  const lines = output.split('\n').filter((line) => line.trim().length > 0)
  const header = lines.find((line) => line.trimStart().startsWith('Name'))
  if (header === undefined) return NO_COUNTERS

  const headerFields = header.trim().split(/\s+/)
  const ierrsAt = offsetFromEnd(headerFields, 'Ierrs')
  const oerrsAt = offsetFromEnd(headerFields, 'Oerrs')
  const collAt = offsetFromEnd(headerFields, 'Coll')
  const ibytesAt = offsetFromEnd(headerFields, 'Ibytes')
  const obytesAt = offsetFromEnd(headerFields, 'Obytes')
  if (ierrsAt === null) return NO_COUNTERS

  for (const line of lines) {
    if (line === header) continue
    const fields = line.trim().split(/\s+/)
    const ifIerrs = integerAt(fields, ierrsAt)
    if (ifIerrs === null) continue
    return {
      ifIerrs,
      ifOerrs: integerAt(fields, oerrsAt),
      ifColl: integerAt(fields, collAt),
      // Located by header name like every other column, so a firmware or macOS
      // release that reorders the row cannot silently return Opkts as Obytes.
      ifIbytes: integerAt(fields, ibytesAt),
      ifObytes: integerAt(fields, obytesAt),
    }
  }

  return NO_COUNTERS
}

function offsetFromEnd(headerFields: string[], name: string): number | null {
  const index = headerFields.indexOf(name)
  return index === -1 ? null : headerFields.length - 1 - index
}

function integerAt(fields: string[], offsetFromRight: number | null): number | null {
  if (offsetFromRight === null) return null
  const raw = fields[fields.length - 1 - offsetFromRight]
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  return Number(raw)
}

// ---------------------------------------------------------------------------
// `networksetup -listnetworkserviceorder` — interface → path class
// ---------------------------------------------------------------------------

export interface NetworkService {
  hardwarePort: string
  device: string
}

const SERVICE_DEVICE_LINE = /^\(Hardware Port:\s*(.*?),\s*Device:\s*(.*?)\)\s*$/

/**
 * Services with no device (measured: Tailscale) are dropped — they can never
 * carry a named interface, so keeping them would only add rows that never
 * match. The leading `(N)` / `(N) *Name` lines are ignored; the asterisk marks
 * a disabled service, which is irrelevant here because the question is which
 * hardware the interface *is*, not whether macOS would choose it.
 */
export function parseServiceOrder(output: string): NetworkService[] {
  const services: NetworkService[] = []
  for (const line of output.split('\n')) {
    const match = SERVICE_DEVICE_LINE.exec(line.trim())
    const hardwarePort = match?.[1]
    const device = match?.[2]
    if (hardwarePort === undefined || device === undefined || device.length === 0) continue
    services.push({ hardwarePort, device })
  }
  return services
}

/**
 * Classifies by **hardware port name**, never by interface name: en10/en11
 * numbering shifts between boots, so a hardcoded `en11 → cellular` map would
 * eventually misclassify the cellular hotspot as something harmless.
 *
 * Anything unrecognised is `other`. A wrong `ethernet` is the exact lie this
 * module exists to prevent, so `ethernet` is only ever returned for a port name
 * that says so.
 */
export function classifyHardwarePort(hardwarePort: string): PathClass {
  const port = hardwarePort.toLowerCase()

  // Cellular first: the tell is the device, and these names would otherwise
  // fall through to `other`, which reads as "some LAN thing" rather than "not
  // the home line at all". macOS names these ports after the product, not the
  // category, so they have to be matched by family rather than by model: phone
  // tethering appears as `iPhone USB`, and Netgear's mobile hotspots as an
  // `MR`-prefixed model number. Matching the shape keeps a hardware swap from
  // silently reclassifying a metered cellular egress as the home line.
  if (/iphone|ipad|modem|broadband|cellular|hotspot|tether|wwan|mifi|\bmr\d{3,4}\b/.test(port)) return 'cellular'

  if (/wi-?fi|airport|wireless/.test(port)) return 'wifi'

  // `Thunderbolt Ethernet Slot 1` and `USB 10/100/1000 LAN` are Ethernet;
  // `Thunderbolt Bridge` deliberately is not — it is a host-to-host link, not
  // a path to the line.
  if (/ethernet|\blan\b/.test(port)) return 'ethernet'

  return 'other'
}

/**
 * Order in which a *contested* device name resolves. macOS keeps stale service
 * entries and reuses device names across re-plugs, so one interface can match
 * several services — measured shape: a leftover `Thunderbolt Ethernet Slot 1`
 * still bound to the `en11` that a hotspot now owns.
 *
 * `ethernet` sorts **last** deliberately. Taking the first match let that pair
 * resolve to `ethernet`, i.e. produced the one verdict this module exists to
 * make impossible. Everything else outranks it, so a duplicate can never claim
 * the home line; among the rest the most disqualifying answer wins, because
 * "this cycle went out over a hotspot" is the fact worth keeping.
 */
const CONTESTED_DEVICE_PRECEDENCE: readonly PathClass[] = ['cellular', 'wifi', 'other', 'ethernet']

/**
 * `null` means "could not be determined" and is only returned when the service
 * list itself is unusable (the `networksetup` call failed). An interface that
 * is simply absent from a good service list is `other` — that is a real answer.
 *
 * Every service matching the device is considered, not just the first: see
 * CONTESTED_DEVICE_PRECEDENCE.
 */
export function classifyPath({ iface, services }: { iface: string | null; services: NetworkService[] }): PathClass | null {
  if (iface === null || services.length === 0) return null

  const matched = services.filter((service) => service.device === iface)
  if (matched.length === 0) return 'other'

  const classes = new Set(matched.map((service) => classifyHardwarePort(service.hardwarePort)))
  return CONTESTED_DEVICE_PRECEDENCE.find((candidate) => classes.has(candidate)) ?? 'other'
}

// ---------------------------------------------------------------------------
// on_home_line
// ---------------------------------------------------------------------------

/**
 * The refuse-to-lie column, and the exact place the two directions of that rule
 * meet. Only *genuine absence of evidence* is `null`; evidence that rules the
 * home line out is `0`.
 *
 * - Path class we could not determine → `null`. Nothing is known.
 * - Path class we *could* determine and it is not Ethernet → `0`, gateway or no
 *   gateway. The home line is the Ethernet one; a named Wi-Fi or cellular path
 *   settles the question on its own.
 * - Ethernet with no expected gateway configured (LINEWATCH_TARGETS with no
 *   `gateway`-scoped entry) → `null`. There is nothing to compare against.
 * - Ethernet with **no gateway on the default route** → `null`, not `0`. A
 *   default route can legitimately carry no `gateway:` line — host-side PPPoE,
 *   a VPN owning the default — and scoring that 0 marked every single cycle on
 *   the real home line as "not the home line", which any read path filtering on
 *   `on_home_line` would then discard wholesale. Absence of evidence is not
 *   evidence of absence.
 * - Ethernet through a gateway that is not the expected one → `0`. That is
 *   evidence, and it says a different line.
 */
export function deriveOnHomeLine({
  pathClass,
  gatewayAddr,
  expectedGateway,
}: {
  pathClass: PathClass | null
  gatewayAddr: string | null
  expectedGateway: string | null
}): 0 | 1 | null {
  if (pathClass === null) return null
  if (pathClass !== 'ethernet') return 0
  if (expectedGateway === null) return null
  if (gatewayAddr === null) return null
  return gatewayAddr === expectedGateway ? 1 : 0
}

// ---------------------------------------------------------------------------
// The impure caller
// ---------------------------------------------------------------------------

export interface CaptureVantageOptions {
  /**
   * The address the home line's gateway is expected to answer on — the
   * collector's `gateway` target, so there is one source of truth rather than a
   * second hardcoded constant. `null` leaves on_home_line unknown.
   */
  expectedGateway: string | null
  /** Per-command wall clock. Probe cycles are 30s; these commands take ms. */
  timeoutMs?: number
  /** Structured logging hook (probe.ts passes its own `log`). */
  report?: (event: string, fields?: Record<string, unknown>) => void
}

/** Every field unknown. The shape a cycle reports when it looked and found no path. */
const NO_PATH: Vantage = {
  pathIf: null,
  pathClass: null,
  linkMedia: null,
  linkMbit: null,
  linkDuplex: null,
  gatewayAddr: null,
  ifIerrs: null,
  ifOerrs: null,
  ifColl: null,
  ifIbytes: null,
  ifObytes: null,
  onHomeLine: null,
  linkMaxMbit: null,
  dhcpBoundAt: null,
  linkWatchS: null,
}

/**
 * Never throws and never blocks a probe cycle: every command is timed out and
 * every failure degrades to `null` fields. Losing the vantage is acceptable;
 * losing the uptime record is not.
 *
 * **Always returns a vantage**, including when there is no default route at all
 * — the link-down case, which is the single most diagnostic state this host can
 * be in. It returns an all-null one there rather than nothing, because an
 * absent `probe_cycle` row does not mean "no path": it also means "no collector
 * looked", which is what every cycle before this module existed says. The row's
 * existence is the measurement; its nulls are the finding.
 *
 * `on_home_line` stays `null` in that case, never 0. A hard home-line outage
 * takes the default route with it, and calling that "not the home line" would
 * let a read path filter away the very outage the collector exists to record.
 */
export async function captureVantage(options: CaptureVantageOptions): Promise<Vantage> {
  const timeoutMs = options.timeoutMs ?? 2000
  const report = options.report ?? (() => {})
  const run = (args: string[]): Promise<string> => runCommand(args, timeoutMs, report)

  const route = parseDefaultRoute(await run(['route', '-n', 'get', 'default']))
  if (route.iface === null) {
    report('vantage.no_default_route', { gateway: route.gateway })
    // `gatewayAddr` is carried through on the off chance the output named one
    // without naming an interface; everything else is genuinely unknown.
    return { ...NO_PATH, gatewayAddr: route.gateway }
  }

  // `ifconfig -m` prints the supported-media list *and* the negotiated `media:`
  // line, so one call feeds both parsers. Measured at `real 0.00`, like
  // `ipconfig getsummary`, and the whole bundle runs concurrently with the ~4 s
  // ping phase — neither adds anything to the 30 s cycle.
  const [ifconfigOut, netstatOut, serviceOrderOut, dhcpOut] = await Promise.all([
    run(['ifconfig', '-m', route.iface]),
    run(['netstat', '-I', route.iface, '-b']),
    run(['networksetup', '-listnetworkserviceorder']),
    run(['ipconfig', 'getsummary', route.iface]),
  ])

  const link = parseLinkState(ifconfigOut)
  const counters = parseIfCounters(netstatOut)
  const pathClass = classifyPath({ iface: route.iface, services: parseServiceOrder(serviceOrderOut) })

  return {
    pathIf: route.iface,
    pathClass,
    linkMedia: link.linkMedia,
    linkMbit: link.linkMbit,
    linkDuplex: link.linkDuplex,
    gatewayAddr: route.gateway,
    ifIerrs: counters.ifIerrs,
    ifOerrs: counters.ifOerrs,
    ifColl: counters.ifColl,
    ifIbytes: counters.ifIbytes,
    ifObytes: counters.ifObytes,
    onHomeLine: deriveOnHomeLine({ pathClass, gatewayAddr: route.gateway, expectedGateway: options.expectedGateway }),
    linkMaxMbit: parseSupportedMedia(ifconfigOut),
    dhcpBoundAt: parseDhcpLeaseStart(dhcpOut),
    // No link sampler in this collector yet. Null, not 0: 0 would claim a cycle
    // that watched the link for zero seconds, which is a measurement; this is
    // the absence of one.
    linkWatchS: null,
  }
}

/**
 * Returns stdout, or '' on any failure. Exit codes are ignored on purpose (the
 * same reason ping's is): a command that printed something usable before
 * failing is still a measurement, and one that failed silently is handled by
 * the parsers returning nulls.
 */
async function runCommand(
  args: string[],
  timeoutMs: number,
  report: (event: string, fields?: Record<string, unknown>) => void,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' })
    // `stderr: 'ignore'` rather than 'pipe': an unread pipe can wedge a chatty
    // command, and nothing here needs its stderr.
    timer = setTimeout(() => {
      report('vantage.command_timeout', { command: args[0], timeoutMs })
      proc.kill()
    }, timeoutMs)
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return stdout
  } catch (err) {
    report('vantage.command_error', { command: args[0], error: err instanceof Error ? err.message : String(err) })
    return ''
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

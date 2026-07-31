/**
 * Samples the Wi-Fi radio, so **an alternate radio path currently attached** is
 * measured rather than inferred.
 *
 * That phrasing is load-bearing and the shorter ones are wrong. This is not
 * "the standby path" and not "the failover path": `networksetup
 * -listnetworkserviceorder` on this host ranks (1) Ethernet en0, (2) a
 * **mobile hotspot**, (3) Wi-Fi en1, (4) Thunderbolt Bridge, (5) phone USB
 * tethering. Neither cellular device is attached today (`ifconfig -l` lists no
 * en10/en11), which is the only reason Wi-Fi is what a failover would reach
 * right now — the *configured* next hop above it is metered cellular.
 *
 * **Cadence: every 10th probe cycle (5 min), never per cycle.** `system_profiler
 * SPAirPortDataType` costs 4.8 s median on this host (six runs:
 * 4.63/4.72/4.78/4.89/4.91/4.95), 2.4× the 2 s per-command budget vantage.ts
 * works to. `-detailLevel mini` saves nothing (measured 4.63–4.95 s) and drops
 * Signal/Noise, Transmit Rate, MCS Index and Channel entirely, so it is not an
 * option.
 *
 * **This repo is public, and the raw output is full of identifiers.** It prints
 * en1's and awdl0's MAC addresses in the clear, and enumerates every neighbour
 * network with channel, PHY mode and security. `parseAirportInfo` therefore
 * reads only the connected interface's `Current Network Information` block,
 * stops dead at `Other Local Wi-Fi Networks`, and extracts only a fixed
 * whitelist of keys — so the network-name line, `MAC Address`, `Security` and
 * `Country Code` have no path into a field even if the output shape moves. The
 * network name currently prints as `<redacted>` because Location Services is
 * off; that is a side effect which can reverse, so it is never relied on.
 *
 * Dependency-free like the rest of collector/ (see probe.ts's header): no npm
 * imports, no src/config.ts, nothing that pulls in elysia/drizzle/zod.
 * `./ping-parser.ts` and `../src/lib/stats.ts` are pure, import-nothing modules
 * and are reused rather than reimplemented.
 *
 * Nothing here may be presented as throughput. `txRateMbps` is the negotiated
 * PHY/MCS rate, and the one end-to-end number in this module — RTT from a ping
 * bound to the interface — measured 9.99 ms on Wi-Fi against 5.24 ms on
 * Ethernet. There is no measurement here supporting a "faster" claim.
 */
import { median } from '../src/lib/stats.js'
import { parsePingOutput } from './ping-parser.js'

/** The wifi_sample contract (src/db/schema.ts `wifiSample`), minus id/ts. */
export interface WifiSampleInput {
  /** The interface the sample was taken *through* — what the ping was bound to. */
  iface: string | null
  /** As printed: `Connected`, `Not Connected`, … Verbatim, never mapped to a boolean. */
  status: string | null
  phyMode: string | null
  channel: number | null
  /** `2GHz` | `5GHz` | `6GHz`, as printed. */
  band: string | null
  widthMhz: number | null
  rssiDbm: number | null
  noiseDbm: number | null
  /** The negotiated PHY/MCS rate. Not throughput — see the module header. */
  txRateMbps: number | null
  mcsIndex: number | null
  /** Median RTT of a ping bound to `iface`; null when no reply was timed. */
  rttMedMs: number | null
  lossPct: number | null
}

/** The fields `parseAirportInfo` can fill — everything except the ping's two. */
type Radio = Omit<WifiSampleInput, 'rttMedMs' | 'lossPct'>

/** Every radio field unknown: the shape a sample takes when the parser recognised nothing. */
const NO_RADIO: Radio = {
  iface: null,
  status: null,
  phyMode: null,
  channel: null,
  band: null,
  widthMhz: null,
  rssiDbm: null,
  noiseDbm: null,
  txRateMbps: null,
  mcsIndex: null,
}

// ---------------------------------------------------------------------------
// `system_profiler SPAirPortDataType`
// ---------------------------------------------------------------------------

/** Splits a line into its indentation depth and its trimmed text. Blank lines do not match. */
const INDENTED_LINE = /^( *)(\S.*?)\s*$/
/**
 * An interface header — `en1:`, `awdl0:`. Anchored and shaped like an interface
 * name so a *network* name that happens to end in a colon cannot be read as
 * one; the indentation guard in the scanner is the second half of that defence.
 */
const INTERFACE_HEADER = /^([a-z]+\d+):$/
/** `Key: value` on one line. Split at the first colon — `Signal / Noise` has none before it. */
const KEY_VALUE = /^([^:]+):\s*(.+)$/

const CURRENT_NETWORK_HEADER = 'Current Network Information:'
/**
 * The line the parser stops at. Everything below it is neighbour networks —
 * other people's network names, channels and security — and none of it is this
 * host's measurement.
 */
const OTHER_NETWORKS_HEADER = 'Other Local Wi-Fi Networks:'

const CHANNEL_NUMBER = /^(\d+)\b/
/** The parenthesised clause of `Channel: 3 (2GHz, 20MHz)`. Band and width come as a pair or not at all. */
const CHANNEL_BAND_WIDTH = /\((\d+(?:\.\d+)?GHz)\s*,\s*(\d+)\s*MHz\)/i
/** `Signal / Noise: -45 dBm / -83 dBm`. Whole value only; a shape this misses is two nulls. */
const SIGNAL_NOISE = /^(-?\d+)\s*dBm\s*\/\s*(-?\d+)\s*dBm$/
const BARE_NUMBER = /^\d+(?:\.\d+)?$/
const BARE_INTEGER = /^\d+$/

/** Which part of an interface block the scanner is standing in. */
type Region = 'interface' | 'current-network' | 'other-networks'

interface InterfaceBlock {
  iface: string
  status: string | null
  radio: Radio
}

/**
 * The connected interface's radio state, and nothing else.
 *
 * Every field is `null` when absent or unparseable — including the whole result
 * when the output shape has moved out from under this parser, which has already
 * happened once on this OS (`airport` removed, `wdutil` now sudo-only). A
 * plausible default here would read as measured; that is the bug this module is
 * written to be incapable of.
 *
 * Two rules make the identity guarantee structural rather than a promise:
 * scanning stops at `Other Local Wi-Fi Networks` (below it is every neighbour
 * network), and only a fixed whitelist of keys is read, so `MAC Address`,
 * `Security`, `Country Code` and the network-name line cannot reach a field
 * however the surrounding output changes.
 */
export function parseAirportInfo(output: string): Partial<WifiSampleInput> {
  const blocks: InterfaceBlock[] = []
  let current: InterfaceBlock | null = null
  let ifaceIndent = 0
  let region: Region = 'interface'
  let regionIndent = 0

  for (const raw of output.split('\n')) {
    const parsed = INDENTED_LINE.exec(raw)
    const indent = parsed?.[1]?.length
    const text = parsed?.[2]
    if (indent === undefined || text === undefined) continue

    const iface = INTERFACE_HEADER.exec(text)?.[1]
    // The indentation guard only lets a header at or above the depth of the
    // first one start a new block, so a network named like an interface cannot
    // open one from inside a network list.
    if (iface !== undefined && (current === null || indent <= ifaceIndent)) {
      current = { iface, status: null, radio: { ...NO_RADIO } }
      blocks.push(current)
      ifaceIndent = indent
      region = 'interface'
      continue
    }

    // Lines before the first interface (`Software Versions:`) belong to nobody.
    if (current === null) continue

    // A dedent back to interface level closes whichever sub-block was open.
    if (region !== 'interface' && indent <= regionIndent) region = 'interface'

    if (text === OTHER_NETWORKS_HEADER) {
      region = 'other-networks'
      regionIndent = indent
      continue
    }
    if (text === CURRENT_NETWORK_HEADER) {
      region = 'current-network'
      regionIndent = indent
      continue
    }
    // Nothing under the neighbour list is ever read, at any depth.
    if (region === 'other-networks') continue

    const keyValue = KEY_VALUE.exec(text)
    const key = keyValue?.[1]?.trim()
    const value = keyValue?.[2]
    if (key === undefined || value === undefined) continue

    if (region === 'interface') {
      if (key === 'Status') current.status = value
      continue
    }
    readNetworkField(current.radio, key, value)
  }

  // The connected interface, or — failing that — any interface that reported a
  // status at all, so `Not Connected` is recorded as the finding it is. awdl0
  // prints a `Current Network Information` block of its own and no `Status`
  // line, so it can never be chosen and its fields can never be returned.
  const chosen = blocks.find((block) => block.status === 'Connected') ?? blocks.find((block) => block.status !== null)
  if (chosen === undefined) return { ...NO_RADIO }
  return { ...chosen.radio, iface: chosen.iface, status: chosen.status }
}

/**
 * The whitelist. Anything not named here is dropped — `Security`, `Country
 * Code`, `Network Type` and the network-name line included, deliberately and
 * permanently (src/db/schema.ts `wifiSample`).
 */
function readNetworkField(radio: Radio, key: string, value: string): void {
  switch (key) {
    case 'PHY Mode':
      radio.phyMode = value
      return
    case 'Channel': {
      radio.channel = integerOrNull(CHANNEL_NUMBER.exec(value)?.[1])
      const bandWidth = CHANNEL_BAND_WIDTH.exec(value)
      radio.band = bandWidth?.[1] ?? null
      radio.widthMhz = integerOrNull(bandWidth?.[2])
      return
    }
    case 'Signal / Noise': {
      const signalNoise = SIGNAL_NOISE.exec(value)
      radio.rssiDbm = integerOrNull(signalNoise?.[1])
      radio.noiseDbm = integerOrNull(signalNoise?.[2])
      return
    }
    case 'Transmit Rate':
      radio.txRateMbps = numberOrNull(value)
      return
    case 'MCS Index':
      radio.mcsIndex = integerOrNull(value)
      return
    default:
      return
  }
}

function numberOrNull(raw: string | undefined): number | null {
  if (raw === undefined || !BARE_NUMBER.test(raw)) return null
  return Number(raw)
}

function integerOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const negative = raw.startsWith('-')
  const digits = negative ? raw.slice(1) : raw
  if (!BARE_INTEGER.test(digits)) return null
  return negative ? -Number(digits) : Number(digits)
}

// ---------------------------------------------------------------------------
// The impure caller
// ---------------------------------------------------------------------------

export interface CaptureWifiOptions {
  /** The Wi-Fi interface: the radio block must name it, and the ping is bound to it. */
  iface: string
  /** Address the interface-bound ping goes to — the collector passes a WAN anchor. */
  pingTarget: string
  /** Wall clock per command. Generous: `system_profiler` alone costs ~4.8 s. */
  timeoutMs?: number
  /** Structured logging hook (probe.ts passes its own `log`). */
  report?: (event: string, fields?: Record<string, unknown>) => void
}

const DEFAULT_TIMEOUT_MS = 8000

/**
 * One radio sample plus one interface-bound reachability measurement, or `null`
 * when neither command produced anything at all.
 *
 * Never throws. Every failure path degrades to nulls: losing a Wi-Fi sample is
 * acceptable, losing the probe cycle it rides on is not. `null` is reserved for
 * "no evidence of any kind" — `system_profiler` printed nothing *and* `ping`
 * printed no summary — because a row of nulls should mean "we looked at the
 * radio and learned nothing", not "both commands failed to run".
 *
 * `iface` in the result is always the interface asked for, since that is what
 * the ping was bound to. The radio fields are kept only when the parsed block
 * names that same interface; otherwise they are dropped, because attributing
 * another interface's radio to this one's round trips would fabricate a sample
 * that describes no single thing.
 */
export async function captureWifi(options: CaptureWifiOptions): Promise<WifiSampleInput | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const report = options.report ?? (() => {})

  // Concurrent: the ~4.8 s `system_profiler` is the whole cost, and the ping
  // must not be serialised behind it.
  const [airportOut, pingOut] = await Promise.all([
    runCommand(['system_profiler', 'SPAirPortDataType'], timeoutMs, report),
    // `-b <iface>` binds the probe to the radio; `-c 5 -i 0.2` is one second of
    // sampling, a twentieth of what a probe target gets — this is a spot check
    // on an alternate path, not a second uptime record.
    runCommand(['ping', '-c', '5', '-i', '0.2', '-b', options.iface, options.pingTarget], timeoutMs, report),
  ])

  const reach = measureReachability(pingOut)
  if (airportOut.length === 0 && reach === null) {
    report('wifi.no_measurement', { iface: options.iface })
    return null
  }

  const parsed = parseAirportInfo(airportOut)
  const describesRequestedIface = parsed.iface === options.iface
  if (parsed.iface !== null && parsed.iface !== undefined && !describesRequestedIface) {
    report('wifi.iface_mismatch', { requested: options.iface, found: parsed.iface })
  }

  // Field by field rather than by spread: `parseAirportInfo` returns a partial,
  // and an absent key means the same thing here as a null one — not measured.
  const radio = describesRequestedIface ? parsed : NO_RADIO
  return {
    iface: options.iface,
    status: radio.status ?? null,
    phyMode: radio.phyMode ?? null,
    channel: radio.channel ?? null,
    band: radio.band ?? null,
    widthMhz: radio.widthMhz ?? null,
    rssiDbm: radio.rssiDbm ?? null,
    noiseDbm: radio.noiseDbm ?? null,
    txRateMbps: radio.txRateMbps ?? null,
    mcsIndex: radio.mcsIndex ?? null,
    rttMedMs: reach?.rttMedMs ?? null,
    lossPct: reach?.lossPct ?? null,
  }
}

/**
 * Median RTT and loss from the interface-bound ping, or `null` when the output
 * carried no summary line at all (a failed or killed spawn).
 *
 * **The exit code is never consulted**, the same rule the probe cycle follows:
 * 100 % loss exits non-zero and prints no round-trip line, and that is a valid
 * measurement — `rttMedMs: null, lossPct: 100` — not an error.
 */
function measureReachability(output: string): { rttMedMs: number | null; lossPct: number | null } | null {
  try {
    const parsed = parsePingOutput(output)
    return { rttMedMs: parsed.rtts.length > 0 ? median(parsed.rtts) : null, lossPct: parsed.lossPct }
  } catch {
    return null
  }
}

/**
 * Returns stdout, or '' on any failure. A near-copy of vantage.ts's helper of
 * the same name rather than a shared one, for the reason link-sampler.ts keeps
 * its own: the collector's modules stay independently readable, and the events
 * they report are named for the module that reports them.
 *
 * The raw stdout never leaves this module — it holds MAC addresses and every
 * neighbour network name, so it is not logged, spooled or stored anywhere.
 */
async function runCommand(
  args: string[],
  timeoutMs: number,
  report: (event: string, fields?: Record<string, unknown>) => void,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // `stderr: 'ignore'` rather than 'pipe', same as vantage.ts: an unread pipe
    // can wedge a chatty command and nothing here reads it.
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' })
    timer = setTimeout(() => {
      report('wifi.command_timeout', { command: args[0], timeoutMs })
      proc.kill()
    }, timeoutMs)
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return stdout
  } catch (err) {
    report('wifi.command_error', { command: args[0], error: err instanceof Error ? err.message : String(err) })
    return ''
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

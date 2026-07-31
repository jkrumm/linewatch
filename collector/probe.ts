#!/usr/bin/env bun
/**
 * The native launchd collector (docs/DESIGN.md "Shape"). Runs on the Mac
 * mini's host macOS — Colima's NAT fabricates ICMP replies inside a
 * container, so this half of the system cannot live in Docker.
 *
 * Deliberately dependency-free beyond Bun + the system `ping`: no `bun
 * install` needed to run it, and it changes rarely. It does NOT import
 * src/config.ts or anything that pulls in elysia/drizzle/croner/zod — those
 * are the API server's business. `./ping-parser.ts`, `./vantage.ts` and
 * `../src/lib/stats.ts` are safe imports here because all three are pure,
 * import-nothing modules; if any of them ever grows a real dependency, that
 * dependency would leak into the collector too, so keep them that way.
 *
 * Every cycle: ping every target in parallel, capture the vantage point
 * alongside them (what the cycle measured *through* — see vantage.ts), POST the
 * batch to the API, spool to disk on failure and replay the spool on the next
 * success. Never gate on ping's exit code — 100% loss is a valid measurement
 * (exit 2 on macOS), not a fault.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { median, stddev } from '../src/lib/stats.js'
import { createLinkSampler, type LinkSampler, type LinkTransition } from './link-sampler.js'
import { DEFAULT_LOG_MAX_BYTES, inspectRotation, rotateLogIfNeeded } from './log-rotate.js'
import { parsePingOutput, type PingResult } from './ping-parser.js'
import { captureVantage, type Vantage } from './vantage.js'
import { captureWifi, type WifiSampleInput } from './wifi.js'

type TargetScope = 'gateway' | 'wan'

interface Target {
  name: string
  addr: string
  /**
   * Which side of the line the target sits on. Load-bearing, not decorative:
   * this is how the home gateway is identified, and dropping it is what made
   * the collector and the server disagree about which address that is (see
   * `resolveExpectedGateway`).
   */
  scope: TargetScope
}

// Mirrors src/config.ts's DEFAULT_TARGETS (docs/DESIGN.md "Targets") —
// duplicated rather than imported so this file stays free of any transitive
// dependency on the API server's config module (see file header).
const DEFAULT_TARGETS: Target[] = [
  { name: 'gateway', addr: '192.168.1.1', scope: 'gateway' },
  { name: 'cloudflare', addr: '1.1.1.1', scope: 'wan' },
  { name: 'google', addr: '8.8.8.8', scope: 'wan' },
  { name: 'quad9', addr: '9.9.9.9', scope: 'wan' },
]

/**
 * Mirrors src/config.ts's `parseTargets` field for field, including the
 * required `scope` — same reason DEFAULT_TARGETS is mirrored rather than
 * imported (file header). The two must accept exactly the same string: they
 * read the same LINEWATCH_TARGETS out of the same environment, and a format the
 * server rejects at boot must not be one the collector quietly accepts.
 */
function parseTargets(raw: string | undefined): Target[] {
  if (!raw) return DEFAULT_TARGETS
  // Comma-separated "name:addr:scope" entries, e.g. "gw:10.0.0.1:gateway,cf:1.1.1.1:wan".
  return raw.split(',').map((entry) => {
    const [name, addr, scope] = entry.trim().split(':')
    if (!name || !addr || (scope !== 'gateway' && scope !== 'wan')) {
      throw new Error(`invalid LINEWATCH_TARGETS entry "${entry}" (want "name:addr:gateway|wan")`)
    }
    return { name, addr, scope }
  })
}

const TOKEN_FILE_PATH = join(homedir(), '.config', 'linewatch', 'token')

function resolveToken(): string {
  const envToken = process.env['LINEWATCH_TOKEN']
  if (envToken) return envToken
  if (existsSync(TOKEN_FILE_PATH)) {
    const fileToken = readFileSync(TOKEN_FILE_PATH, 'utf-8').trim()
    if (fileToken) return fileToken
  }
  throw new Error(`No bearer token: set LINEWATCH_TOKEN or write one to ${TOKEN_FILE_PATH} (chmod 600).`)
}

const moduleDir = dirname(fileURLToPath(import.meta.url))

const config = {
  apiUrl: process.env['LINEWATCH_API_URL'] ?? 'http://localhost:7731',
  token: resolveToken(),
  targets: parseTargets(process.env['LINEWATCH_TARGETS']),
  probeCycleSeconds: Number(process.env['LINEWATCH_PROBE_CYCLE_S'] ?? 30),
  pingCount: Number(process.env['LINEWATCH_PING_COUNT'] ?? 20),
  pingIntervalSeconds: Number(process.env['LINEWATCH_PING_INTERVAL_S'] ?? 0.2),
  spoolPath: process.env['LINEWATCH_SPOOL_PATH'] ?? join(moduleDir, 'spool.jsonl'),
  spoolMaxLines: 50_000,
  /**
   * Which interface the link sampler watches until the default route names one.
   * Only a fallback: `pathIf` from the routing table wins the moment a cycle
   * reports it (see `retargetLinkSampler`). It matters precisely when there is
   * no default route — the link-down case — because that is when the physical
   * link state is the whole question.
   */
  linkIface: process.env['LINEWATCH_LINK_IFACE'] ?? 'en0',
  linkSampleIntervalMs: Number(process.env['LINEWATCH_LINK_SAMPLE_MS'] ?? 1000),
  /** The Wi-Fi interface sampled by collector/wifi.ts — an alternate radio path currently attached. */
  wifiIface: process.env['LINEWATCH_WIFI_IFACE'] ?? 'en1',
  /**
   * Cadence of that sample, in cycles. 10 × 30 s = 5 min, and it is not
   * negotiable downward without measuring again: `system_profiler
   * SPAirPortDataType` costs 4.8 s median on this host, so sampling every cycle
   * would put a 5 s command inside a 30 s loop for a value that moves slowly.
   */
  wifiSampleEveryNCycles: Math.max(1, Number(process.env['LINEWATCH_WIFI_EVERY_N_CYCLES'] ?? 10)),
  /** Per-command wall clock for the Wi-Fi sample. ~4.8 s of it is `system_profiler` alone. */
  wifiTimeoutMs: 8000,
  /**
   * The file launchd captures this process's stdout *and* stderr into — the
   * plist's `StandardOutPath`. Passed in through the environment by that same
   * plist so the two are written next to each other and cannot drift apart
   * unnoticed; the default here matches it for a hand-started run.
   *
   * Rotation refuses to touch this path unless fd 1 really is that file
   * (collector/log-rotate.ts), so a wrong value costs the bound, never the log.
   */
  logPath: process.env['LINEWATCH_LOG_PATH'] ?? join(homedir(), 'Library', 'Logs', 'linewatch-collector.log'),
  logMaxBytes: Number(process.env['LINEWATCH_LOG_MAX_BYTES'] ?? DEFAULT_LOG_MAX_BYTES),
}

/**
 * Where the interface-bound Wi-Fi ping goes. Env override first, then the first
 * `wan`-scoped target — same shape as `resolveExpectedGateway`, so the Wi-Fi
 * spot check and the cycle's own probes measure toward the same place instead
 * of a second hardcoded address.
 *
 * `null` (no WAN target configured) disables the Wi-Fi sample entirely rather
 * than falling back to some plausible anchor: a round trip to an address nobody
 * chose is not a measurement of this line's alternate path.
 */
function resolveWifiPingTarget(targets: Target[]): string | null {
  const explicit = process.env['LINEWATCH_WIFI_PING_TARGET']
  if (explicit) return explicit
  return targets.find((target) => target.scope === 'wan')?.addr ?? null
}

const wifiPingTarget = resolveWifiPingTarget(config.targets)

/**
 * The gateway a cycle must be talking to for it to count as the home line.
 *
 * Resolved exactly the way src/config.ts's `resolveHomeGateway` does — env
 * override first, then the **`gateway`-scoped** target — because the two
 * verdicts are meant to cross-check each other and a cross-check between two
 * different definitions checks nothing. Matching on the target *name* instead
 * was silently wrong: src/config.ts's own documented override
 * ("gw:10.0.0.1:gateway,cf:1.1.1.1:wan") names it `gw`, so the collector found
 * no `gateway` target, reported `on_home_line: null` on every cycle forever, and
 * quietly withdrew its half of the check while the server resolved 10.0.0.1
 * without complaint.
 *
 * Diverges from the server in one way only: the server throws when it cannot
 * name a home gateway, this returns null. A misconfiguration must cost the
 * verdict, never the uptime record (see vantage.ts `deriveOnHomeLine`).
 */
function resolveExpectedGateway(targets: Target[]): string | null {
  const explicit = process.env['LINEWATCH_HOME_GATEWAY']
  if (explicit) return explicit
  return targets.find((target) => target.scope === 'gateway')?.addr ?? null
}

const expectedGateway = resolveExpectedGateway(config.targets)

interface TargetSample {
  target: string
  addr: string
  sent: number
  received: number
  lossPct: number
  minMs: number | null
  medMs: number | null
  maxMs: number | null
  avgMs: number | null
  jitterMs: number | null
  samples: number[] | null
  /** `+N duplicates,` in ping's summary. Normal on a LAN; makes `samples` longer than `received`. */
  duplicates: number
  /**
   * Replies that arrived after `-W` — counted in `received` but never timed, so they print no
   * `time=` line. Non-zero means min/med/max/jitter for this cycle are a floor computed from the
   * fast replies only, and the censored ones are precisely the slow ones. Carried to the API so a
   * cycle that looks fast because its slow replies were dropped is distinguishable from a genuinely
   * fast one, instead of the distinction dying at this boundary.
   */
  outOfWaitTime: number
}

interface Batch {
  ts: number
  samples: TargetSample[]
  /**
   * What this cycle measured *through* (probe_cycle). Optional in the wire
   * shape on purpose: the collector and the API deploy independently, so an
   * older API that knows nothing about it must still accept the batch, and a
   * cycle whose vantage capture failed must still deliver its measurements.
   *
   * In practice it is now present on every cycle this collector emits — a host
   * with no default route sends an all-null `cycle` rather than omitting the
   * key, so "link down" is a row on record instead of a silence that reads
   * identically to a collector too old to look. Absent means one thing only:
   * `captureVantage` threw, which it is written not to do.
   */
  cycle?: Vantage
  /**
   * Sub-cycle link transitions seen by the 1 Hz sampler during this cycle
   * (collector/link-sampler.ts). Omitted when there were none — an empty array
   * and an absent key would mean the same thing on the wire, and the absent one
   * is cheaper. "No transitions" is *not* "the link was stable": `cycle
   * .linkWatchS` is what says how much of the cycle was actually watched.
   *
   * Rides the existing batch on purpose, so it inherits the spool and the
   * bearer token — no second route, no second auth surface.
   */
  linkEvents?: LinkTransition[]
  /**
   * The Wi-Fi radio sample (collector/wifi.ts). Present on every 10th cycle
   * only — 5 min, because `system_profiler` costs ~4.8 s — so an absent key is
   * the normal case here and means "this cycle did not look at the radio",
   * never "there is no radio". Rides the batch for the same reason
   * `linkEvents` does: it inherits the spool and the bearer token.
   */
  wifi?: WifiSampleInput
}

/**
 * The link sampler, re-created rather than reconfigured when the default route
 * moves to another interface. Module-level because the cycle loop and the
 * signal handlers both have to reach it.
 */
let linkSampler: LinkSampler | null = null
let linkIface = config.linkIface

function startLinkSampler(iface: string): void {
  linkSampler?.stop()
  linkIface = iface
  linkSampler = createLinkSampler({
    iface,
    intervalMs: config.linkSampleIntervalMs,
    // So a cycle that overruns cannot report more seconds of link coverage
    // than the cycle it is attached to has.
    maxWatchS: config.probeCycleSeconds,
  })
  linkSampler.start()
}

/**
 * Follow the default route. `pathIf` is authoritative for what the cycle
 * measured through (vantage.ts rule 2), so the sampler watches whatever it
 * names.
 *
 * A null `pathIf` — no default route, i.e. the link-down case — deliberately
 * changes nothing: the configured interface stays under observation, which is
 * exactly where the answer is when there is no route to read.
 */
function retargetLinkSampler(pathIf: string | null | undefined): void {
  if (pathIf === null || pathIf === undefined || pathIf === linkIface) return
  log('link.retarget', { from: linkIface, to: pathIf })
  startLinkSampler(pathIf)
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
}

async function pingTarget(target: Target): Promise<TargetSample> {
  const args = ['ping', '-c', String(config.pingCount), '-i', String(config.pingIntervalSeconds), '-W', '1000', target.addr]
  let stdout = ''
  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
    const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    stdout = out
  } catch (err) {
    log('ping.spawn_error', { target: target.name, error: err instanceof Error ? err.message : String(err) })
  }

  let parsed: PingResult
  try {
    parsed = parsePingOutput(stdout)
  } catch {
    // No usable output at all (binary missing, DNS failure, etc.) — record
    // it as a full-loss cycle rather than silently dropping the target.
    parsed = { sent: config.pingCount, received: 0, lossPct: 100, rtts: [], duplicates: 0, outOfWaitTime: 0 }
  }

  const rtts = parsed.rtts
  const hasData = rtts.length > 0

  return {
    target: target.name,
    addr: target.addr,
    sent: parsed.sent,
    received: parsed.received,
    lossPct: parsed.lossPct,
    minMs: hasData ? Math.min(...rtts) : null,
    medMs: hasData ? median(rtts) : null,
    maxMs: hasData ? Math.max(...rtts) : null,
    avgMs: hasData ? rtts.reduce((sum, v) => sum + v, 0) / rtts.length : null,
    jitterMs: hasData ? stddev(rtts) : null,
    samples: hasData ? rtts : null,
    duplicates: parsed.duplicates,
    outOfWaitTime: parsed.outOfWaitTime,
  }
}

/** Cycles run since start, the counter the Wi-Fi cadence is measured against. */
let cycleCount = 0

async function runCycle(): Promise<Batch> {
  const ts = Date.now()
  // The first cycle samples (0 % N === 0), so a freshly started collector puts
  // a wifi_sample row on record within one cycle rather than five minutes.
  const sampleWifi = wifiPingTarget !== null && cycleCount % config.wifiSampleEveryNCycles === 0
  cycleCount += 1

  // Captured concurrently with the pings so it describes the path the pings
  // actually went out over, and so it adds nothing to the cycle's wall clock.
  // `captureVantage` is written not to throw; the catch is the second belt —
  // the vantage must never be able to cost us the uptime record.
  const [samples, vantage, wifi] = await Promise.all([
    Promise.all(config.targets.map((target) => pingTarget(target))),
    captureVantage({ expectedGateway, report: log }).catch((err: unknown) => {
      log('vantage.error', { error: err instanceof Error ? err.message : String(err) })
      return null
    }),
    // Same belt-and-braces as the vantage, and the same reason: `captureWifi`
    // is written not to throw, and a radio sample must never be able to cost
    // the cycle its measurements. Its own timeout keeps a wedged
    // `system_profiler` from stretching the cycle past its 30 s budget.
    sampleWifi && wifiPingTarget !== null
      ? captureWifi({ iface: config.wifiIface, pingTarget: wifiPingTarget, timeoutMs: config.wifiTimeoutMs, report: log }).catch(
          (err: unknown) => {
            log('wifi.error', { error: err instanceof Error ? err.message : String(err) })
            return null
          },
        )
      : Promise.resolve(null),
  ])

  // Logged here rather than folded into the cycle line: it happens on one cycle
  // in ten. Safe to log in full — `WifiSampleInput` carries no SSID, BSSID or
  // MAC by construction (collector/wifi.ts), which is why those columns do not
  // exist.
  if (wifi !== null) log('wifi', { ...wifi })

  // Drained after the pings and *before* the retarget below, so the seconds it
  // reports belong to the interface that actually carried this cycle rather
  // than to whichever one the next cycle will watch. `linkWatchS` stays null
  // when there is no sampler at all: null is "link state unknown for this
  // cycle", where 0 would claim a cycle that watched and saw nothing.
  const link = linkSampler?.drain() ?? null
  if (vantage !== null && link !== null) vantage.linkWatchS = link.watchedS
  retargetLinkSampler(vantage?.pathIf)

  return {
    ts,
    samples,
    ...(vantage === null ? {} : { cycle: vantage }),
    ...(link === null || link.transitions.length === 0 ? {} : { linkEvents: link.transitions }),
    ...(wifi === null ? {} : { wifi }),
  }
}

/**
 * Compact vantage summary for the per-cycle log line. The three states the log
 * has to keep apart: `path: null` = the capture threw (no vantage at all),
 * `none/unknown/unknown` = it ran and found no default route, and everything
 * else = a real path.
 */
function vantageFields(batch: Batch): Record<string, unknown> {
  const cycle = batch.cycle
  // The link sampler is independent of the vantage capture — it can have
  // watched the whole cycle even when `captureVantage` returned nothing — so
  // its transition count is logged either way.
  const transitions = { linkTransitions: batch.linkEvents?.length ?? 0 }
  if (cycle === undefined) return { path: null, onHomeLine: null, linkWatchS: null, ...transitions }
  return {
    path: `${cycle.pathIf ?? 'none'}/${cycle.pathClass ?? 'unknown'}/${cycle.linkMedia ?? 'unknown'}`,
    onHomeLine: cycle.onHomeLine,
    linkWatchS: cycle.linkWatchS,
    ...transitions,
  }
}

/**
 * What the server said about a batch it accepted. Both fields are `undefined`
 * against an API too old to report them — which is exactly the situation they
 * exist to detect, so "did not say" must stay distinguishable from "said false"
 * and never be coalesced.
 */
interface PostOutcome {
  ok: boolean
  skipped?: boolean | undefined
  cycleStored?: boolean | undefined
}

async function postBatch(batch: Batch): Promise<PostOutcome> {
  try {
    const response = await fetch(`${config.apiUrl}/api/probes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return { ok: false }
    // A body that will not parse does not undo an accepted batch: the samples
    // are stored either way, and re-sending them would duplicate work the
    // server already did. The outcome is simply unknown.
    const body = (await response.json().catch(() => ({}))) as { skipped?: unknown; cycleStored?: unknown }
    return {
      ok: true,
      skipped: typeof body.skipped === 'boolean' ? body.skipped : undefined,
      cycleStored: typeof body.cycleStored === 'boolean' ? body.cycleStored : undefined,
    }
  } catch {
    return { ok: false }
  }
}

// Tracked in-process rather than re-counted from disk on every cycle (cheap
// to maintain, avoids re-reading a potentially large file every 30s while the
// spool has content) — initialized once at startup from the file on disk.
let spoolLineCount = countExistingSpoolLines()

function countExistingSpoolLines(): number {
  if (!existsSync(config.spoolPath)) return 0
  const content = readFileSync(config.spoolPath, 'utf-8')
  return content.length === 0 ? 0 : content.split('\n').filter((line) => line.length > 0).length
}

function appendToSpool(batch: Batch): void {
  if (spoolLineCount >= config.spoolMaxLines) {
    log('spool.full', { path: config.spoolPath, maxLines: config.spoolMaxLines })
    return
  }
  mkdirSync(dirname(config.spoolPath), { recursive: true })
  appendFileSync(config.spoolPath, `${JSON.stringify(batch)}\n`)
  spoolLineCount += 1
}

function readSpool(): Batch[] {
  if (!existsSync(config.spoolPath)) return []
  const content = readFileSync(config.spoolPath, 'utf-8')
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Batch)
}

function truncateSpool(): void {
  if (existsSync(config.spoolPath)) {
    writeFileSync(config.spoolPath, '')
  }
  spoolLineCount = 0
}

/**
 * Replay every spooled batch in order. On the first failure, rewrite the
 * spool to hold only the not-yet-replayed remainder (never drop what
 * couldn't be sent) and report failure so the caller spools the current
 * cycle too.
 */
async function replaySpool(batches: Batch[]): Promise<boolean> {
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    if (!batch) continue
    const { ok } = await postBatch(batch)
    if (!ok) {
      const remaining = batches.slice(i)
      const tmpPath = `${config.spoolPath}.tmp`
      writeFileSync(tmpPath, remaining.map((b) => JSON.stringify(b)).join('\n') + (remaining.length > 0 ? '\n' : ''))
      renameSync(tmpPath, config.spoolPath)
      spoolLineCount = remaining.length
      return false
    }
  }
  truncateSpool()
  return true
}

async function processCycle(batch: Batch): Promise<void> {
  const spooled = readSpool()
  if (spooled.length > 0) {
    const drained = await replaySpool(spooled)
    if (!drained) {
      appendToSpool(batch)
      log('cycle', { ts: batch.ts, status: 'spooled', reason: 'replay_failed', spoolDepth: spoolLineCount, ...vantageFields(batch) })
      return
    }
  }

  const posted = await postBatch(batch)
  if (posted.ok) {
    // The failure this catches has already happened: an API predating the
    // `cycle` field parsed the batch leniently, dropped the unknown key and
    // answered 200, so 106 consecutive vantages were discarded while the spool
    // never engaged — nothing had failed. A log line only, deliberately: the
    // samples *were* stored, so spooling or retrying the batch would duplicate
    // work and re-drop the same vantage. Only an explicit `false` is a warning;
    // an API too old to report `cycleStored` says nothing either way.
    if (batch.cycle !== undefined && posted.skipped === false && posted.cycleStored === false) {
      log('cycle.vantage_dropped', { ts: batch.ts })
    }
    log('cycle', {
      ts: batch.ts,
      status: 'ok',
      targets: Object.fromEntries(batch.samples.map((s) => [s.target, `${s.received}/${s.sent}`])),
      ...vantageFields(batch),
    })
    return
  }

  appendToSpool(batch)
  log('cycle', { ts: batch.ts, status: 'spooled', reason: 'post_failed', spoolDepth: spoolLineCount, ...vantageFields(batch) })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

const shutdown = new AbortController()
process.on('SIGTERM', () => {
  log('shutdown', { signal: 'SIGTERM' })
  linkSampler?.stop()
  shutdown.abort()
})
process.on('SIGINT', () => {
  log('shutdown', { signal: 'SIGINT' })
  linkSampler?.stop()
  shutdown.abort()
})

async function main(): Promise<void> {
  log('start', {
    apiUrl: config.apiUrl,
    targets: config.targets.map((t) => t.name),
    expectedGateway,
    probeCycleSeconds: config.probeCycleSeconds,
    pingCount: config.pingCount,
    pingIntervalSeconds: config.pingIntervalSeconds,
    linkIface: config.linkIface,
    linkSampleIntervalMs: config.linkSampleIntervalMs,
    wifiIface: config.wifiIface,
    wifiSampleEveryNCycles: config.wifiSampleEveryNCycles,
    // Null means no `wan`-scoped target, which disables the Wi-Fi sample —
    // worth seeing at startup rather than inferring from missing rows.
    wifiPingTarget,
  })

  // Said once, at startup, because the failure mode of log rotation is silence:
  // if `LINEWATCH_LOG_PATH` and the plist's StandardOutPath ever drift apart the
  // bound stops applying and nothing else would ever say so. `active: false` on
  // a hand-started run is normal — stdout is a terminal, not the launchd log.
  const rotation = inspectRotation({ logPath: config.logPath, maxBytes: config.logMaxBytes })
  log('log.rotation', {
    path: config.logPath,
    maxBytes: config.logMaxBytes,
    bytes: rotation.sizeBytes,
    active: rotation.decision.rotate || rotation.decision.reason === 'under-threshold',
    ...(rotation.decision.rotate ? {} : { reason: rotation.decision.reason }),
  })

  // Started before the first cycle, so the first drain covers the ping phase
  // only (~4 s of a 30 s cycle) and reports that honestly. Every cycle after it
  // covers a full interval.
  startLinkSampler(config.linkIface)

  while (!shutdown.signal.aborted) {
    const cycleStart = Date.now()
    // Between cycles, never mid-cycle: this truncates the file both fds write
    // to, and doing it here means it can never land between the two halves of a
    // line. One `stat` per 30 s is not worth measuring.
    rotateLogIfNeeded({ logPath: config.logPath, maxBytes: config.logMaxBytes, report: log })
    const batch = await runCycle()
    await processCycle(batch)

    if (shutdown.signal.aborted) break
    const elapsed = Date.now() - cycleStart
    const remaining = Math.max(0, config.probeCycleSeconds * 1000 - elapsed)
    await sleep(remaining, shutdown.signal)
  }

  linkSampler?.stop()
  log('stopped')
}

await main()

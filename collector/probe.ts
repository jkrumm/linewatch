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
import { parsePingOutput, type PingResult } from './ping-parser.js'
import { captureVantage, type Vantage } from './vantage.js'

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
}

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

async function runCycle(): Promise<Batch> {
  const ts = Date.now()
  // Captured concurrently with the pings so it describes the path the pings
  // actually went out over, and so it adds nothing to the cycle's wall clock.
  // `captureVantage` is written not to throw; the catch is the second belt —
  // the vantage must never be able to cost us the uptime record.
  const [samples, vantage] = await Promise.all([
    Promise.all(config.targets.map((target) => pingTarget(target))),
    captureVantage({ expectedGateway, report: log }).catch((err: unknown) => {
      log('vantage.error', { error: err instanceof Error ? err.message : String(err) })
      return null
    }),
  ])
  return { ts, samples, ...(vantage === null ? {} : { cycle: vantage }) }
}

/**
 * Compact vantage summary for the per-cycle log line. The three states the log
 * has to keep apart: `path: null` = the capture threw (no vantage at all),
 * `none/unknown/unknown` = it ran and found no default route, and everything
 * else = a real path.
 */
function vantageFields(batch: Batch): Record<string, unknown> {
  const cycle = batch.cycle
  if (cycle === undefined) return { path: null, onHomeLine: null }
  return {
    path: `${cycle.pathIf ?? 'none'}/${cycle.pathClass ?? 'unknown'}/${cycle.linkMedia ?? 'unknown'}`,
    onHomeLine: cycle.onHomeLine,
  }
}

async function postBatch(batch: Batch): Promise<boolean> {
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
    return response.ok
  } catch {
    return false
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
    const ok = await postBatch(batch)
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
  if (posted) {
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
  shutdown.abort()
})
process.on('SIGINT', () => {
  log('shutdown', { signal: 'SIGINT' })
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
  })

  while (!shutdown.signal.aborted) {
    const cycleStart = Date.now()
    const batch = await runCycle()
    await processCycle(batch)

    if (shutdown.signal.aborted) break
    const elapsed = Date.now() - cycleStart
    const remaining = Math.max(0, config.probeCycleSeconds * 1000 - elapsed)
    await sleep(remaining, shutdown.signal)
  }

  log('stopped')
}

await main()

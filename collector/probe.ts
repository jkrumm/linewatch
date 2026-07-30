#!/usr/bin/env bun
/**
 * The native launchd collector (docs/DESIGN.md "Shape"). Runs on the Mac
 * mini's host macOS — Colima's NAT fabricates ICMP replies inside a
 * container, so this half of the system cannot live in Docker.
 *
 * Deliberately dependency-free beyond Bun + the system `ping`: no `bun
 * install` needed to run it, and it changes rarely. It does NOT import
 * src/config.ts or anything that pulls in elysia/drizzle/croner/zod — those
 * are the API server's business. `./ping-parser.ts` and `../src/lib/stats.ts`
 * are safe imports here because both are pure, import-nothing modules; if
 * either ever grows a real dependency, that dependency would leak into the
 * collector too, so keep them that way.
 *
 * Every cycle: ping every target in parallel, POST the batch to the API,
 * spool to disk on failure and replay the spool on the next success. Never
 * gate on ping's exit code — 100% loss is a valid measurement (exit 2 on
 * macOS), not a fault.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { median, stddev } from '../src/lib/stats.js'
import { parsePingOutput, type PingResult } from './ping-parser.js'

interface Target {
  name: string
  addr: string
}

// Mirrors src/config.ts's DEFAULT_TARGETS (docs/DESIGN.md "Targets") —
// duplicated rather than imported so this file stays free of any transitive
// dependency on the API server's config module (see file header).
const DEFAULT_TARGETS: Target[] = [
  { name: 'gateway', addr: '192.168.1.1' },
  { name: 'cloudflare', addr: '1.1.1.1' },
  { name: 'google', addr: '8.8.8.8' },
  { name: 'quad9', addr: '9.9.9.9' },
]

function parseTargets(raw: string | undefined): Target[] {
  if (!raw) return DEFAULT_TARGETS
  return raw.split(',').map((entry) => {
    const [name, addr] = entry.trim().split(':')
    if (!name || !addr) {
      throw new Error(`invalid LINEWATCH_TARGETS entry "${entry}" (want "name:addr")`)
    }
    return { name, addr }
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
  const samples = await Promise.all(config.targets.map((target) => pingTarget(target)))
  return { ts, samples }
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
      log('cycle', { ts: batch.ts, status: 'spooled', reason: 'replay_failed', spoolDepth: spoolLineCount })
      return
    }
  }

  const posted = await postBatch(batch)
  if (posted) {
    log('cycle', {
      ts: batch.ts,
      status: 'ok',
      targets: Object.fromEntries(batch.samples.map((s) => [s.target, `${s.received}/${s.sent}`])),
    })
    return
  }

  appendToSpool(batch)
  log('cycle', { ts: batch.ts, status: 'spooled', reason: 'post_failed', spoolDepth: spoolLineCount })
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

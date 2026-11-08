/**
 * The collector's on-disk spool, as a pure module: no config, no network, no
 * globals — the path and the poster are injected, so the failure paths (torn
 * line, poison batch, outage backlog) are testable without a process.
 *
 * Why a spool at all: without it every redeploy writes a fake outage into the
 * record (AGENTS.md). Replays are idempotent because the API's `ts` is UNIQUE.
 *
 * Three rules this module owns:
 * - **A bad line never stops the collector.** A torn or non-object line is
 *   moved to the sibling `*.rejected.jsonl` and counted; the rest still drains.
 * - **Only some failures are worth retrying.** 401/408/429, 5xx and network
 *   errors say "not now"; any other 4xx says "never" — that batch would sit at
 *   the head of the queue forever — so it is quarantined to the rejected file.
 * - **Replay is bounded per cycle** (`REPLAY_PER_CYCLE`), so a deep backlog
 *   drains over many cycles instead of starving the cycle's own measurement.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export const SPOOL_MAX_LINES = 50_000
export const REPLAY_PER_CYCLE = 200

/** `status` is the HTTP status, absent when there was no response (network, timeout). */
export interface PostResult {
  ok: boolean
  status?: number | undefined
}

export type FailureClass = 'retry' | 'quarantine'

const RETRYABLE_4XX = new Set([401, 408, 429])

/** Absent status (no response at all) and anything outside 4xx stay retryable. */
export function classifyFailure(status: number | undefined): FailureClass {
  if (status === undefined) return 'retry'
  if (status < 400 || status >= 500) return 'retry'
  return RETRYABLE_4XX.has(status) ? 'retry' : 'quarantine'
}

export function rejectedPathFor(spoolPath: string): string {
  return spoolPath.endsWith('.jsonl')
    ? `${spoolPath.slice(0, -'.jsonl'.length)}.rejected.jsonl`
    : `${spoolPath}.rejected.jsonl`
}

export type Report = (event: string, fields?: Record<string, unknown>) => void

export interface SpoolOptions<T> {
  path: string
  post: (entry: T) => Promise<PostResult>
  report?: Report
  maxLines?: number
  replayCap?: number
}

export interface ReplayResult {
  /** A retryable failure stopped the replay; the caller should spool its own batch. */
  failed: boolean
  replayed: number
  quarantined: number
  /** Entries still on disk. */
  remaining: number
}

export interface Spool<T> {
  /** false when the line cap refused the entry. */
  append(entry: T): boolean
  replay(): Promise<ReplayResult>
  depth(): number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ReadSpool<T> {
  entries: { line: string; value: T }[]
  badLines: string[]
}

function readTolerant<T>(path: string): ReadSpool<T> {
  const result: ReadSpool<T> = { entries: [], badLines: [] }
  if (!existsSync(path)) return result
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (line.length === 0) continue
    try {
      const value: unknown = JSON.parse(line)
      if (!isObject(value)) throw new Error('not an object')
      result.entries.push({ line, value: value as T })
    } catch {
      result.badLines.push(line)
    }
  }
  return result
}

function writeLines(path: string, lines: string[]): void {
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, lines.map((line) => `${line}\n`).join(''))
  renameSync(tmpPath, path)
}

export function createSpool<T>(options: SpoolOptions<T>): Spool<T> {
  const { path, post } = options
  const report = options.report ?? (() => {})
  const maxLines = options.maxLines ?? SPOOL_MAX_LINES
  const replayCap = options.replayCap ?? REPLAY_PER_CYCLE
  const rejectedPath = rejectedPathFor(path)

  // Tracked in-process rather than re-counted from disk every cycle; initialised
  // once from the file. Torn lines count too — they are still lines on disk
  // until the first replay quarantines them.
  let lineCount = existsSync(path)
    ? readFileSync(path, 'utf-8')
        .split('\n')
        .filter((line) => line.length > 0).length
    : 0

  function quarantine(lines: string[]): void {
    if (lines.length === 0) return
    mkdirSync(dirname(rejectedPath), { recursive: true })
    appendFileSync(rejectedPath, lines.map((line) => `${line}\n`).join(''))
  }

  return {
    depth: () => lineCount,

    append(entry) {
      if (lineCount >= maxLines) {
        // Explicit drop: the newest entry is refused, the backlog is kept.
        report('spool.full', { path, maxLines })
        return false
      }
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify(entry)}\n`)
      lineCount += 1
      return true
    },

    async replay() {
      const { entries, badLines } = readTolerant<T>(path)
      if (badLines.length > 0) {
        quarantine(badLines)
        report('spool.bad_lines', { count: badLines.length, rejectedPath })
      }

      let processed = 0
      let replayed = 0
      let failed = false
      const quarantined: string[] = []
      for (const { line, value } of entries) {
        if (processed >= replayCap) break
        const result = await post(value)
        if (result.ok) {
          replayed += 1
        } else if (classifyFailure(result.status) === 'quarantine') {
          quarantined.push(line)
          report('spool.quarantined', { status: result.status, rejectedPath })
        } else {
          failed = true
          break
        }
        processed += 1
      }
      quarantine(quarantined)

      const remainingLines = entries.slice(processed).map((entry) => entry.line)
      if (processed > 0 || badLines.length > 0) {
        if (existsSync(path)) writeLines(path, remainingLines)
      }
      lineCount = remainingLines.length
      if (replayed > 0 || quarantined.length > 0) {
        report('spool.replay', {
          replayed,
          quarantined: quarantined.length,
          remaining: lineCount,
          capped: !failed && lineCount > 0,
        })
      }
      return { failed, replayed, quarantined: quarantined.length, remaining: lineCount }
    },
  }
}

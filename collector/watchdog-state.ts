/**
 * The watchdog's ledger on disk: budgets, the write-ahead entry, the latch.
 *
 * ## Why not beside `spool.jsonl`
 *
 * The spool lives in the repo directory. This must not: a `git clean` there
 * would reset the reboot budget and the latch counter, which is the single
 * failure that turns a watchdog into a reboot loop. `~/.local/state` is outside
 * every checkout, survives a redeploy, and is the conventional place for
 * exactly this — state a program needs across runs that is not configuration
 * and not a cache.
 *
 * ## Why a corrupt ledger disarms rather than resets
 *
 * A parse failure has two readings: a truncated write, or a file that is simply
 * not ours. Both are indistinguishable from here, and the tempting response —
 * start from an empty ledger — silently returns the reboot budget to full and
 * clears a latch that a human was supposed to clear. So an unreadable file that
 * *exists* is reported as untrusted, and the runner stands the whole watchdog
 * down until a person looks. A file that does not exist at all is a first boot,
 * which is a different thing and gets an empty ledger honestly.
 *
 * ## Why the write is tmp → fsync → rename
 *
 * The write-ahead entry is only worth anything if it is durable before the
 * action leaves the process. `writeFileSync` alone returns once the data is in
 * the page cache, so a power cut between the write and the action loses the
 * record of an action that then fires again on the next boot. `fsync` on the
 * file, then `rename` (atomic within a filesystem), then `fsync` on the
 * directory so the rename itself is durable.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { emptyLedger, type Ledger } from './watchdog-ladder.js'

export const DEFAULT_LEDGER_PATH = join(homedir(), '.local', 'state', 'linewatch', 'watchdog-state.json')

/** `touch` this from a phone in the seconds the link is up and everything stops. */
export const DEFAULT_DISARM_PATH = join(homedir(), '.config', 'linewatch', 'watchdog-disarmed')

export interface LoadedLedger {
  ledger: Ledger
  /**
   * False when a file existed and could not be understood. The runner must not
   * act on an untrusted ledger — its budgets are unknown, not empty.
   */
  trusted: boolean
  /** Why it is untrusted, for the log and for `make watchdog-status`. */
  reason: string | null
}

/**
 * Structural validation only, and deliberately shallow: this is checking that
 * the file is the shape this program wrote, not that its contents are sensible.
 * A ledger whose numbers are wrong is a bug upstream; a ledger whose *shape* is
 * wrong is a different program's file or half of ours.
 */
function looksLikeLedger(value: unknown): value is Ledger {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (candidate['version'] !== 1) return false
  const ladder = candidate['ladder']
  if (typeof ladder !== 'object' || ladder === null) return false
  if (!Array.isArray(candidate['actions'])) return false
  if (typeof candidate['consecutiveActions'] !== 'number') return false
  const v6 = candidate['v6']
  return typeof v6 === 'object' && v6 !== null
}

export function readLedger(path: string = DEFAULT_LEDGER_PATH): LoadedLedger {
  if (!existsSync(path)) return { ledger: emptyLedger(), trusted: true, reason: null }

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (error) {
    return { ledger: emptyLedger(), trusted: false, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ledger: emptyLedger(), trusted: false, reason: 'not valid JSON — refusing to assume the budgets are empty' }
  }

  if (!looksLikeLedger(parsed)) {
    // Includes a future `version`. A newer schema read by an older binary is
    // exactly the case where guessing is worst.
    return { ledger: emptyLedger(), trusted: false, reason: 'not a version 1 ledger — refusing to assume the budgets are empty' }
  }

  return { ledger: parsed, trusted: true, reason: null }
}

/**
 * Durable before it returns. Callers may treat a normal return as "this is on
 * the disk", which is the whole contract the write-ahead depends on.
 */
export function writeLedger(ledger: Ledger, path: string = DEFAULT_LEDGER_PATH): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  const tmp = `${path}.tmp`
  // 0600 at creation, not chmod afterwards: it holds no secret, but it decides
  // whether this machine will reboot the household's router, and a window where
  // it is world-writable is a window where it can be edited.
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })

  const fileFd = openSync(tmp, 'r')
  try {
    fsyncSync(fileFd)
  } finally {
    closeSync(fileFd)
  }

  renameSync(tmp, path)

  // The rename itself is metadata and lives in the directory, so without this
  // the atomic swap can be lost even though the file's contents were flushed.
  const dirFd = openSync(directory, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/** Both ways of standing the watchdog down are the same file; this is the read side. */
export function isDisarmed(path: string = DEFAULT_DISARM_PATH): boolean {
  return existsSync(path)
}

export function disarm(path: string = DEFAULT_DISARM_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `disarmed at ${new Date().toISOString()}\n`, { mode: 0o600 })
}

export function rearm(path: string = DEFAULT_DISARM_PATH): void {
  if (existsSync(path)) unlinkSync(path)
}

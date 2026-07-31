/**
 * Bounds the collector's own log file.
 *
 * The log is not disposable. It was the only source for findings no read of the
 * database could produce — 106 vantage payloads the server silently accepted and
 * dropped were visible *only* because the collector logged what it sent (see
 * probe.ts's `cycle.vantage_dropped`). It grows ~400 KB/day and had no bound at
 * all, so the choice is what to keep, not whether to keep it.
 *
 * **Rotation happens in place, from inside the collector, and it must.** launchd
 * opens `StandardOutPath`/`StandardErrorPath` once when it spawns the job and
 * holds those descriptors for the process's whole life; it does not reopen them.
 * Measured on this host with `lsof +fg` against the running agent:
 *
 *     bun 1874 1u REG R,W,AP,0x10000 1,17 406911 164238009 …/linewatch-collector.log
 *     bun 1874 2u REG R,W,AP         1,17 406911 164238009 …/linewatch-collector.log
 *
 * Two facts fall out of that line, and the whole design rests on them:
 * - `AP` = **O_APPEND**. Every write lands at the current end of file, so
 *   truncating the file to zero makes the next write resume at offset 0. No
 *   sparse hole, no descriptor to reopen, no restart needed.
 * - fd 1 and fd 2 are the **same inode**, so stderr — where an uncaught
 *   exception goes — is bounded by the same act.
 *
 * **Why not `newsyslog`.** It is the obvious macOS answer and it is the wrong
 * one here: it rotates by *renaming*, and a rename leaves launchd's descriptor
 * pointing at the renamed inode. The collector would go on writing into
 * `…-collector.log.0` forever while `…-collector.log` sat empty — a log that
 * looks healthy and is silently frozen, which is the same class of failure as
 * the dropped vantages this log exists to catch. It also needs a root-owned
 * `/etc/newsyslog.d/` drop-in, and `make collector-setup` is a user-level target
 * that must not start asking for sudo.
 *
 * **Why not the unified `log` facility.** os_log means giving up greppable JSON
 * lines for `log show` scans — measured elsewhere in this collector at >120 s
 * for a one-day window (link-sampler.ts) — and its buffer size is the system's
 * business, not something this job can state a bound for. Bounding a plain file
 * we already write is strictly simpler.
 *
 * Dependency-free like the rest of collector/ (probe.ts's header): `node:fs`
 * only, no npm, nothing from src/.
 */
import { copyFileSync, fstatSync, renameSync, statSync, truncateSync } from 'node:fs'

/**
 * Rotate at 8 MiB, keeping exactly one previous generation, so total disk use is
 * **≤ 16 MiB steady** (live + `.1`) and ≤ 24 MiB for the moment a copy is in
 * flight. At the measured ~400 KB/day that is ~21 days per generation, so the
 * two files together always hold between 21 and 42 days of history. An incident
 * worth explaining shows up within hours — the 106-cycle vantage drop was 53
 * minutes — so three weeks of guaranteed depth is far past what any
 * investigation has needed, and 16 MiB is not worth optimising below.
 */
export const DEFAULT_LOG_MAX_BYTES = 8 * 1024 * 1024

/**
 * Enough of a `stat` to say "these two paths are the same open file". dev+ino is
 * the identity check; comparing paths would not survive a symlink or a
 * `~`-expansion difference between the plist and this process.
 */
export interface FileIdentity {
  dev: number
  ino: number
}

/**
 * Why a rotation did not happen. Named rather than boolean because two of these
 * are configuration mistakes that would otherwise present as "the bound quietly
 * stopped working": `stdout-elsewhere` means the plist's `StandardOutPath` and
 * `LINEWATCH_LOG_PATH` have drifted apart, and `no-log-file` means the path is
 * wrong outright.
 */
export type RotationSkipReason = 'disabled' | 'no-log-file' | 'stdout-not-a-file' | 'stdout-elsewhere' | 'under-threshold'

export type RotationDecision = { rotate: true } | { rotate: false; reason: RotationSkipReason }

/**
 * The previous generation. A fixed name, not a timestamp: a timestamped scheme
 * needs a reaper to stay bounded, and a bound that depends on a reaper running
 * is not a bound. Two fixed names make the ceiling arithmetic.
 */
export function rotatedLogPath(logPath: string): string {
  return `${logPath}.1`
}

/**
 * Staging path for the copy. Written then `rename`d over `.1`, the same
 * write-temp-then-rename idiom the spool replay uses in probe.ts, so the
 * previous generation is either the old complete one or the new complete one
 * and never a half-copied file — including when the collector is SIGKILLed
 * mid-rotation.
 */
export function rotationTempPath(logPath: string): string {
  return `${logPath}.1.tmp`
}

/**
 * The whole decision, pure so it can be tested without touching a log file.
 *
 * `stdout: null` means fd 1 is not a regular file — an interactive
 * `bun run collector/probe.ts` writing to a terminal or a pipe. That case must
 * skip: the collector would otherwise truncate the launchd job's live log while
 * its own output went to the terminal, destroying the record of a *running*
 * collector to bound a file it is not writing to.
 */
export function decideRotation(input: {
  stdout: FileIdentity | null
  log: (FileIdentity & { size: number }) | null
  maxBytes: number
}): RotationDecision {
  // NaN counts as disabled, not as a threshold. `Number('8mb')` is NaN, and
  // every comparison against it is false — including `size < maxBytes`, which
  // would make an unparseable override rotate on *every* cycle and shred the
  // log instead of bounding it. An override nobody can read is not a bound.
  if (!Number.isFinite(input.maxBytes) || input.maxBytes <= 0) return { rotate: false, reason: 'disabled' }
  if (input.log === null) return { rotate: false, reason: 'no-log-file' }
  if (input.stdout === null) return { rotate: false, reason: 'stdout-not-a-file' }
  if (input.stdout.dev !== input.log.dev || input.stdout.ino !== input.log.ino) {
    return { rotate: false, reason: 'stdout-elsewhere' }
  }
  if (input.log.size < input.maxBytes) return { rotate: false, reason: 'under-threshold' }
  return { rotate: true }
}

/** `stat` of a path as identity + size, or null when it does not exist. */
function statLog(logPath: string): (FileIdentity & { size: number }) | null {
  try {
    const stat = statSync(logPath)
    return { dev: stat.dev, ino: stat.ino, size: stat.size }
  } catch {
    return null
  }
}

/** Identity of our own stdout, or null when it is not a regular file (TTY, pipe). */
function statStdout(): FileIdentity | null {
  try {
    const stat = fstatSync(1)
    if (!stat.isFile()) return null
    return { dev: stat.dev, ino: stat.ino }
  } catch {
    // A closed or unstattable fd 1 is not a file we may truncate. Null, not a
    // guess: the failure mode of guessing here is deleting the live log.
    return null
  }
}

/**
 * Where a rotation stands, without doing it. For the one startup line that says
 * whether the bound is actually in force — a silently inactive rotation is the
 * thing this module can most easily get wrong.
 */
export function inspectRotation(options: { logPath: string; maxBytes: number }): {
  decision: RotationDecision
  sizeBytes: number | null
} {
  const log = statLog(options.logPath)
  return {
    decision: decideRotation({ stdout: statStdout(), log, maxBytes: options.maxBytes }),
    // Null rather than 0 when there is no file yet: "no log on disk" and "an
    // empty log" are different states and only one of them is a mistake.
    sizeBytes: log?.size ?? null,
  }
}

/**
 * Rotate if the live log has reached the threshold. Returns whether it did.
 *
 * Ordering is the crash-safety argument, and it is deliberate:
 * 1. copy live → temp (live untouched; a kill here leaves only a stale temp)
 * 2. rename temp → `.1` (atomic; `.1` is never partial)
 * 3. truncate live to 0 (a kill between 2 and 3 leaves a duplicate generation,
 *    which is harmless — the next cycle simply rotates again)
 *
 * No line can be lost between the copy and the truncate: the collector is a
 * single process writing synchronously from one loop, this runs between its own
 * writes, and every child it spawns gets piped stdio rather than inheriting fd 1.
 *
 * Never throws. A log that cannot be rotated must not be able to stop the
 * measurements — the record is the point, the log is the diary.
 */
export function rotateLogIfNeeded(options: {
  logPath: string
  maxBytes: number
  report: (event: string, fields?: Record<string, unknown>) => void
}): boolean {
  const log = statLog(options.logPath)
  const decision = decideRotation({ stdout: statStdout(), log, maxBytes: options.maxBytes })
  if (!decision.rotate || log === null) return false

  const previous = rotatedLogPath(options.logPath)
  const temp = rotationTempPath(options.logPath)
  try {
    copyFileSync(options.logPath, temp)
    renameSync(temp, previous)
    truncateSync(options.logPath, 0)
  } catch (err) {
    options.report('log.rotate_failed', { error: err instanceof Error ? err.message : String(err) })
    return false
  }

  // Reported after the truncate on purpose: this becomes the first line of the
  // fresh file and explains why it starts mid-history.
  options.report('log.rotated', { path: options.logPath, previous, bytes: log.size, maxBytes: options.maxBytes })
  return true
}

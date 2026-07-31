import { describe, expect, test } from 'bun:test'
import { DEFAULT_LOG_MAX_BYTES, decideRotation, rotatedLogPath, rotationTempPath } from './log-rotate.js'

/**
 * Only the pure decision is exercised here. Nothing in this file opens, writes
 * or truncates a log — the collector's real log is the record of what it sent,
 * and a test that spams or truncates it to prove a threshold would be destroying
 * the thing the threshold exists to protect. The fs half of the module is three
 * `node:fs` calls in a fixed order; the judgement is all here.
 */

const LOG_PATH = '/tmp/linewatch-test/collector.log'
/** Same file: fd 1 is the launchd-opened log. The only case that may rotate. */
const SAME = { dev: 1, ino: 42 }

describe('rotatedLogPath / rotationTempPath', () => {
  test('one fixed previous generation, and a staging name beside it', () => {
    expect(rotatedLogPath(LOG_PATH)).toBe('/tmp/linewatch-test/collector.log.1')
    expect(rotationTempPath(LOG_PATH)).toBe('/tmp/linewatch-test/collector.log.1.tmp')
  })

  test('both names sit in the log’s own directory, so the rename stays atomic', () => {
    // rename(2) is only atomic within a filesystem. A temp path in /tmp or
    // $TMPDIR could land on another volume and degrade to a copy, which is
    // exactly the half-written previous generation the staging file prevents.
    expect(rotationTempPath(LOG_PATH).startsWith('/tmp/linewatch-test/')).toBe(true)
    expect(rotationTempPath(LOG_PATH).startsWith(`${rotatedLogPath(LOG_PATH)}`)).toBe(true)
  })
})

describe('decideRotation', () => {
  test('rotates once the live log reaches the threshold', () => {
    expect(decideRotation({ stdout: SAME, log: { ...SAME, size: DEFAULT_LOG_MAX_BYTES }, maxBytes: DEFAULT_LOG_MAX_BYTES })).toEqual({
      rotate: true,
    })
    expect(decideRotation({ stdout: SAME, log: { ...SAME, size: DEFAULT_LOG_MAX_BYTES + 1 }, maxBytes: DEFAULT_LOG_MAX_BYTES })).toEqual(
      { rotate: true },
    )
  })

  test('leaves a log below the threshold alone', () => {
    expect(decideRotation({ stdout: SAME, log: { ...SAME, size: DEFAULT_LOG_MAX_BYTES - 1 }, maxBytes: DEFAULT_LOG_MAX_BYTES })).toEqual({
      rotate: false,
      reason: 'under-threshold',
    })
    expect(decideRotation({ stdout: SAME, log: { ...SAME, size: 0 }, maxBytes: DEFAULT_LOG_MAX_BYTES })).toEqual({
      rotate: false,
      reason: 'under-threshold',
    })
  })

  test('never truncates a file this process is not the one writing to', () => {
    // A hand-started `bun run collector/probe.ts`: stdout is a terminal, and the
    // launchd job may well be running and writing to that same path. Truncating
    // it here would delete a live collector's record to bound a file this
    // process never touches.
    expect(decideRotation({ stdout: null, log: { ...SAME, size: 10 * DEFAULT_LOG_MAX_BYTES }, maxBytes: DEFAULT_LOG_MAX_BYTES })).toEqual({
      rotate: false,
      reason: 'stdout-not-a-file',
    })

    // Redirected to some other file, or LINEWATCH_LOG_PATH drifted away from the
    // plist's StandardOutPath. Same rule: identity, not size, decides.
    const elsewhere = { dev: 1, ino: 43 }
    expect(
      decideRotation({ stdout: elsewhere, log: { ...SAME, size: 10 * DEFAULT_LOG_MAX_BYTES }, maxBytes: DEFAULT_LOG_MAX_BYTES }),
    ).toEqual({ rotate: false, reason: 'stdout-elsewhere' })

    // Same inode number on a different device is a different file. Comparing
    // `ino` alone would truncate the wrong one.
    expect(
      decideRotation({ stdout: { dev: 2, ino: 42 }, log: { ...SAME, size: 10 * DEFAULT_LOG_MAX_BYTES }, maxBytes: DEFAULT_LOG_MAX_BYTES }),
    ).toEqual({ rotate: false, reason: 'stdout-elsewhere' })
  })

  test('a missing log file is not a rotation', () => {
    expect(decideRotation({ stdout: SAME, log: null, maxBytes: DEFAULT_LOG_MAX_BYTES })).toEqual({
      rotate: false,
      reason: 'no-log-file',
    })
  })

  test('an unreadable threshold disables rotation instead of rotating every cycle', () => {
    // `Number('8mb')` is NaN, and every comparison against NaN is false —
    // including `size < maxBytes`. Without the explicit guard a typo'd
    // LINEWATCH_LOG_MAX_BYTES would rotate on every cycle and shred the log it
    // was meant to bound.
    const huge = { stdout: SAME, log: { ...SAME, size: 10 * DEFAULT_LOG_MAX_BYTES } }
    expect(decideRotation({ ...huge, maxBytes: Number.NaN })).toEqual({ rotate: false, reason: 'disabled' })
    expect(decideRotation({ ...huge, maxBytes: Number.POSITIVE_INFINITY })).toEqual({ rotate: false, reason: 'disabled' })
    expect(decideRotation({ ...huge, maxBytes: 0 })).toEqual({ rotate: false, reason: 'disabled' })
    expect(decideRotation({ ...huge, maxBytes: -1 })).toEqual({ rotate: false, reason: 'disabled' })
  })

  test('the shipped bound is 8 MiB, so two generations cost 16 MiB', () => {
    // Stated as an assertion because the number is the whole promise: at the
    // measured ~400 KB/day this keeps 21-42 days of history for 16 MiB.
    expect(DEFAULT_LOG_MAX_BYTES).toBe(8 * 1024 * 1024)
  })
})

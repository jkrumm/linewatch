import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyLedger } from './watchdog-ladder.js'
import { disarm, isDisarmed, readLedger, rearm, writeLedger } from './watchdog-state.js'

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linewatch-ledger-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('the ledger on disk', () => {
  test('a first boot is an empty ledger and is trusted', () => {
    const loaded = readLedger(join(scratch(), 'nothing-here.json'))
    expect(loaded.trusted).toBe(true)
    expect(loaded.ledger).toEqual(emptyLedger())
  })

  test('a round trip preserves the budgets exactly', () => {
    const path = join(scratch(), 'state.json')
    const ledger = {
      ...emptyLedger(),
      consecutiveActions: 2,
      actions: [{ ts: 1_700_000_000_000, kind: 'reboot' as const, outageKey: 'wan:1', outcome: 'executed' as const }],
      pending: { ts: 1_700_000_001_000, kind: 'reconnect' as const, outageKey: 'wan:2' },
    }
    writeLedger(ledger, path)
    expect(readLedger(path)).toEqual({ ledger, trusted: true, reason: null })
  })

  test('it is written 0600, because it decides whether this machine reboots the router', () => {
    const path = join(scratch(), 'state.json')
    writeLedger(emptyLedger(), path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('it creates its directory, so a fresh machine needs no setup step', () => {
    const path = join(scratch(), 'deep', 'nested', 'state.json')
    writeLedger(emptyLedger(), path)
    expect(existsSync(path)).toBe(true)
  })

  test('no temporary file is left behind for a later read to find', () => {
    const dir = scratch()
    const path = join(dir, 'state.json')
    writeLedger(emptyLedger(), path)
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  /**
   * The distinction the whole module turns on. An empty ledger has a full
   * reboot budget and no latch — so a corrupt file silently read as empty is
   * the exact input that turns this into a reboot loop, and it would happen at
   * the worst moment, because a truncated write is most likely after a crash.
   */
  test('a corrupt file is untrusted, never quietly treated as empty', () => {
    const path = join(scratch(), 'state.json')
    writeFileSync(path, '{"version":1,"ladder":{},"acti')
    const loaded = readLedger(path)
    expect(loaded.trusted).toBe(false)
    expect(loaded.reason).toContain('JSON')
  })

  test('a ledger from a schema this binary does not know is untrusted', () => {
    const path = join(scratch(), 'state.json')
    writeFileSync(path, JSON.stringify({ version: 2, ladder: {}, actions: [], consecutiveActions: 0, v6: {} }))
    expect(readLedger(path).trusted).toBe(false)
  })

  test('a well-formed file missing the counters is untrusted', () => {
    const path = join(scratch(), 'state.json')
    writeFileSync(path, JSON.stringify({ version: 1, ladder: {}, actions: [] }))
    expect(readLedger(path).trusted).toBe(false)
  })

  test('a valid ledger survives being written over an untrusted one', () => {
    const path = join(scratch(), 'state.json')
    writeFileSync(path, 'garbage')
    writeLedger({ ...emptyLedger(), consecutiveActions: 1 }, path)
    const loaded = readLedger(path)
    expect(loaded.trusted).toBe(true)
    expect(loaded.ledger.consecutiveActions).toBe(1)
    expect(readFileSync(path, 'utf-8')).toContain('"version": 1')
  })
})

describe('the disarm file', () => {
  test('touching it and clearing it are both idempotent', () => {
    const path = join(scratch(), 'disarmed')
    expect(isDisarmed(path)).toBe(false)

    disarm(path)
    disarm(path)
    expect(isDisarmed(path)).toBe(true)

    // Cleared twice: re-arming something already armed must not throw, or the
    // recovery path fails exactly when someone is trying to use it.
    rearm(path)
    rearm(path)
    expect(isDisarmed(path)).toBe(false)
  })
})

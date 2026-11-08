import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyFailure,
  createSpool,
  type PostResult,
  rejectedPathFor,
  REPLAY_PER_CYCLE,
} from './spool.js'

interface Entry {
  ts: number
}

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spool-test-'))
  path = join(dir, 'spool.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function lines(file: string): string[] {
  return existsSync(file)
    ? readFileSync(file, 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0)
    : []
}

function poster(respond: (entry: Entry) => PostResult) {
  const seen: number[] = []
  return {
    seen,
    post: async (entry: Entry) => {
      seen.push(entry.ts)
      return respond(entry)
    },
  }
}

describe('classifyFailure', () => {
  test('401, 408, 429, 5xx and no response stay retryable', () => {
    for (const status of [401, 408, 429, 500, 502, 503, undefined]) {
      expect(classifyFailure(status)).toBe('retry')
    }
  })
  test('other 4xx are quarantined', () => {
    for (const status of [400, 403, 404, 413, 422]) {
      expect(classifyFailure(status)).toBe('quarantine')
    }
  })
})

describe('spool', () => {
  test('drains in order and empties the file', async () => {
    const p = poster(() => ({ ok: true }))
    const spool = createSpool<Entry>({ path, post: p.post })
    for (const ts of [1, 2, 3]) spool.append({ ts })
    const result = await spool.replay()
    expect(p.seen).toEqual([1, 2, 3])
    expect(result).toMatchObject({ failed: false, replayed: 3, remaining: 0 })
    expect(lines(path)).toEqual([])
    expect(spool.depth()).toBe(0)
  })

  test('a torn line is quarantined and the rest still drains', async () => {
    writeFileSync(path, '{"ts":1}\n{"ts":2,"samp\n{"ts":3}\n[1]\n')
    const p = poster(() => ({ ok: true }))
    const spool = createSpool<Entry>({ path, post: p.post })
    const result = await spool.replay()
    expect(p.seen).toEqual([1, 3])
    expect(result.failed).toBe(false)
    expect(lines(path)).toEqual([])
    expect(lines(rejectedPathFor(path))).toEqual(['{"ts":2,"samp', '[1]'])
  })

  test('a poison 422 batch is quarantined and draining continues', async () => {
    const p = poster((e) => (e.ts === 2 ? { ok: false, status: 422 } : { ok: true }))
    const spool = createSpool<Entry>({ path, post: p.post })
    for (const ts of [1, 2, 3]) spool.append({ ts })
    const result = await spool.replay()
    expect(p.seen).toEqual([1, 2, 3])
    expect(result).toMatchObject({ failed: false, replayed: 2, quarantined: 1, remaining: 0 })
    expect(lines(path)).toEqual([])
    expect(lines(rejectedPathFor(path))).toEqual(['{"ts":2}'])
  })

  test('401 stays retryable: replay stops, nothing is lost or quarantined', async () => {
    const p = poster((e) => (e.ts === 2 ? { ok: false, status: 401 } : { ok: true }))
    const spool = createSpool<Entry>({ path, post: p.post })
    for (const ts of [1, 2, 3]) spool.append({ ts })
    const result = await spool.replay()
    expect(p.seen).toEqual([1, 2])
    expect(result).toMatchObject({ failed: true, replayed: 1, remaining: 2 })
    expect(lines(path)).toEqual(['{"ts":2}', '{"ts":3}'])
    expect(existsSync(rejectedPathFor(path))).toBe(false)
  })

  test('a network failure (no status) stays retryable', async () => {
    const p = poster(() => ({ ok: false }))
    const spool = createSpool<Entry>({ path, post: p.post })
    spool.append({ ts: 1 })
    const result = await spool.replay()
    expect(result).toMatchObject({ failed: true, remaining: 1 })
    expect(lines(path)).toEqual(['{"ts":1}'])
  })

  test('replay is capped per cycle and the remainder drains later', async () => {
    const p = poster(() => ({ ok: true }))
    const spool = createSpool<Entry>({ path, post: p.post, replayCap: 3 })
    for (let ts = 1; ts <= 8; ts++) spool.append({ ts })
    const first = await spool.replay()
    expect(first).toMatchObject({ failed: false, replayed: 3, remaining: 5 })
    expect(p.seen).toEqual([1, 2, 3])
    await spool.replay()
    const third = await spool.replay()
    expect(third.remaining).toBe(0)
    expect(p.seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  test('the default cap is ~200', () => {
    expect(REPLAY_PER_CYCLE).toBe(200)
  })

  test('the line cap refuses new entries and keeps the backlog', () => {
    const reports: string[] = []
    const spool = createSpool<Entry>({
      path,
      post: async () => ({ ok: true }),
      maxLines: 2,
      report: (event) => reports.push(event),
    })
    expect(spool.append({ ts: 1 })).toBe(true)
    expect(spool.append({ ts: 2 })).toBe(true)
    expect(spool.append({ ts: 3 })).toBe(false)
    expect(lines(path)).toEqual(['{"ts":1}', '{"ts":2}'])
    expect(reports).toContain('spool.full')
  })

  test('replay is idempotent: a second replay after a drain posts nothing', async () => {
    const p = poster(() => ({ ok: true }))
    const spool = createSpool<Entry>({ path, post: p.post })
    spool.append({ ts: 1 })
    await spool.replay()
    const again = await spool.replay()
    expect(p.seen).toEqual([1])
    expect(again).toMatchObject({ failed: false, replayed: 0, remaining: 0 })
  })

  test('depth counts lines already on disk at startup', () => {
    writeFileSync(path, '{"ts":1}\n{"ts":2}\n')
    expect(createSpool<Entry>({ path, post: async () => ({ ok: true }) }).depth()).toBe(2)
  })
})

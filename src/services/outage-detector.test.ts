import { describe, expect, test } from 'bun:test'
import { createTestDb } from '../db/test-db.js'
import { outage } from '../db/schema.js'
import { OutageDetector, type TargetCycleResult } from './outage-detector.js'

const T0 = 1_000_000
const CYCLE_MS = 30_000

function cycle(overrides: Partial<Record<'gateway' | 'cloudflare' | 'google' | 'quad9', boolean>>): TargetCycleResult[] {
  const down = { gateway: false, cloudflare: false, google: false, quad9: false, ...overrides }
  return [
    { target: 'gateway', scope: 'gateway', down: down.gateway },
    { target: 'cloudflare', scope: 'wan', down: down.cloudflare },
    { target: 'google', scope: 'wan', down: down.google },
    { target: 'quad9', scope: 'wan', down: down.quad9 },
  ]
}

describe('OutageDetector', () => {
  test('a single failing target does not open a WAN outage', () => {
    const db = createTestDb()
    const detector = new OutageDetector(db)

    detector.ingest(T0, cycle({ cloudflare: true }))

    expect(db.select().from(outage).all()).toHaveLength(0)
  })

  test('opens a WAN outage only when every wan-scoped target fails in the same cycle', () => {
    const db = createTestDb()
    const detector = new OutageDetector(db)

    detector.ingest(T0, cycle({ cloudflare: true, google: true, quad9: true }))

    const rows = db.select().from(outage).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.scope).toBe('wan')
    expect(rows[0]?.startedAt).toBe(T0)
    expect(rows[0]?.cycles).toBe(1)
    expect(rows[0]?.endedAt).toBeNull()
    expect(JSON.parse(rows[0]?.evidence ?? '[]')).toEqual(['cloudflare', 'google', 'quad9'])
  })

  test('opens a gateway outage independently of WAN state', () => {
    const db = createTestDb()
    const detector = new OutageDetector(db)

    detector.ingest(T0, cycle({ gateway: true }))

    const rows = db.select().from(outage).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.scope).toBe('gateway')
    expect(JSON.parse(rows[0]?.evidence ?? '[]')).toEqual(['gateway'])
  })

  test('extends an open outage on each subsequent failing cycle, incrementing cycles', () => {
    const db = createTestDb()
    const detector = new OutageDetector(db)

    detector.ingest(T0, cycle({ cloudflare: true, google: true, quad9: true }))
    detector.ingest(T0 + CYCLE_MS, cycle({ cloudflare: true, google: true, quad9: true }))
    detector.ingest(T0 + 2 * CYCLE_MS, cycle({ cloudflare: true, google: true, quad9: true }))

    const rows = db.select().from(outage).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cycles).toBe(3)
    expect(rows[0]?.endedAt).toBeNull()
  })

  test('closes the outage on the first recovering cycle, setting ended_at and duration_s', () => {
    const db = createTestDb()
    const detector = new OutageDetector(db)

    detector.ingest(T0, cycle({ cloudflare: true, google: true, quad9: true }))
    detector.ingest(T0 + CYCLE_MS, cycle({ cloudflare: true, google: true, quad9: true }))
    detector.ingest(T0 + 2 * CYCLE_MS, cycle({})) // recovered

    const rows = db.select().from(outage).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cycles).toBe(2)
    expect(rows[0]?.endedAt).toBe(T0 + 2 * CYCLE_MS)
    expect(rows[0]?.durationS).toBe((2 * CYCLE_MS) / 1000)
  })

  test('a single-cycle blip is recorded honestly (opened and immediately closed)', () => {
    const db = createTestDb()
    const detector = new OutageDetector(db)

    detector.ingest(T0, cycle({ cloudflare: true, google: true, quad9: true }))
    detector.ingest(T0 + CYCLE_MS, cycle({}))

    const rows = db.select().from(outage).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cycles).toBe(1)
    expect(rows[0]?.endedAt).toBe(T0 + CYCLE_MS)
  })

  test('a new outage opens after a prior one closed', () => {
    const db = createTestDb()
    const detector = new OutageDetector(db)

    detector.ingest(T0, cycle({ cloudflare: true, google: true, quad9: true }))
    detector.ingest(T0 + CYCLE_MS, cycle({})) // closes
    detector.ingest(T0 + 2 * CYCLE_MS, cycle({ cloudflare: true, google: true, quad9: true })) // opens again

    const rows = db.select().from(outage).all()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.endedAt).not.toBeNull()
    expect(rows[1]?.endedAt).toBeNull()
    expect(rows[1]?.startedAt).toBe(T0 + 2 * CYCLE_MS)
  })

  test('gateway and WAN outages are tracked independently and can overlap', () => {
    const db = createTestDb()
    const detector = new OutageDetector(db)

    detector.ingest(T0, cycle({ gateway: true, cloudflare: true, google: true, quad9: true }))

    const rows = db.select().from(outage).all()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.scope).sort()).toEqual(['gateway', 'wan'])
  })

  test('restart recovery: reloading an open outage from the DB extends rather than duplicates it', () => {
    const db = createTestDb()
    const first = new OutageDetector(db)
    first.ingest(T0, cycle({ cloudflare: true, google: true, quad9: true }))

    // Simulate a process restart: a fresh detector instance over the same DB.
    const second = new OutageDetector(db)
    second.load()
    second.ingest(T0 + CYCLE_MS, cycle({ cloudflare: true, google: true, quad9: true }))

    const rows = db.select().from(outage).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cycles).toBe(2)
    expect(rows[0]?.startedAt).toBe(T0)
  })

  test('restart recovery: a fresh detector correctly closes an outage it did not open', () => {
    const db = createTestDb()
    const first = new OutageDetector(db)
    first.ingest(T0, cycle({ cloudflare: true, google: true, quad9: true }))

    const second = new OutageDetector(db)
    second.ingest(T0 + CYCLE_MS, cycle({})) // second detector lazily loads on first ingest

    const rows = db.select().from(outage).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.endedAt).toBe(T0 + CYCLE_MS)
  })

  test('a replayed (stale) cycle at or before the outage start is a no-op', () => {
    const db = createTestDb()
    const detector = new OutageDetector(db)

    detector.ingest(T0, cycle({ cloudflare: true, google: true, quad9: true }))
    detector.ingest(T0, cycle({ cloudflare: true, google: true, quad9: true })) // exact replay

    const rows = db.select().from(outage).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cycles).toBe(1)
  })

  test('a replay of an already-processed mid-outage cycle does not double-count', () => {
    const db = createTestDb()
    const detector = new OutageDetector(db)

    detector.ingest(T0, cycle({ cloudflare: true, google: true, quad9: true }))
    detector.ingest(T0 + CYCLE_MS, cycle({ cloudflare: true, google: true, quad9: true }))
    detector.ingest(T0 + CYCLE_MS, cycle({ cloudflare: true, google: true, quad9: true })) // spool replay of the same cycle

    const rows = db.select().from(outage).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cycles).toBe(2)
  })
})

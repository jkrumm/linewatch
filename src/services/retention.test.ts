import { describe, expect, test } from 'bun:test'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { createTestDb } from '../db/test-db.js'
import { event, outage, probeCycle, probeSample, speedTest } from '../db/schema.js'
import { Exporter } from '../export/exporter.js'
import type { Sink } from '../export/otlp.js'
import { MIN_RETENTION_DAYS, runRetention } from './retention.js'

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const sink: Sink = { send: async () => undefined }
const ctx = { scopeOf: () => 'wan' as const }

function seed() {
  const db = createTestDb()
  const old = NOW - 100 * DAY
  const recent = NOW - 10 * DAY
  for (const ts of [old, recent]) {
    db.insert(probeSample)
      .values({ ts, target: 'gateway', addr: 'a', sent: 20, received: 20, lossPct: 0 })
      .run()
    db.insert(probeCycle).values({ ts }).run()
    db.insert(event).values({ ts, kind: 'note', detail: '{}' }).run()
    db.insert(speedTest).values({ ts, backend: 'ookla', ok: true }).run()
    db.insert(outage).values({ scope: 'wan', startedAt: ts, evidence: '[]' }).run()
  }
  return db
}

const count = (db: ReturnType<typeof createTestDb>, table: SQLiteTable) =>
  db.select().from(table).all().length

describe('retention', () => {
  test('refuses before the backfill has finished', async () => {
    const db = seed()
    new Exporter(db, sink, ctx).ensureCursors()

    const result = await runRetention(db, { days: 90, now: NOW })

    expect(result.ran).toBe(false)
    expect(count(db, probeSample)).toBe(2)
  })

  test('refuses a window under the floor', async () => {
    const db = seed()
    const result = await runRetention(db, { days: MIN_RETENTION_DAYS - 1, now: NOW })
    expect(result.ran).toBe(false)
  })

  test('deletes old samples and cycles, keeps outages, events and speed tests', async () => {
    const db = seed()
    const exporter = new Exporter(db, sink, ctx)
    exporter.ensureCursors()
    await exporter.backfill({ delayMs: 0 })

    const result = await runRetention(db, { days: 90, now: NOW, pauseMs: 0 })

    expect(result).toMatchObject({ ran: true, deleted: { probe_sample: 1, probe_cycle: 1 } })
    expect(count(db, probeSample)).toBe(1)
    expect(count(db, probeCycle)).toBe(1)
    expect(count(db, event)).toBe(2)
    expect(count(db, speedTest)).toBe(2)
    expect(count(db, outage)).toBe(2)
  })

  test('keeps a row the live tail has not exported yet, however old', async () => {
    const db = seed()
    const exporter = new Exporter(db, sink, ctx)
    exporter.ensureCursors()
    await exporter.backfill({ delayMs: 0 })
    // An old row that arrives after the export started (a late spool replay) and has not been ticked.
    db.insert(probeSample)
      .values({
        ts: NOW - 120 * DAY,
        target: 'gateway',
        addr: 'a',
        sent: 20,
        received: 20,
        lossPct: 0,
      })
      .run()

    await runRetention(db, { days: 90, now: NOW, pauseMs: 0 })
    expect(count(db, probeSample)).toBe(2)

    await exporter.tick()
    await runRetention(db, { days: 90, now: NOW, pauseMs: 0 })
    expect(count(db, probeSample)).toBe(1)
  })
})

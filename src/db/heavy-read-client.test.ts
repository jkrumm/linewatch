import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { sql } from 'drizzle-orm'

process.env['LINEWATCH_DB'] = ':memory:'
// `bun test` shares one process, so whichever file loads `config` first fixes the token
// for every route test after it — set the one they all use.
process.env['LINEWATCH_TOKEN'] ??= 'test-token-not-the-real-one'

const { createHeavyReader } = await import('./heavy-read-client.js')
const schema = await import('./schema.js')

/**
 * The worker path, against a real file: the route tests run inline on `:memory:`,
 * which proves the reads and not that they leave the main thread.
 */
const dir = mkdtempSync(join(tmpdir(), 'linewatch-heavy-'))
const dbPath = join(dir, 'test.db')
const T0 = Date.UTC(2026, 6, 1)
const CYCLES = 60_000
const TO = T0 + CYCLES * 30_000

const sqlite = new Database(dbPath, { create: true })
sqlite.exec('PRAGMA journal_mode = WAL')
const writer = drizzle(sqlite, { schema })
migrate(writer, { migrationsFolder: join(import.meta.dir, '../../drizzle') })
writer.run(sql`
  WITH RECURSIVE k(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM k WHERE n < ${CYCLES - 1}),
  t(target) AS (VALUES ('gateway'), ('cloudflare'), ('google'), ('quad9'))
  INSERT INTO probe_sample (ts, target, addr, sent, received, loss_pct, min_ms, med_ms, max_ms, avg_ms)
  SELECT ${T0} + k.n * 30000, t.target, '0.0.0.0', 20, 20, 0, 4, 4 + (k.n % 7), 9, 5 FROM k, t
`)

afterAll(() => {
  sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('heavy reads leave the main thread', () => {
  const reader = createHeavyReader({ dbPath })
  const params = { from: T0, to: TO, probeCycleSeconds: 30, degradedLossPct: 20 }

  test('a worker read returns the same rows the connection itself would', async () => {
    const viaWorker = await reader.read('rangeSummary', params)
    const inline = await createHeavyReader({ inline: writer }).read('rangeSummary', params)
    expect(viaWorker.recordedCycles).toBe(CYCLES)
    expect(viaWorker).toEqual(inline)
  })

  test('the event loop keeps ticking while a long read runs', async () => {
    let ticks = 0
    const timer = setInterval(() => ticks++, 5)
    await reader.read('rangeSummary', params)
    clearInterval(timer)
    // On the main thread the whole read is one blocked stretch: zero or one tick.
    expect(ticks).toBeGreaterThan(5)
  })

  test('an identical in-flight read is shared, not run twice', async () => {
    const a = reader.read('rangeSummary', params)
    const b = reader.read('rangeSummary', params)
    expect(a).toBe(b)
    await a
  })

  test('an error in the worker rejects the caller and leaves the reader usable', async () => {
    const broken = createHeavyReader({ dbPath: join(dir, 'does-not-exist.db') })
    await expect(broken.read('rangeSummary', params)).rejects.toThrow()
    expect((await reader.read('rangeSummary', params)).recordedCycles).toBe(CYCLES)
  })
})

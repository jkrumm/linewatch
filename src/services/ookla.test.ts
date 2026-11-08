import { describe, expect, test } from 'bun:test'
import { createTestDb } from '../db/test-db.js'
import { speedTest } from '../db/schema.js'
import { runOoklaSpeedtest, type SpeedtestProcess } from './ookla.js'

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>
}

const RESULT = {
  ping: { latency: 5, jitter: 1 },
  download: { bandwidth: 12_500_000, latency: { iqm: 20 } },
  upload: { bandwidth: 2_500_000, latency: { iqm: 30 } },
  isp: 'Example ISP',
  interface: { externalIp: '203.0.113.7' },
  server: { id: 1, name: 'Example', location: 'Nowhere' },
  result: { url: 'https://example.com/result/1' },
}

describe('runOoklaSpeedtest', () => {
  test('records a successful run', async () => {
    const db = createTestDb()
    const proc: SpeedtestProcess = {
      stdout: stream(JSON.stringify(RESULT)),
      stderr: stream(''),
      exited: Promise.resolve(0),
      kill: () => {},
    }
    await runOoklaSpeedtest(db, { spawn: () => proc })

    const [row] = db.select().from(speedTest).all()
    expect(row?.ok).toBe(true)
    expect(row?.downloadMbps).toBe(100)
  })

  test('a hung CLI is killed at the deadline and recorded as a timeout', async () => {
    const db = createTestDb()
    const kills: number[] = []
    const proc: SpeedtestProcess = {
      stdout: new ReadableStream(), // never closes
      stderr: new ReadableStream(),
      exited: new Promise(() => {}), // never exits
      kill: (signal) => kills.push(signal),
    }

    await runOoklaSpeedtest(db, { spawn: () => proc, deadlineMs: 20 })

    expect(kills).toEqual([9])
    const rows = db.select().from(speedTest).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ok).toBe(false)
    expect(rows[0]?.error).toBe('timeout')
  })

  test('a non-zero exit is recorded with the CLI error', async () => {
    const db = createTestDb()
    const proc: SpeedtestProcess = {
      stdout: stream(''),
      stderr: stream('no route to host\n'),
      exited: Promise.resolve(1),
      kill: () => {},
    }
    await runOoklaSpeedtest(db, { spawn: () => proc })

    const [row] = db.select().from(speedTest).all()
    expect(row?.ok).toBe(false)
    expect(row?.error).toBe('no route to host')
  })
})

import { describe, expect, test } from 'bun:test'
import { FULL_INTENSITY_DEFICIT_PCT, speedCellRows, speedCells } from './speed-heatmap'
import type { SpeedTest } from '../lib/types'

const HOUR_MS = 3_600_000
const FROM = Date.UTC(2026, 5, 10, 12)
const TO = FROM + 24 * HOUR_MS - 1

const run = (hour: number, over: Partial<SpeedTest> = {}): SpeedTest => ({
  id: hour,
  ts: FROM + hour * HOUR_MS + 60_000,
  backend: 'ookla',
  ok: true,
  downloadMbps: 800,
  uploadMbps: 50,
  pingMs: 5,
  jitterMs: 1,
  latencyDownMs: 20,
  latencyUpMs: 30,
  packetLoss: 0,
  serverName: null,
  serverLocation: null,
  serverId: null,
  isp: null,
  externalIp: null,
  bytesDown: null,
  bytesUp: null,
  resultUrl: null,
  durationS: 10,
  error: null,
  ...over,
})

const cellAt = (cells: ReturnType<typeof speedCells>['cells'], hour: number) => {
  const target = cells.find((c) => c.hour?.bucket === Math.floor((FROM + hour * HOUR_MS) / HOUR_MS) * HOUR_MS)
  if (!target) throw new Error(`no cell for hour ${hour}`)
  return target
}

describe('speedCells — the three states', () => {
  const { cells, fastest } = speedCells(
    [
      run(1, { downloadMbps: 800 }),
      run(2, { downloadMbps: 400 }),
      run(3, { ok: false, downloadMbps: null, error: 'server unreachable' }),
    ],
    FROM,
    TO,
  )

  test('measured: a value on the ramp, relative to the fastest hour', () => {
    expect(fastest).toBe(800)
    expect(cellAt(cells, 1).deficitPct).toBe(0)
    expect(cellAt(cells, 2).deficitPct).toBe(50)
  })

  test('failed: a datum with no value — never a zero, never a slow reading', () => {
    const failed = cellAt(cells, 3)
    expect(failed.hour?.failures).toHaveLength(1)
    expect(failed.mean).toBeNull()
    expect(failed.deficitPct).toBeNull()
  })

  test('absent: a datum slot with no hour and no value, still hoverable', () => {
    const absent = cells.filter((c) => c.hour === null)
    expect(absent.length).toBe(24 - 3)
    expect(absent.every((c) => c.deficitPct === null)).toBe(true)
  })

  test('an ok run with no download figure is a failure, not a data point', () => {
    const { cells: only } = speedCells([run(1, { downloadMbps: null })], FROM, TO)
    expect(cellAt(only, 1).mean).toBeNull()
  })
})

describe('speedCellRows — the tooltip is what separates failed from absent', () => {
  const { cells } = speedCells(
    [run(1), run(3, { ok: false, downloadMbps: null, error: 'server unreachable' })],
    FROM,
    TO,
  )
  test('failed names the count and the stored reason', () => {
    const rows = speedCellRows(cellAt(cells, 3))
    expect(rows).toEqual([
      expect.objectContaining({ label: 'Failed runs', value: '1 — server unreachable' }),
    ])
  })
  test('absent says "No run"', () => {
    const absent = cells.find((c) => c.hour === null)!
    expect(speedCellRows(absent)).toEqual([
      expect.objectContaining({ label: 'No run', value: 'Not measured' }),
    ])
  })
})

test('a range longer than the cap is clamped to the trailing 30 days', () => {
  const { rows } = speedCells([], TO - 365 * 86_400_000, TO)
  expect(rows.length).toBeLessThanOrEqual(32)
})

test('a measured hour of 0 Mbps stays a value (deficit 0), not the absent fill', () => {
  const { cells } = speedCells([run(1, { downloadMbps: 0 })], FROM, TO)
  expect(cellAt(cells, 1).deficitPct).toBe(0)
})

test('full colour is a fixed deficit, not the data max', () => {
  expect(FULL_INTENSITY_DEFICIT_PCT).toBe(50)
})

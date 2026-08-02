import { describe, expect, test } from 'bun:test'
import { percentile, speedWindowStats } from './speed-stats'
import type { SpeedTest } from './types'

function run(fields: Partial<SpeedTest>): SpeedTest {
  return {
    id: 1,
    ts: 0,
    backend: 'ookla',
    ok: true,
    downloadMbps: 100,
    uploadMbps: 40,
    pingMs: 8,
    jitterMs: null,
    latencyDownMs: null,
    latencyUpMs: null,
    packetLoss: null,
    serverName: null,
    serverLocation: null,
    serverId: null,
    isp: null,
    externalIp: null,
    bytesDown: null,
    bytesUp: null,
    resultUrl: null,
    durationS: null,
    error: null,
    ...fields,
  }
}

describe('percentile', () => {
  test('an empty sample measured nothing, which is not zero', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([], 0.95)).toBeNull()
  })

  test('a single reading is every percentile of itself', () => {
    expect(percentile([42], 0.5)).toBe(42)
    expect(percentile([42], 0.95)).toBe(42)
  })

  test('p50 of an even sample is the midpoint of the two middle readings', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25)
  })

  test('interpolates between order statistics rather than snapping to one', () => {
    // R-7: rank = (n-1)·p = 3·0.95 = 2.85, so 85% of the way from 30 to 40.
    expect(percentile([10, 20, 30, 40], 0.95)).toBeCloseTo(38.5, 10)
  })

  test('does not mutate its input', () => {
    const values = [30, 10, 20]
    percentile(values, 0.5)
    expect(values).toEqual([30, 10, 20])
  })
})

describe('speedWindowStats', () => {
  test('a window with no runs reports null throughput, not zero', () => {
    expect(speedWindowStats([])).toEqual({
      download: { p50: null, p95: null },
      upload: { p50: null, p95: null },
      runs: 0,
      failed: 0,
    })
  })

  test('a failed run carries no throughput and is counted rather than scored as zero', () => {
    const stats = speedWindowStats([
      run({ ok: true, downloadMbps: 100, uploadMbps: 40 }),
      run({ ok: false, downloadMbps: null, uploadMbps: null, error: 'timeout' }),
      run({ ok: true, downloadMbps: 200, uploadMbps: 60 }),
    ])
    expect(stats.download.p50).toBe(150)
    expect(stats.upload.p50).toBe(50)
    expect(stats.runs).toBe(2)
    expect(stats.failed).toBe(1)
  })

  test('a successful run missing one direction still counts toward the other', () => {
    const stats = speedWindowStats([
      run({ ok: true, downloadMbps: 100, uploadMbps: null }),
      run({ ok: true, downloadMbps: 200, uploadMbps: 60 }),
    ])
    expect(stats.download.p50).toBe(150)
    expect(stats.upload.p50).toBe(60)
    // Both runs succeeded — `runs` is the window's successful-run count, not the count behind any
    // one percentile, and the two directions can legitimately differ underneath it.
    expect(stats.runs).toBe(2)
  })
})

import { describe, expect, test } from 'bun:test'
import { WAN_TARGETS, comparePointsFrom, median, toComparePoints } from './aggregate'
import type { ProbeBucket, TargetName } from './types'

function bucket(target: string, medianMs: number | null, lossPct = 0, bucketStart = 0): ProbeBucket {
  return {
    bucket: bucketStart,
    target,
    medianMs,
    p5Ms: medianMs,
    p95Ms: medianMs,
    minMs: medianMs,
    maxMs: medianMs,
    maxLossPct: lossPct,
    lossPct,
    downCycles: 0,
    count: 1,
  }
}

function slot(entries: ProbeBucket[] | null) {
  return {
    key: '2026-08-01T00:00:00.000Z',
    bucketStart: 0,
    value: entries === null ? null : new Map(entries.map((b) => [b.target, b])),
  }
}

describe('WAN_TARGETS', () => {
  test('is every target except the gateway', () => {
    expect([...WAN_TARGETS]).toEqual(['cloudflare', 'google', 'quad9'])
  })
})

describe('median', () => {
  test('an odd sample takes the middle reading', () => {
    expect(median([9, 5, 7])).toEqual({ value: 7, count: 3 })
  })

  test('an even sample takes the midpoint of the two middle readings', () => {
    expect(median([10, 6])).toEqual({ value: 8, count: 2 })
    expect(median([10, 5, 7, 4])).toEqual({ value: 6, count: 4 })
  })

  /** Parity is decided by how many anchors *answered*, not by how many were asked. */
  test('dropping a null makes an even sample odd', () => {
    expect(median([10, 5, null, 7])).toEqual({ value: 7, count: 3 })
  })

  /** The whole reason this is a median: one badly routed anchor must not move the figure. */
  test('one wild anchor does not drag the median the way a mean would', () => {
    expect(median([5, 6, 900]).value).toBe(6)
  })

  /**
   * The load-bearing case. A missing anchor counted as 0 would report a *faster* WAN for a bucket
   * that measured less of it — an absent measurement rendered as a good one, which is the exact
   * fabrication this codebase is built to refuse.
   */
  test('a missing anchor is skipped, never counted as zero', () => {
    expect(median([8, null, null])).toEqual({ value: 8, count: 1 })
    expect(median([8, 0, 0]).value).toBe(0)
  })

  test('no anchor at all is null, not zero', () => {
    expect(median([null, null, null])).toEqual({ value: null, count: 0 })
    expect(median([])).toEqual({ value: null, count: 0 })
  })
})

describe('toComparePoints', () => {
  test('splits the gateway from the median of the anchors', () => {
    const [point] = toComparePoints(
      [slot([bucket('gateway', 1.2), bucket('cloudflare', 5), bucket('google', 7), bucket('quad9', 9)])],
      300,
    )
    expect(point).toEqual({
      key: '2026-08-01T00:00:00.000Z',
      // Derived from `bucketStart` (epoch 0 in this fixture), not from `key` — the two are
      // deliberately different things, and the chart's x-axis reads this one.
      label: '01.01 00:00',
      bucketStart: 0,
      gatewayMs: 1.2,
      wanMs: 7,
      wanAnchors: 3,
      worstLossPct: 0,
    })
  })

  /** An unmeasured bucket stays unmeasured on both lines — the chart draws a gap, not a join. */
  test('an unmeasured slot yields nulls, not zeroes', () => {
    const [point] = toComparePoints([slot(null)], 300)
    expect(point?.gatewayMs).toBeNull()
    expect(point?.wanMs).toBeNull()
    expect(point?.wanAnchors).toBe(0)
  })

  test('a bucket the gateway missed still reports the WAN, and says how many anchors it had', () => {
    const [point] = toComparePoints([slot([bucket('cloudflare', 5), bucket('google', 7)])], 300)
    expect(point?.gatewayMs).toBeNull()
    expect(point?.wanMs).toBe(6)
    expect(point?.wanAnchors).toBe(2)
  })

  test('a target present but with no median contributes nothing rather than a zero', () => {
    const [point] = toComparePoints([slot([bucket('cloudflare', null), bucket('google', 7), bucket('quad9', 9)])], 300)
    expect(point?.wanMs).toBe(8)
    expect(point?.wanAnchors).toBe(2)
  })

  test('worst loss spans the gateway and the anchors alike', () => {
    const [point] = toComparePoints([slot([bucket('gateway', 1.2, 40), bucket('cloudflare', 5, 2)])], 300)
    expect(point?.worstLossPct).toBe(40)
  })

  test('preserves the slot axis one-for-one', () => {
    expect(toComparePoints([slot(null), slot([bucket('gateway', 1)]), slot(null)], 300)).toHaveLength(3)
  })
})

describe('comparePointsFrom', () => {
  const BUCKET_S = 60
  const MS = BUCKET_S * 1000
  const window = { from: 0, to: 2 * MS, bucketSeconds: BUCKET_S }

  function byTarget(entries: [TargetName, ProbeBucket[]][]) {
    return new Map<TargetName, readonly ProbeBucket[]>(entries)
  }

  test('merges the per-target responses onto the window axis', () => {
    const points = comparePointsFrom(
      byTarget([
        ['gateway', [bucket('gateway', 1.2, 0, 0), bucket('gateway', 1.4, 0, MS)]],
        ['cloudflare', [bucket('cloudflare', 5, 0, 0), bucket('cloudflare', 6, 0, MS)]],
        ['google', [bucket('google', 7, 0, 0)]],
        ['quad9', [bucket('quad9', 9, 0, 0)]],
      ]),
      window,
    )

    expect(points).toHaveLength(3)
    expect(points[0]).toMatchObject({ gatewayMs: 1.2, wanMs: 7, wanAnchors: 3 })
    // Only cloudflare reported here, so the WAN median is a one-anchor median and says so.
    expect(points[1]).toMatchObject({ gatewayMs: 1.4, wanMs: 6, wanAnchors: 1 })
    // Nothing at all reported for the last slot — a gap, not a zero.
    expect(points[2]).toMatchObject({ gatewayMs: null, wanMs: null, wanAnchors: 0 })
  })

  /** The axis comes from the window, so a response covering none of it is all gaps, never empty. */
  test('an empty response still spans the window', () => {
    const points = comparePointsFrom(byTarget([]), window)
    expect(points).toHaveLength(3)
    expect(points.every((p) => p.wanMs === null && p.gatewayMs === null)).toBe(true)
  })

  test('a row off the window grid is a contract violation, not a dropped measurement', () => {
    expect(() => comparePointsFrom(byTarget([['gateway', [bucket('gateway', 1, 0, 7)]]]), window)).toThrow()
  })
})

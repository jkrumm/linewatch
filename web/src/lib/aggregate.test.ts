import { describe, expect, test } from 'bun:test'
import { WAN_TARGETS, comparePointsFrom, foldInternetBuckets, median, toComparePoints } from './aggregate'
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

describe('foldInternetBuckets', () => {
  /** A full `ProbeBucket` with every folded field independently settable — the fold's whole job is
   * that different fields take different reductions, so a helper that ties them together (as
   * `bucket` above does) cannot test it. */
  function anchor(target: string, fields: Partial<ProbeBucket> & { bucket?: number } = {}): ProbeBucket {
    return {
      bucket: 0,
      target,
      medianMs: 10,
      p5Ms: 8,
      p95Ms: 20,
      minMs: 7,
      maxMs: 30,
      maxLossPct: 0,
      lossPct: 0,
      downCycles: 0,
      count: 10,
      ...fields,
    }
  }

  const map = (rows: ProbeBucket[]) =>
    new Map<TargetName, readonly ProbeBucket[]>(
      (['cloudflare', 'google', 'quad9'] as TargetName[]).map((t) => [t, rows.filter((r) => r.target === t)]),
    )

  test('the gateway is not an anchor and never reaches the fold', () => {
    const folded = foldInternetBuckets(
      new Map<TargetName, readonly ProbeBucket[]>([
        ['gateway', [anchor('gateway', { medianMs: 1 })]],
        ['cloudflare', [anchor('cloudflare', { medianMs: 10 })]],
      ]),
    )
    expect(folded).toHaveLength(1)
    expect(folded[0]!.anchors).toBe(1)
    expect(folded[0]!.medianMs).toBe(10)
  })

  test('latency percentiles take the median across anchors', () => {
    const folded = foldInternetBuckets(
      map([
        anchor('cloudflare', { medianMs: 10, p5Ms: 8, p95Ms: 20 }),
        anchor('google', { medianMs: 12, p5Ms: 9, p95Ms: 24 }),
        anchor('quad9', { medianMs: 90, p5Ms: 80, p95Ms: 200 }),
      ]),
    )
    expect(folded[0]!.medianMs).toBe(12)
    expect(folded[0]!.p5Ms).toBe(9)
    expect(folded[0]!.p95Ms).toBe(24)
  })

  test('an anchor that reported nothing is skipped, never counted as zero', () => {
    const folded = foldInternetBuckets(
      map([
        anchor('cloudflare', { medianMs: 10 }),
        anchor('google', { medianMs: null }),
        anchor('quad9', { medianMs: 12 }),
      ]),
    )
    // Median of {10, 12}, not of {0, 10, 12} — a null anchor read as 0 would report a faster
    // internet for a bucket that measured less of it.
    expect(folded[0]!.medianMs).toBe(11)
    expect(folded[0]!.anchors).toBe(3)
  })

  test('the envelope takes the extremes, not the middle of them', () => {
    const folded = foldInternetBuckets(
      map([
        anchor('cloudflare', { minMs: 7, maxMs: 30 }),
        anchor('google', { minMs: 5, maxMs: 40 }),
        anchor('quad9', { minMs: 9, maxMs: 900 }),
      ]),
    )
    // 900 ms is the only witness of a sub-cycle stall; a median across anchors would erase it.
    expect(folded[0]!.minMs).toBe(5)
    expect(folded[0]!.maxMs).toBe(900)
  })

  test('one dead anchor is not an internet outage, and is still reported', () => {
    const folded = foldInternetBuckets(
      map([
        anchor('cloudflare', { lossPct: 0 }),
        anchor('google', { lossPct: 100 }),
        anchor('quad9', { lossPct: 0 }),
      ]),
    )
    expect(folded[0]!.lossPct).toBe(0)
    expect(folded[0]!.worstAnchorLossPct).toBe(100)
  })

  test('loss on every anchor is internet loss', () => {
    const folded = foldInternetBuckets(
      map([
        anchor('cloudflare', { lossPct: 40 }),
        anchor('google', { lossPct: 50 }),
        anchor('quad9', { lossPct: 60 }),
      ]),
    )
    expect(folded[0]!.lossPct).toBe(50)
  })

  test('down cycles are only claimed when the rows prove them', () => {
    // Three anchors, ten cycles each, three down cycles each — which could be nine distinct
    // cycles. Taking the minimum would announce three cycles of total internet loss that may
    // never have happened.
    const disjoint = foldInternetBuckets(
      map([
        anchor('cloudflare', { downCycles: 3 }),
        anchor('google', { downCycles: 3 }),
        anchor('quad9', { downCycles: 3 }),
      ]),
    )
    expect(disjoint[0]!.downCycles).toBe(0)

    // Every anchor down for every cycle: the overlap is forced, and the fold says so.
    const total = foldInternetBuckets(
      map([
        anchor('cloudflare', { downCycles: 10 }),
        anchor('google', { downCycles: 10 }),
        anchor('quad9', { downCycles: 10 }),
      ]),
    )
    expect(total[0]!.downCycles).toBe(10)

    // Nine of ten on each: at least seven cycles must be common to all three.
    const overlapping = foldInternetBuckets(
      map([
        anchor('cloudflare', { downCycles: 9 }),
        anchor('google', { downCycles: 9 }),
        anchor('quad9', { downCycles: 9 }),
      ]),
    )
    expect(overlapping[0]!.downCycles).toBe(7)
  })

  test('buckets come out sorted, and a bucket no anchor reported is absent rather than empty', () => {
    const folded = foldInternetBuckets(
      map([
        anchor('cloudflare', { bucket: 600_000 }),
        anchor('google', { bucket: 0 }),
        anchor('quad9', { bucket: 600_000 }),
      ]),
    )
    expect(folded.map((b) => b.bucket)).toEqual([0, 600_000])
    expect(folded.map((b) => b.anchors)).toEqual([1, 2])
  })
})

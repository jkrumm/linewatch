import { describe, expect, test } from 'bun:test'
import {
  bucketLabel,
  COMPARABLE_COVERAGE,
  compareWindows,
  denseSparkline,
  downtimeTint,
  measuredFraction,
  windowDownloadMedian,
  windowWanMedian,
  worstBucketLoss,
  worstLossTint,
} from './kpi'
import type { LatencyComparePoint } from './aggregate'

function point(patch: Partial<LatencyComparePoint>): LatencyComparePoint {
  return { key: 'k', bucketStart: 0, gatewayMs: null, wanMs: null, wanAnchors: 0, worstLossPct: 0, ...patch }
}

describe('denseSparkline', () => {
  test('passes a fully measured series through', () => {
    expect(denseSparkline([1, 2, 3])).toEqual([1, 2, 3])
  })

  /**
   * The load-bearing case. Dropping the null would draw a three-point trend labelled as spanning
   * four buckets; zero-filling it would draw a clean bucket where none was measured.
   */
  test('withholds the whole series when any bucket is missing', () => {
    expect(denseSparkline([1, null, 3, 4])).toBeNull()
    expect(denseSparkline([null])).toBeNull()
  })

  test('an empty window draws nothing rather than an empty line', () => {
    expect(denseSparkline([])).toBeNull()
  })

  test('a measured zero is a value, not a hole', () => {
    expect(denseSparkline([0, 0])).toEqual([0, 0])
  })
})

describe('windowWanMedian', () => {
  test('takes the median across the buckets that have one', () => {
    expect(windowWanMedian([point({ wanMs: 5 }), point({ wanMs: 9 }), point({ wanMs: 7 })])).toBe(7)
  })

  test('unmeasured buckets do not pull it toward zero', () => {
    expect(windowWanMedian([point({ wanMs: 8 }), point({}), point({})])).toBe(8)
  })

  test('nothing measured is null, not zero', () => {
    expect(windowWanMedian([point({}), point({})])).toBeNull()
    expect(windowWanMedian([])).toBeNull()
  })
})

describe('worstBucketLoss', () => {
  test('is the worst single bucket, not an average', () => {
    expect(
      worstBucketLoss([
        point({ wanAnchors: 3, worstLossPct: 0 }),
        point({ wanAnchors: 3, worstLossPct: 42 }),
        point({ wanAnchors: 3, worstLossPct: 1 }),
      ]),
    ).toBe(42)
  })

  test('a measured, clean window is 0', () => {
    expect(worstBucketLoss([point({ wanAnchors: 3 }), point({ gatewayMs: 1.2 })])).toBe(0)
  })

  /** 0 means "measured, no loss". null means "nothing was measured". Never the same answer. */
  test('an unmeasured window is null, not a clean zero', () => {
    expect(worstBucketLoss([point({}), point({})])).toBeNull()
    expect(worstBucketLoss([])).toBeNull()
  })

  test('a bucket the gateway alone reported still counts as measured', () => {
    expect(worstBucketLoss([point({ gatewayMs: 1.2, worstLossPct: 5 }), point({})])).toBe(5)
  })
})

describe('bucketLabel', () => {
  /** Noun phrases, and correctly pluralised — the card reads "Worst 4 hours", so "4-hour" would
   * put a grammatical error in the one label this rewrite exists to make readable. */
  test('names every bucket size the app actually produces', () => {
    expect(bucketLabel(60)).toBe('1 minute')
    expect(bucketLabel(300)).toBe('5 minutes')
    expect(bucketLabel(3_600)).toBe('1 hour')
    expect(bucketLabel(14_400)).toBe('4 hours')
    expect(bucketLabel(86_400)).toBe('1 day')
  })

  /** The load-bearing case: an unlisted size must state its raw seconds, never round to a
   * neighbouring label and claim a duration that was never measured. */
  test('falls back to the raw seconds for an unlisted size', () => {
    expect(bucketLabel(120)).toBe('120s')
  })
})

describe('worstLossTint', () => {
  test('a null reading is never tinted', () => {
    expect(worstLossTint(null)).toBeUndefined()
  })

  test('clean and mild loss stay untinted', () => {
    expect(worstLossTint(0)).toBeUndefined()
    expect(worstLossTint(1)).toBeUndefined()
  })

  test('warns above the noticeable threshold, alarms above the severe one', () => {
    expect(worstLossTint(1.1)).toBe('warn')
    expect(worstLossTint(5)).toBe('warn')
    expect(worstLossTint(5.1)).toBe('bad')
  })
})

describe('downtimeTint', () => {
  test('a clean window with nothing open is untinted', () => {
    expect(downtimeTint({ seconds: 0, openCount: 0 })).toBeUndefined()
  })

  test('any accrued downtime tints bad', () => {
    expect(downtimeTint({ seconds: 1, openCount: 0 })).toBe('bad')
  })

  test('a still-open outage tints bad even before it has accrued a second', () => {
    expect(downtimeTint({ seconds: 0, openCount: 1 })).toBe('bad')
  })
})

describe('windowDownloadMedian', () => {
  test('takes the median of the runs that reported throughput', () => {
    expect(windowDownloadMedian([{ downloadMbps: 100 }, { downloadMbps: 300 }, { downloadMbps: 200 }])).toBe(200)
  })

  /** A failed run has no throughput. Counting it as 0 would report a slower line for a window that
   * measured less of it — the same fabrication `median` refuses everywhere else. */
  test('skips a failed run rather than counting it as zero', () => {
    expect(windowDownloadMedian([{ downloadMbps: 100 }, { downloadMbps: null }, { downloadMbps: 300 }])).toBe(200)
  })

  test('no successful run is null, not zero', () => {
    expect(windowDownloadMedian([{ downloadMbps: null }])).toBeNull()
    expect(windowDownloadMedian([])).toBeNull()
  })
})

describe('measuredFraction', () => {
  test('counts a bucket as measured when either side reported', () => {
    expect(
      measuredFraction([point({ gatewayMs: 1 }), point({ wanAnchors: 2, wanMs: 5 }), point({}), point({})]),
    ).toBe(0.5)
  })

  /** An empty window measured nothing, which must read as 0 and not as a division by zero — every
   * comparison is gated on this number, and NaN compares false against every threshold. */
  test('an empty window is zero, not NaN', () => {
    expect(measuredFraction([])).toBe(0)
  })
})

describe('compareWindows', () => {
  const covered = { currentCoverage: 1, previousCoverage: 1 }
  const mbps = (v: number) => `${v.toFixed(1)} Mbps`

  test('signs the label by arithmetic and the tone by goodness, and they disagree on up-is-bad', () => {
    const worse = compareWindows({ current: 20, previous: 12, direction: 'up-is-bad', format: mbps, ...covered })
    expect(worse?.label).toBe('+8.0 Mbps')
    expect(worse?.tone).toBeLessThan(0)

    const better = compareWindows({ current: 20, previous: 12, direction: 'up-is-good', format: mbps, ...covered })
    expect(better?.label).toBe('+8.0 Mbps')
    expect(better?.tone).toBeGreaterThan(0)
  })

  test('a fall on an up-is-bad metric is an improvement', () => {
    const d = compareWindows({ current: 5, previous: 9, direction: 'up-is-bad', format: mbps, ...covered })
    expect(d?.label).toBe('−4.0 Mbps')
    expect(d?.tone).toBeGreaterThan(0)
  })

  test('an unchanged figure says so rather than rendering a signed zero', () => {
    expect(compareWindows({ current: 7, previous: 7, direction: 'up-is-good', format: mbps, ...covered })).toEqual({
      tone: 0,
      label: 'no change',
    })
  })

  /** Nothing measured on either side is not a change of zero. */
  test('withholds the comparison when either side is absent', () => {
    expect(compareWindows({ current: null, previous: 7, direction: 'up-is-good', format: mbps, ...covered })).toBeNull()
    expect(compareWindows({ current: 7, previous: null, direction: 'up-is-good', format: mbps, ...covered })).toBeNull()
  })

  /**
   * The load-bearing case, and this project's central failure mode wearing a green badge: a
   * preceding window the collector barely watched reports almost no downtime, so a delta against it
   * announces a collapse that is really an outage in the *record*, not in the line.
   */
  test('withholds the comparison when either window is too sparsely measured', () => {
    const thin = COMPARABLE_COVERAGE - 0.01
    expect(
      compareWindows({ current: 20, previous: 1, direction: 'up-is-bad', format: mbps, currentCoverage: 1, previousCoverage: thin }),
    ).toBeNull()
    expect(
      compareWindows({ current: 20, previous: 1, direction: 'up-is-bad', format: mbps, currentCoverage: thin, previousCoverage: 1 }),
    ).toBeNull()
  })

  test('a window measured exactly at the threshold still compares', () => {
    expect(
      compareWindows({
        current: 20,
        previous: 12,
        direction: 'up-is-good',
        format: mbps,
        currentCoverage: COMPARABLE_COVERAGE,
        previousCoverage: COMPARABLE_COVERAGE,
      }),
    ).not.toBeNull()
  })
})

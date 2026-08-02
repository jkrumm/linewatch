import { describe, expect, test } from 'bun:test'
import { densifyBuckets } from './densify'
import { rangeToBucket, rangeToWindow, RANGE_OPTIONS, type RangeOption } from './range'

/**
 * `src/db/bucket-probes.ts`'s grouping key, restated. SQLite's `/` on two integers is integer
 * division, which for the non-negative unix-ms timestamps this table holds is `Math.floor`. Every
 * assertion below compares against THIS, not against a re-derivation of the implementation — an
 * off-by-one between the two marks real buckets as absent, which is worse than shifting the axis.
 */
function sqlBucketStart(ts: number, bucketSeconds: number): number {
  const bucketMs = Math.max(1, Math.round(bucketSeconds * 1000))
  return Math.floor(ts / bucketMs) * bucketMs
}

/** The measured hole this whole item exists for: 2026-07-30 11:20:51 UTC, 3480 s long. At the 7d
 * view's 3600 s bucket the live API returns the 10:00 and 11:00 buckets and **no 12:00 bucket at
 * all** — the two neighbours are adjacent in the array and a smoothing curve joins them. */
const HOLE_FROM = Date.UTC(2026, 6, 30, 9, 30, 0)
const HOLE_TO = Date.UTC(2026, 6, 30, 14, 0, 0)
const HOUR_MS = 3_600_000

/** A response shaped like the live one over that window: the 12:00 bucket is missing, not zeroed.
 * Latency numbers are this line's real order of magnitude (4.18 ms baseline to 1.1.1.1). */
const LIVE_SHAPED_BUCKETS = [
  Date.UTC(2026, 6, 30, 9, 0, 0),
  Date.UTC(2026, 6, 30, 10, 0, 0),
  Date.UTC(2026, 6, 30, 11, 0, 0),
  // 12:00 absent — the collector was not running.
  Date.UTC(2026, 6, 30, 13, 0, 0),
  Date.UTC(2026, 6, 30, 14, 0, 0),
].map((bucket) => ({ bucket, target: 'cloudflare', medianMs: 4.2, count: 120 }))

describe('densifyBuckets slot starts', () => {
  test('lands every slot on the SQL grouping key, for every bucket size the dashboard uses', () => {
    // 60 / 300 / 3600 / 14400 / 86400 — RANGE_BUCKET's full set, well past the three required.
    for (const range of RANGE_OPTIONS) {
      const bucketSeconds = rangeToBucket(range)
      const { from, to } = rangeToWindow(range, Date.UTC(2026, 6, 30, 14, 37, 11))
      const slots = densifyBuckets([], { from, to, bucketSeconds })

      for (const slot of slots) {
        expect(slot.bucketStart).toBe(sqlBucketStart(slot.bucketStart, bucketSeconds))
        // Any timestamp inside the slot must group back onto it — the property the server's
        // `WHERE ts >= from AND ts <= to` + `GROUP BY (ts/bucketMs)*bucketMs` relies on.
        expect(sqlBucketStart(slot.bucketStart + bucketSeconds * 1000 - 1, bucketSeconds)).toBe(
          slot.bucketStart,
        )
        expect(new Date(slot.bucketStart).toISOString()).toBe(slot.key)
      }
    }
  })

  test('aligns the first slot to the epoch, not to `from`', () => {
    // `from` deliberately 17 s into an hour. Aligning to `from` would shift the whole axis and
    // leave every epoch-aligned bucket the server returns unmatched.
    const from = Date.UTC(2026, 6, 30, 9, 0, 17)
    const slots = densifyBuckets([], { from, to: from + 2 * HOUR_MS, bucketSeconds: 3_600 })
    expect(slots[0]?.bucketStart).toBe(Date.UTC(2026, 6, 30, 9, 0, 0))
    expect(slots[0]?.bucketStart).toBeLessThan(from)
    expect(slots[1]?.bucketStart).toBe(Date.UTC(2026, 6, 30, 10, 0, 0))
  })

  test('steps by exactly one bucket and covers both endpoints inclusively', () => {
    for (const range of RANGE_OPTIONS) {
      const bucketSeconds = rangeToBucket(range)
      const { from, to } = rangeToWindow(range, Date.UTC(2026, 6, 30, 14, 37, 11))
      const slots = densifyBuckets([], { from, to, bucketSeconds })

      // Both bounds are inclusive server-side (`ts >= from AND ts <= to`), so a span of N buckets
      // yields N+1 slots.
      expect(slots.length).toBe((to - from) / (bucketSeconds * 1_000) + 1)
      for (let i = 1; i < slots.length; i++) {
        expect((slots[i]?.bucketStart ?? 0) - (slots[i - 1]?.bucketStart ?? 0)).toBe(
          bucketSeconds * 1_000,
        )
      }
    }
  })

  test('stays inside the point budget lib/range.ts sizes the buckets for', () => {
    const expectedSlots: Record<RangeOption, number> = {
      '1h': 61,
      '24h': 289,
      '7d': 169,
      '30d': 181,
      all: 366,
    }
    for (const range of RANGE_OPTIONS) {
      const { from, to } = rangeToWindow(range, Date.UTC(2026, 6, 30, 14, 37, 11))
      const slots = densifyBuckets([], { from, to, bucketSeconds: rangeToBucket(range) })
      expect(slots.length).toBe(expectedSlots[range])
    }
  })
})

describe('densifyBuckets against a live-shaped /api/probes response', () => {
  test('matches every returned bucket to a slot — a miss fails rather than being dropped', () => {
    const slots = densifyBuckets(LIVE_SHAPED_BUCKETS, {
      from: HOLE_FROM,
      to: HOLE_TO,
      bucketSeconds: 3_600,
    })
    const byStart = new Map(slots.map((s) => [s.bucketStart, s]))

    for (const row of LIVE_SHAPED_BUCKETS) {
      const slot = byStart.get(row.bucket)
      expect(slot).toBeDefined()
      expect(slot?.value).toBe(row)
      expect(slot?.key).toBe(new Date(row.bucket).toISOString())
    }
    expect(slots.filter((s) => s.value !== null).length).toBe(LIVE_SHAPED_BUCKETS.length)
  })

  test('renders the 2026-07-30 11:20:51 UTC hole as a slot with no value', () => {
    const slots = densifyBuckets(LIVE_SHAPED_BUCKETS, {
      from: HOLE_FROM,
      to: HOLE_TO,
      bucketSeconds: 3_600,
    })
    const hole = slots.find((s) => s.bucketStart === Date.UTC(2026, 6, 30, 12, 0, 0))
    expect(hole).toBeDefined()
    expect(hole?.value).toBeNull()

    // …and it sits BETWEEN its neighbours, which is the entire point: in the raw response the
    // 11:00 and 13:00 buckets are adjacent array entries.
    const index = slots.indexOf(hole!)
    expect(slots[index - 1]?.bucketStart).toBe(Date.UTC(2026, 6, 30, 11, 0, 0))
    expect(slots[index + 1]?.bucketStart).toBe(Date.UTC(2026, 6, 30, 13, 0, 0))
  })

  test('reports an entirely empty response as a full window of unmeasured slots', () => {
    const slots = densifyBuckets([], { from: HOLE_FROM, to: HOLE_TO, bucketSeconds: 3_600 })
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((s) => s.value === null)).toBe(true)
  })
})

describe('densifyBuckets contract violations', () => {
  /**
   * The split this function's docblock draws, pinned from both sides. A row that lands on no slot
   * used to throw whichever reason it had, and one of the two reasons is routine: a placeholder
   * from a window one step earlier (see the `keepAcrossTimeAdvance` case below).
   */
  test('throws on a bucket start inside the window but off the grid', () => {
    expect(() =>
      densifyBuckets([{ bucket: Date.UTC(2026, 6, 30, 11, 30, 0) }], {
        from: HOLE_FROM,
        to: HOLE_TO,
        bucketSeconds: 3_600,
      }),
    ).toThrow(/off the 3600 s grid/)
  })

  test('skips an on-grid row outside the window rather than throwing', () => {
    const slots = densifyBuckets([{ bucket: HOLE_TO + HOUR_MS }], {
      from: HOLE_FROM,
      to: HOLE_TO,
      bucketSeconds: 3_600,
    })
    // The window is still fully densified, and the stray row simply is not in it.
    expect(slots.every((s) => s.value === null)).toBe(true)
    expect(slots.some((s) => s.bucketStart === HOLE_TO + HOUR_MS)).toBe(false)
  })

  /**
   * The live failure this split exists for, in the shape that produced it.
   *
   * `keepAcrossTimeAdvance` serves the previous window's answer under the new key when the window
   * steps forward — span-identical, shifted by one bucket — so the oldest row falls before the new
   * `first`. On the 24 h range that is one 5-minute step, and it took the whole page down with
   * `1 of 288 rows landed on no slot` every five minutes. A placeholder that had been chaining for
   * an hour threw `13 of 288`; the reported window is this one.
   */
  test('a placeholder from one step earlier densifies instead of throwing', () => {
    const bucketMs = 300_000
    const to = 1_785_684_600_000
    const from = to - 86_400_000
    // Every bucket of the PREVIOUS window, measured — the shape a real response has.
    const previousWindow = Array.from({ length: 289 }, (_, i) => ({
      bucket: from - bucketMs + i * bucketMs,
    }))

    const slots = densifyBuckets(previousWindow, { from, to, bucketSeconds: 300 })

    expect(slots).toHaveLength(289)
    // Everything the two windows share is drawn...
    expect(slots.slice(0, -1).every((s) => s.value !== null)).toBe(true)
    // ...and only the newest slot, which the placeholder cannot know about yet, is empty. That one
    // null is the accepted cost of the placeholder: it renders "not measured" for well under a
    // second, until the real fetch lands.
    expect(slots.at(-1)?.value).toBeNull()
  })

  test('throws when two rows share one bucket start', () => {
    expect(() =>
      densifyBuckets([{ bucket: HOLE_FROM }, { bucket: HOLE_FROM }], {
        from: HOLE_FROM,
        to: HOLE_TO,
        bucketSeconds: 3_600,
      }),
    ).toThrow(/share one bucket/)
  })

  test('throws rather than building an unbounded axis', () => {
    expect(() => densifyBuckets([], { from: 0, to: HOLE_TO, bucketSeconds: 60 })).toThrow(
      /over the 5000 cap/,
    )
  })

  test('returns nothing when the window is inverted', () => {
    expect(densifyBuckets([], { from: HOLE_TO, to: HOLE_FROM, bucketSeconds: 3_600 })).toEqual([])
  })
})

describe('the windows the dashboard actually densifies', () => {
  // The cap is a real edge, not a theoretical one: the Speed view's `all` range is 365 days and its
  // heatmap buckets hourly, which is 8 761 slots. That combination has to be clamped by its caller
  // (`speed-heatmap.tsx`'s MAX_DAYS), and this test is what fails if the clamp is ever removed.
  const NOW = Date.UTC(2026, 6, 30, 14, 37, 11)

  test('the Latency view densifies every range without tripping the cap', () => {
    for (const range of RANGE_OPTIONS) {
      const { from, to } = rangeToWindow(range, NOW)
      expect(() => densifyBuckets([], { from, to, bucketSeconds: rangeToBucket(range) })).not.toThrow()
    }
  })

  test('a 30-day hourly grid fits, a 365-day one does not', () => {
    const { to } = rangeToWindow('30d', NOW)
    const DAY_MS = 86_400_000
    expect(densifyBuckets([], { from: to - 30 * DAY_MS, to, bucketSeconds: 3_600 }).length).toBe(721)
    expect(() => densifyBuckets([], { from: to - 365 * DAY_MS, to, bucketSeconds: 3_600 })).toThrow(
      /over the 5000 cap/,
    )
  })
})

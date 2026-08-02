import { describe, expect, test } from 'bun:test'
import {
  AXIS_LABEL_PX,
  axisTickValues,
  bucketAxisLabel,
  bucketTickFormat,
  fitTickCount,
  runAxisLabels,
} from './axis'

// Built from LOCAL components, not `Date.UTC`. These labels are the host's wall clock now, so an
// instant pinned in UTC would render differently on every machine the suite runs on; pinning the
// local components instead makes the expected string the same everywhere and still exercises the
// real conversion (a formatter that had stayed on UTC renders these an offset away).
const JUL_31_2026_2305 = new Date(2026, 6, 31, 23, 5).getTime()

describe('bucketAxisLabel', () => {
  test('a sub-day bucket carries its date and its clock time', () => {
    expect(bucketAxisLabel(JUL_31_2026_2305, 300)).toBe('31.07 23:05')
  })

  test('a daily bucket carries the date and a two-digit year', () => {
    expect(bucketAxisLabel(JUL_31_2026_2305, 86_400)).toBe('31.07.26')
  })

  /**
   * The bug this year suffix exists for, and the reason the distinctness test below starts in
   * August rather than January. The `all` range is 365 days, so a window opened on 1 August ends
   * on 1 August: without the year both endpoints render `01.08`. The original test started on 1
   * January, where 365 daily buckets never wrap, and passed while the dashboard was visibly
   * stacking two ticks at one x.
   *
   * The *consequence* changed with basalt-ui 1.9.0 and the tests below are kept anyway. When the
   * label was also the scale's domain value, a collision dropped a measurement. Now the domain is
   * the bucket's ISO start and a collision drops nothing — it just prints one date for two
   * readings a year apart, which a reader cannot disambiguate. Silent data loss became a legibility
   * bug; neither is acceptable, and the format that fixes both is the same one.
   */
  test('a year-long daily window does not repeat a label at its two ends', () => {
    const aug1 = Date.UTC(2025, 7, 1)
    expect(bucketAxisLabel(aug1, 86_400)).not.toBe(bucketAxisLabel(aug1 + 365 * 86_400_000, 86_400))
  })

  /** The host's wall clock, matching `fmtClock`/`fmtDateTime`. A tick and the tooltip that opens
   * over it must not be read against two different clocks; both are the reader's own now. */
  test('is the host timezone, not UTC', () => {
    expect(bucketAxisLabel(new Date(2026, 0, 1, 0, 30).getTime(), 3_600)).toBe('01.01 00:30')
    expect(bucketAxisLabel(new Date(2026, 0, 1, 23, 30).getTime(), 3_600)).toBe('01.01 23:30')
    // Both endpoints sit within an hour of midnight, so on any host off UTC a `getUTC*` regression
    // moves them to a different DATE, not merely a different hour — which is what makes these two
    // assertions a real guard rather than a restatement of the formatter.
  })

  test('pads single-digit dates and times', () => {
    expect(bucketAxisLabel(new Date(2026, 7, 3, 4, 7).getTime(), 60)).toBe('03.08 04:07')
  })

  /**
   * Every bucket in a full window reads differently from every other. `HH:MM` alone would fail
   * this: a 24 h window contains each clock time twice at its two ends.
   *
   * This was the load-bearing property back when the label doubled as the band scale's key — two
   * buckets sharing one collapsed onto a single x position and one stopped being drawn. It is now
   * a legibility property (see the year-suffix test above), which is why it survives the
   * decoupling rather than moving to `key`: `throughput.test.ts` asserts uniqueness of the scale
   * key separately, on the field that is actually the key.
   */
  test.each([
    ['5-minute buckets over 24h', 300, 288],
    ['1-hour buckets over 7d', 3_600, 168],
    ['4-hour buckets over 30d', 14_400, 180],
    ['1-day buckets over a year', 86_400, 365],
  ])('every bucket in a full window gets a distinct label — %s', (_label, bucketSeconds, count) => {
    // Deliberately mid-year, not 1 January: a year of daily buckets starting in January never wraps
    // its DD.MM, so a January start made this assertion pass against a label that collided in
    // production. The window has to straddle a year boundary for this test to mean anything.
    const start = Date.UTC(2025, 7, 1)
    const labels = Array.from({ length: count }, (_, i) => bucketAxisLabel(start + i * bucketSeconds * 1000, bucketSeconds))
    expect(new Set(labels).size).toBe(count)
  })

  /**
   * The bridge the four bucketed charts actually pass to `AxisBottomDate`: it takes the scale's
   * domain value (an ISO bucket start, straight out of `densifyBuckets`) and returns the label.
   * Pinning it matters because the two halves are now separately owned — a chart could hold a
   * perfectly good ISO domain and still print `Invalid Date` across its axis if the parse and the
   * emitter ever disagreed about the format, and nothing else in the suite would notice.
   */
  test('bucketTickFormat renders a densified ISO key as its bucket label', () => {
    const iso = new Date(JUL_31_2026_2305).toISOString()
    expect(bucketTickFormat(300)(iso)).toBe('31.07 23:05')
    expect(bucketTickFormat(86_400)(iso)).toBe('31.07.26')
  })

  /** The exact failure the date prefix prevents, stated directly. */
  test('the two ends of a 24h window do not collide', () => {
    const start = Date.UTC(2026, 6, 31, 12, 0)
    expect(bucketAxisLabel(start, 300)).not.toBe(bucketAxisLabel(start + 86_400_000, 300))
  })
})

describe('axisTickValues', () => {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i)

  test('returns every value when they all fit', () => {
    expect(axisTickValues(range(5), 1000)).toEqual([0, 1, 2, 3, 4])
  })

  test('an empty axis has no ticks', () => {
    expect(axisTickValues([], 1000)).toEqual([])
  })

  /**
   * The measured failure this exists to fix: 288 five-minute buckets on a 1130px axis produced 24
   * ticks at ~58px spacing while each label needs ~96px, so 23 of the 24 overlapped a neighbour.
   */
  test('never places two ticks closer than one label width', () => {
    const width = 1130
    const values = range(288)
    const ticks = axisTickValues(values, width)
    const pxPerValue = width / values.length
    for (let i = 1; i < ticks.length; i++) {
      expect((ticks[i]! - ticks[i - 1]!) * pxPerValue).toBeGreaterThanOrEqual(AXIS_LABEL_PX)
    }
  })

  /** `smartTicks` appends the final value unconditionally, which is what collided at the right
   * edge — the last two labels landed 10px apart. Dropping it is the lesser harm. */
  test('drops a final tick that would crowd the one before it', () => {
    const values = range(10)
    // 10 values over 300px = 30px each; a 96px minimum allows a tick every 4th value at most.
    const ticks = axisTickValues(values, 300)
    const pxPerValue = 300 / 10
    const gap = (ticks[ticks.length - 1]! - ticks[ticks.length - 2]!) * pxPerValue
    expect(gap).toBeGreaterThanOrEqual(96)
  })

  test('keeps a final tick that clears the previous one', () => {
    // 9 values over 900px = 100px each, already above the minimum, so nothing is dropped.
    expect(axisTickValues(range(9), 900)).toEqual(range(9))
  })

  test('always yields at least two ticks even on a very narrow axis', () => {
    expect(axisTickValues(range(100), 10).length).toBeGreaterThanOrEqual(2)
  })

  test('ticks are a subsequence of the input, in order', () => {
    const ticks = axisTickValues(range(200), 800)
    expect(ticks).toEqual(ticks.toSorted((a, b) => a - b))
    expect(new Set(ticks).size).toBe(ticks.length)
  })
})

describe('fitTickCount', () => {
  /** Mirrors basalt's `smartTicksEvery`, which is what `MultiLine` uses internally. */
  function smartTicksEvery(n: number, count: number): number[] {
    const all = Array.from({ length: n }, (_, i) => i)
    if (n <= count) return all
    const step = Math.ceil(n / count)
    return all.filter((i) => i % step === 0 || i === n - 1)
  }

  const WIDTH = 1130

  /**
   * The measured failure: 288 buckets at 11 ticks left the appended final index a partial step from
   * its neighbour, printing `01.08 14:05` and `01.08 15:20` on top of each other at the right edge.
   */
  test.each([288, 287, 200, 169, 100, 61, 47])('the final label clears its neighbour — %i values', (n) => {
    const ticks = smartTicksEvery(n, fitTickCount(n, 11, WIDTH))
    const gapPx = (ticks[ticks.length - 1]! - ticks[ticks.length - 2]!) * (WIDTH / n)
    expect(gapPx).toBeGreaterThanOrEqual(AXIS_LABEL_PX)
  })

  test('stays within the requested ceiling and never drops below two', () => {
    for (let n = 3; n < 400; n++) {
      const count = fitTickCount(n, 11, WIDTH)
      expect(count).toBeLessThanOrEqual(11)
      expect(count).toBeGreaterThanOrEqual(2)
    }
  })

  test('a series that already fits keeps the ceiling', () => {
    expect(fitTickCount(5, 11, WIDTH)).toBe(11)
  })

  /** No count can help on a very narrow axis; thinning to two ticks would be worse than one
   * crowded label, so the ceiling is returned rather than the axis being gutted. */
  test('falls back to the ceiling when nothing clears', () => {
    expect(fitTickCount(300, 11, 120)).toBe(11)
  })
})

describe('runAxisLabels', () => {
  /** Local components, for the reason `JUL_31_2026_2305` gives — the labels are the host's wall
   * clock, so a UTC-pinned instant would render differently per machine. */
  const at = (h: number, m: number, s = 0) => new Date(2026, 7, 1, h, m, s).getTime()

  test('labels a run to the minute, on the host clock', () => {
    expect(runAxisLabels([at(14, 3, 41)])).toEqual(['01.08 14:03'])
  })

  test('is index-aligned with its input and preserves order', () => {
    const labels = runAxisLabels([at(14, 3), at(9, 0)])
    expect(labels).toEqual(['01.08 14:03', '01.08 09:00'])
  })

  test('breaks a same-minute collision on every member of the group, not only the later one', () => {
    // A label doubles as the categorical scale's key: two runs sharing one would collapse onto a
    // single x position and one of them would stop being drawn.
    const labels = runAxisLabels([at(14, 3, 7), at(14, 3, 41)])
    expect(labels).toEqual(['01.08 14:03:07', '01.08 14:03:41'])
    expect(new Set(labels).size).toBe(2)
  })

  /**
   * The collision local labels introduced, and the reason seconds are no longer the last resort.
   *
   * On the autumn fall-back the wall clock repeats an hour, so two runs 3600 s apart agree down to
   * the second and the seconds tiebreak hands them one identical key — the silently-dropped
   * measurement this function exists to prevent, moved from "twice in a minute" to "once a year".
   *
   * Constructed in UTC deliberately: the two instants have to straddle a real transition, which is
   * a property of the zone the suite runs in. Skipped where there is none (a UTC host, or one whose
   * zone does not observe DST) rather than asserted vacuously.
   */
  test('breaks a repeated wall-clock hour with the UTC offset', () => {
    const first = Date.UTC(2026, 9, 25, 0, 30)
    const second = first + 3_600_000
    if (new Date(first).getTimezoneOffset() === new Date(second).getTimezoneOffset()) return

    const labels = runAxisLabels([first, second])
    expect(new Set(labels).size).toBe(2)
    expect(labels.every((l) => l.includes('UTC'))).toBe(true)
  })

  test('leaves uncolliding labels at minute precision while a colliding pair gains seconds', () => {
    // Mixed precision across the axis is the cost of not dropping a point; mixed precision *within*
    // a colliding pair would read as a difference in the measurement, which is why the whole group
    // is disambiguated together.
    const labels = runAxisLabels([at(9, 0), at(14, 3, 7), at(14, 3, 41)])
    expect(labels).toEqual(['01.08 09:00', '01.08 14:03:07', '01.08 14:03:41'])
  })

  test('an empty series has no labels', () => {
    expect(runAxisLabels([])).toEqual([])
  })
})

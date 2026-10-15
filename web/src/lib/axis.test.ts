import { describe, expect, test } from 'bun:test'
import {
  bucketAxisLabel,
  bucketTickFormat,
  runTickFormat,
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
    const labels = Array.from({ length: count }, (_, i) =>
      bucketAxisLabel(start + i * bucketSeconds * 1000, bucketSeconds),
    )
    expect(new Set(labels).size).toBe(count)
  })

  /**
   * The bridge the bucketed charts pass as `formatX`: it takes the x value (the bucket's start as a
   * `Date`, the instant a chart keys on) and returns the label. Pinning it matters because a chart
   * could hold a perfectly good instant and still print `Invalid Date` across its axis if the
   * formatter and the x channel ever disagreed about the type, and nothing else would notice.
   */
  test('bucketTickFormat renders a bucket-start Date as its bucket label', () => {
    const start = new Date(JUL_31_2026_2305)
    expect(bucketTickFormat(300)(start)).toBe('31.07 23:05')
    expect(bucketTickFormat(86_400)(start)).toBe('31.07.26')
  })

  /** The exact failure the date prefix prevents, stated directly. */
  test('the two ends of a 24h window do not collide', () => {
    const start = Date.UTC(2026, 6, 31, 12, 0)
    expect(bucketAxisLabel(start, 300)).not.toBe(bucketAxisLabel(start + 86_400_000, 300))
  })
})

describe('runTickFormat', () => {
  /** Local components for the label — the label is the host's wall clock, so a UTC-pinned instant
   * would render differently per machine. */
  const at = (h: number, m: number, s = 0) => new Date(2026, 7, 1, h, m, s)

  test('renders a run to the minute, on the host clock', () => {
    expect(runTickFormat(at(14, 3, 41))).toBe('01.08 14:03')
  })

  test('two runs in one minute share a label — identity is the instant, not the label', () => {
    expect(runTickFormat(at(14, 3, 7))).toBe(runTickFormat(at(14, 3, 41)))
  })

  /** The DST fall-back: same wall clock, different instants, no special case. */
  test('a repeated wall-clock hour needs no special case', () => {
    const first = new Date(Date.UTC(2026, 9, 25, 0, 30))
    const second = new Date(first.getTime() + 3_600_000)
    if (first.getTimezoneOffset() === second.getTimezoneOffset()) return
    expect(runTickFormat(first)).toBe(runTickFormat(second))
  })
})

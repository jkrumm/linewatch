import { describe, expect, test } from 'bun:test'
import { fmtBytes, fmtClock, fmtDateTime, fmtRate, makeClockFormat, makeDateTimeFormat } from './format'

// 12:28 UTC on 1 Aug 2026 — which is 14:28 in Berlin, an hour the wall clock and UTC cannot agree
// on. That gap is the whole subject of these tests: a formatter that had quietly stayed on UTC
// would print 12:28 and every assertion below would fail on the digits, not on a locale detail.
const SUMMER_AFTERNOON = Date.UTC(2026, 7, 1, 12, 28, 0)
// 08:05 UTC on 5 Jan 2026 — 09:05 in Berlin. Single-digit hour, day and month, so a dropped
// leading zero or a month-order slip shows up; and a WINTER instant, so the offset it is read
// through is +01:00 rather than +02:00. A formatter that hard-coded one offset instead of doing a
// real zone conversion passes one of these two tests and fails the other.
const WINTER_MORNING = Date.UTC(2026, 0, 5, 8, 5, 0)

/**
 * The exported `fmtClock`/`fmtDateTime` read the host's locale and zone, which is the point of
 * them and also the reason they cannot be asserted directly: pinning a string here would pin the
 * machine the suite runs on, and asserting the host's own answer to the host's own question
 * verifies nothing at all. So the contract is checked through the factories, with both fixed.
 */
describe('makeClockFormat', () => {
  /** A real zone conversion, not a UTC render with a different label on it. */
  test('renders the wall clock of the given zone', () => {
    expect(makeClockFormat('de-DE', 'Europe/Berlin').format(SUMMER_AFTERNOON)).toBe('14:28')
    expect(makeClockFormat('de-DE', 'Europe/Berlin').format(WINTER_MORNING)).toBe('09:05')
  })

  /** No zone suffix. It was ` UTC` and it is now nothing: the reader's own zone is the one zone
   * they do not have to be told they are in, and a tag repeated on every axis tick and table cell
   * is a column of noise saying so. */
  test('carries no zone tag', () => {
    expect(makeClockFormat('en-GB', 'Europe/Berlin').format(SUMMER_AFTERNOON)).toBe('14:28')
  })

  /** The locale decides the clock, deliberately — `hour12` is unset rather than forced. */
  test('lets the locale pick 12- or 24-hour', () => {
    expect(makeClockFormat('en-US', 'America/New_York').format(SUMMER_AFTERNOON)).toContain('AM')
  })
})

/**
 * **These assert the PARTS, never the whole string, and the reason is a CI failure.**
 *
 * Pinning `'1 Aug at 14:28'` passed on macOS and failed on the GitHub runner, which renders the
 * same locale, zone, options and instant as `'1 Aug, 14:28'`. The connector between a date and a
 * time is CLDR data, so it moves with the ICU version bundled into whatever is executing — a
 * property of the machine, not of this code. A test that pins it is a test that fails on a
 * dependency upgrade nobody made, and says nothing about the formatter when it passes.
 *
 * What is worth asserting survives that: the date is there, the clock is there, and the clock is
 * the LOCAL one. A regression to UTC prints 12:28 and fails; a dropped time half fails; a glued
 * `${date} at ${clock}` still passes, which is the one property genuinely not testable here and is
 * carried by the docblock on `makeDateTimeFormat` instead.
 */
describe('makeDateTimeFormat', () => {
  test('carries both halves, with the time on the target zone`s clock', () => {
    const summer = makeDateTimeFormat('en-GB', 'Europe/Berlin').format(SUMMER_AFTERNOON)
    expect(summer).toContain('14:28')
    expect(summer).toContain('Aug')
    expect(summer).toContain('1')
  })

  test('renders a single-digit day, month and hour correctly', () => {
    const winter = makeDateTimeFormat('en-GB', 'Europe/Berlin').format(WINTER_MORNING)
    expect(winter).toContain('09:05')
    expect(winter).toContain('Jan')
    expect(winter).toContain('5')
  })
})

describe('fmtClock / fmtDateTime', () => {
  /** What can be asserted about the host-default pair without pinning the host: they agree with
   * the factories called with no arguments, i.e. nothing is smuggled in on top of the browser's
   * own defaults — no residual zone, no residual locale, no suffix. */
  test('are the host-default factories and nothing more', () => {
    expect(fmtClock(SUMMER_AFTERNOON)).toBe(makeClockFormat().format(new Date(SUMMER_AFTERNOON)))
    expect(fmtDateTime(SUMMER_AFTERNOON)).toBe(makeDateTimeFormat().format(new Date(SUMMER_AFTERNOON)))
  })

  /** The regression that would silently undo all of this: a `timeZone: 'UTC'` creeping back in.
   * Only meaningful off UTC, so it is skipped on a UTC host rather than asserted vacuously. */
  test('follow the host zone, not UTC', () => {
    const offset = new Date(SUMMER_AFTERNOON).getTimezoneOffset()
    if (offset === 0) return
    expect(fmtClock(SUMMER_AFTERNOON)).not.toBe(makeClockFormat(undefined, 'UTC').format(SUMMER_AFTERNOON))
  })
})

describe('fmtBytes', () => {
  test('steps through decimal units', () => {
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(1_500)).toBe('1.5 kB')
    expect(fmtBytes(4_200_000)).toBe('4.2 MB')
    expect(fmtBytes(517_530_000_000)).toBe('518 GB')
  })

  /** Decimal, not binary: every number this is read against on the page — macOS's own interface
   * totals, the ISP's advertised capacity, the Mbps speed tests — uses 1000. */
  test('uses 1000 to the step, not 1024', () => {
    expect(fmtBytes(1_000)).toBe('1.0 kB')
    expect(fmtBytes(1_024)).toBe('1.0 kB')
  })

  /** Nothing measured and nothing moved are different facts. */
  test('null is a dash, never a zero', () => {
    expect(fmtBytes(null)).toBe('—')
    expect(fmtBytes(0)).toBe('0 B')
  })

  test('does not run off the end of the unit table', () => {
    expect(fmtBytes(1e24)).toContain('PB')
  })
})

describe('fmtRate', () => {
  test('is bytes per second, with the unit always written out', () => {
    expect(fmtRate(10_000)).toBe('10 kB/s')
    expect(fmtRate(1_200_000)).toBe('1.2 MB/s')
    expect(fmtRate(null)).toBe('—')
  })
})

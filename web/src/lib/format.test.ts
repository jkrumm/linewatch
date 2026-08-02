import { describe, expect, test } from 'bun:test'
import { fmtBytes, fmtClock, fmtDateTime, fmtRate } from './format'

// Aug 1 2026, 14:28:00 UTC — an afternoon time, so a 12-hour-clock regression (AM/PM instead of
// 24h) would be visible immediately rather than accidentally matching.
const AFTERNOON_UTC = Date.UTC(2026, 7, 1, 14, 28, 0)
// Jan 5 2026, 09:05:00 UTC — single-digit hour/day/month, so a dropped leading zero or a
// month-order slip (day-before-month vs month-before-day) would show up too.
const EARLY_JAN_UTC = Date.UTC(2026, 0, 5, 9, 5, 0)

describe('fmtClock', () => {
  /**
   * Locked to `en-GB`/UTC regardless of the host's locale — `Intl.DateTimeFormat(undefined, ...)`
   * used to render "2:28 PM" or "14.28" or worse depending on the machine it ran on; a future
   * locale change (host or default) must not silently move this string.
   */
  test('renders a fixed-locale 24-hour clock with an explicit UTC label', () => {
    expect(fmtClock(AFTERNOON_UTC)).toBe('14:28 UTC')
  })

  /** Single-digit hour and minute still get their leading zero — "9:5 UTC" is not a valid clock. */
  test('pads single-digit hour and minute', () => {
    expect(fmtClock(EARLY_JAN_UTC)).toBe('09:05 UTC')
  })
})

describe('fmtDateTime', () => {
  /**
   * The load-bearing case: this used to be `Intl.DateTimeFormat(undefined, ...)`, so on a
   * German-locale host it rendered "1. Aug., 14:28" — no timezone stated at all, on a page whose
   * entire purpose is correlating events against the verdict cards' `UTC` timestamps. Pinning the
   * exact string here is what stops a future locale change from reintroducing that ambiguity.
   */
  test('renders a fixed-locale short date-time with an explicit UTC label', () => {
    expect(fmtDateTime(AFTERNOON_UTC)).toBe('1 Aug at 14:28 UTC')
  })

  /** Single-digit day and month still read correctly, in day-before-month order. */
  test('renders a single-digit day and month correctly', () => {
    expect(fmtDateTime(EARLY_JAN_UTC)).toBe('5 Jan at 09:05 UTC')
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

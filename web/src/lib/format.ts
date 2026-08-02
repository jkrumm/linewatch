/** Shared, non-chart formatters — chart axis/tooltip date formatting stays in `basalt-ui/charts`
 * (`fmtAxisDate`/`fmtTooltipDate`); these cover stat cards, tables and tiles. */

export function fmtMs(value: number | null): string {
  if (value === null) return '—'
  return `${value.toFixed(value < 10 ? 1 : 0)} ms`
}

export function fmtMbps(value: number | null): string {
  if (value === null) return '—'
  return `${value.toFixed(value < 10 ? 2 : 1)} Mbps`
}

export function fmtPct(value: number | null, digits = 1): string {
  if (value === null) return '—'
  return `${value.toFixed(digits)}%`
}

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] as const

/** Decimal steps, not binary: every number this is read against on the page — macOS's own
 * interface totals, the ISP's advertised capacity, the Mbps speed tests — counts in 1000.
 *
 * Null is a dash and 0 is `0 B`, because nothing measured and nothing moved are different facts
 * and this dashboard exists to keep them apart. */
export function fmtBytes(value: number | null): string {
  if (value === null) return '—'

  let scaled = Math.abs(value)
  let unit = 0
  while (scaled >= 1000 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1000
    unit += 1
  }

  const sign = value < 0 ? '-' : ''
  // Whole bytes stay whole; every scaled unit keeps one decimal until it needs the width more.
  const digits = unit === 0 ? 0 : scaled >= 100 ? 0 : 1
  return `${sign}${scaled.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

/** Bytes per second, with the unit always written out so it can never be mistaken for the Mbps
 * the speed tests report — capacity and carried volume are different questions. */
export function fmtRate(value: number | null): string {
  if (value === null) return '—'

  let scaled = Math.abs(value)
  let unit = 0
  while (scaled >= 1000 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1000
    unit += 1
  }

  // Coarser than fmtBytes on purpose: a rate is read as a magnitude while it moves, and a
  // second decimal on a number that changes every refresh is noise, not precision.
  const sign = value < 0 ? '-' : ''
  const digits = unit === 0 || scaled >= 10 ? 0 : 1
  return `${sign}${scaled.toFixed(digits)} ${BYTE_UNITS[unit]}/s`
}

/** Coarse minutes headline — the Uptime view's downtime total (DESIGN.md deliberately headlines
 * minutes, not a percentage) and the Now banner's "no data for N min". Rounds to whole minutes and
 * rolls into hours, because both numbers are read at a glance and neither is a duration anyone
 * measures to the second. */
export function fmtMinutes(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  return rem === 0 ? `${hours} h` : `${hours} h ${rem} min`
}

export function fmtDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`
}

/**
 * The reader's own clock, in the reader's own conventions.
 *
 * These were locked to `en-GB` and UTC with the zone written out, and that reasoning was sound as
 * far as it went: `Intl.DateTimeFormat(undefined, …)` renders differently per machine, and a bare
 * "14:28" is only readable if you already know which zone it means. What it left out is who reads
 * this page. One person, on one machine, in one zone, matching a column on a chart against the
 * memory of a call that dropped — and doing the +02:00 in their head every single time. A
 * dashboard whose timestamps need arithmetic before they can be held against a wall clock is the
 * worse ambiguity, and it is the one that was shipping.
 *
 * So: host locale, host zone, no suffix. The reader's own zone is the one zone nobody has to be
 * told they are in.
 *
 * **The exported formatters take neither, and the factories do.** A test cannot assert a host
 * default without pinning the machine it runs on, and one that asserts the host's own answer to
 * the host's own question has verified nothing. The factories let `format.test.ts` fix both and
 * check the contract that actually matters — a real wall-clock conversion, and no zone tag — while
 * the page keeps whatever the browser says.
 *
 * `hour12` is deliberately unset rather than forced to `false`: which clock to draw is exactly the
 * kind of thing "the browser's own conventions" is supposed to decide.
 */
export function makeClockFormat(locale?: string, timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone })
}

/** One formatter for the whole stamp, not a date one concatenated to a clock one with " at ".
 * Where the time sits relative to the date, and what separates them, is a property of the locale —
 * `de-DE` writes "1. Aug., 14:28" and `en-US` "Aug 1, 2:28 PM", and neither is reachable by gluing
 * two independently-formatted halves together. */
export function makeDateTimeFormat(locale?: string, timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  })
}

const CLOCK_FORMAT = makeClockFormat()
const DATE_TIME_FORMAT = makeDateTimeFormat()

export function fmtClock(ts: number): string {
  return CLOCK_FORMAT.format(new Date(ts))
}

export function fmtDateTime(ts: number): string {
  return DATE_TIME_FORMAT.format(new Date(ts))
}

/** How long ago, in a compact glance-friendly form — "just now", "3m ago", "2h ago". */
export function fmtRelative(ts: number, now: number = Date.now()): string {
  const diffS = Math.max(0, Math.round((now - ts) / 1000))
  if (diffS < 30) return 'just now'
  if (diffS < 60) return `${diffS}s ago`
  const diffM = Math.round(diffS / 60)
  if (diffM < 60) return `${diffM}m ago`
  const diffH = Math.round(diffM / 60)
  if (diffH < 48) return `${diffH}h ago`
  return `${Math.round(diffH / 24)}d ago`
}

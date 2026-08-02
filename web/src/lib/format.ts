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

/** Locked to `en-GB` and UTC, not the host's locale.
 *
 * `Intl.DateTimeFormat(undefined, …)` rendered "2:28 PM" or "1. Aug., 14:28" depending on the
 * machine, and in neither case said which zone it meant — on a page whose whole purpose is
 * correlating a timeline against verdict cards stamped `UTC`. The zone is written out for the
 * same reason: a bare "14:28" is only readable if you already know the answer. */
const CLOCK_FORMAT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
})
const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

export function fmtClock(ts: number): string {
  return `${CLOCK_FORMAT.format(new Date(ts))} UTC`
}

export function fmtDateTime(ts: number): string {
  return `${DATE_FORMAT.format(new Date(ts))} at ${fmtClock(ts)}`
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

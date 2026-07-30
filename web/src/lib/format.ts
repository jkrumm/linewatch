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

/** Minutes headline for the Uptime view — DESIGN.md deliberately headlines minutes, not a
 * percentage, so this is a first-class formatter rather than a one-off. */
export function fmtDowntimeMinutes(totalSeconds: number): string {
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

const CLOCK_FORMAT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

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

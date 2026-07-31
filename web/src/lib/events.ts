import type { EventKind, LinewatchEvent } from './types'
import { fmtDateTime } from './format'

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  link_change: 'link change',
  intervention: 'intervention',
  config_change: 'config change',
  note: 'note',
}

/**
 * How a `detail.source` is shown, and — the load-bearing half — at what precision it observed.
 *
 * The three writers of `link_change` report the same kind of fact from three distances. A
 * `vantage-diff` row is stamped at the *sampling* instant, so the transition happened somewhere in
 * the preceding 30 s cycle; a `link-sampler` row is stamped at the transition itself to ~1 s; a
 * `router-poller` row is the carrier's own account, up to a poll interval late. Presenting all
 * three as one timestamp column implies a precision two of them do not have.
 */
export interface EventSourceLabel {
  label: string
  precision: string
  /** Mantine badge colour — one per observation, so scanning the column is enough. */
  color: 'blue' | 'teal' | 'violet' | 'grape' | 'gray'
}

const SOURCE_LABELS: Record<string, EventSourceLabel> = {
  'link-sampler': {
    label: 'link sampler',
    precision: 'the transition itself, to ~1 s',
    color: 'teal',
  },
  'vantage-diff': {
    label: 'vantage diff',
    precision: 'somewhere in the preceding 30 s cycle',
    color: 'blue',
  },
  'router-poller': {
    label: 'router poll',
    precision: "the carrier's side, up to one poll interval late",
    color: 'violet',
  },
  manual: {
    label: 'manual',
    precision: 'as recorded by the person who did it',
    color: 'grape',
  },
}

export function eventSourceLabel(source: string | null): EventSourceLabel {
  if (source === null) {
    return {
      label: 'not recorded',
      // Not "probably the vantage diff". Every `link_change` written before the source field
      // existed carries none, and naming the likeliest writer would turn an unlabelled row into a
      // precision claim nobody made.
      precision: 'the writer recorded no source, so the precision of this timestamp is unknown',
      color: 'gray',
    }
  }
  // A source this build has never heard of renders as itself rather than falling into a bucket:
  // the collector and the API deploy independently, so a new writer reaching an old dashboard is
  // expected, and swallowing it into "unknown" would hide that it exists.
  return (
    SOURCE_LABELS[source] ?? {
      label: source,
      precision: 'an observation this dashboard build does not know the precision of',
      color: 'gray',
    }
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scalar(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * A one-line rendering of an event's free-form `detail`.
 *
 * `detail` is JSON with a different shape per writer and no schema, so this stays a generic
 * key/value walk with one special case for the vantage diff's `changed` map — which is the shape
 * that carries the actual before/after and reads as noise flattened any other way. Unknown shapes
 * degrade to their own keys rather than being dropped: a writer this build predates should still
 * show what it wrote.
 */
export function summariseEventDetail(detail: unknown): string {
  if (!isRecord(detail)) return detail === undefined ? '' : scalar(detail)

  const parts: string[] = []
  for (const [key, value] of Object.entries(detail)) {
    // Already rendered as its own column; repeating it here is noise.
    if (key === 'source') continue
    if (key === 'changed' && isRecord(value)) {
      for (const [field, change] of Object.entries(value)) {
        if (isRecord(change) && 'before' in change && 'after' in change) {
          parts.push(`${field} ${scalar(change['before'])} → ${scalar(change['after'])}`)
        } else {
          parts.push(`${field} ${scalar(change)}`)
        }
      }
      continue
    }
    parts.push(`${key} ${scalar(value)}`)
  }
  return parts.join(' · ')
}

export interface TimelineEmptyState {
  title: string
  description: string
}

/**
 * What an empty timeline is allowed to say.
 *
 * "No events" is the one phrasing this must never produce. `select count(*) from event` was 0 for
 * this project's entire history while macOS's own log held ten `hasLink: false` lines for the same
 * day, including a continuous 14.3 s down state inside a recorded WAN outage. The table was empty
 * because nothing was watching. So the empty state is a statement about the *watcher*, and it has
 * two forms depending on whether one was running at all.
 */
export function timelineEmptyState(linkSamplingSince: number | null): TimelineEmptyState {
  if (linkSamplingSince === null) {
    return {
      title: 'Link sampling is not running',
      description:
        'No cycle in this window recorded how many of its seconds were watched, so an empty timeline means nothing was looking — not that the link held. A sub-cycle flap here would leave no trace at all.',
    }
  }
  return {
    title: 'No transitions recorded',
    description: `Link sampling has covered this window since ${fmtDateTime(linkSamplingSince)}. Since then no transition longer than its ~1 s resolution was observed; shorter ones are below what it can see, and nothing is claimed about the window before that point.`,
  }
}

/** Newest first, matching `GET /api/events`'s own ordering, so a mock and the real API agree. */
export function sortEventsNewestFirst(events: LinewatchEvent[]): LinewatchEvent[] {
  return [...events].sort((a, b) => b.ts - a.ts)
}

import { Elysia } from 'elysia'
import { z } from 'zod'
import { and, desc, eq, gt, gte, lte, min, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { event, probeCycle } from '../db/schema.js'

const EventKindSchema = z.enum(['intervention', 'link_change', 'config_change', 'note'])

const EventSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  kind: EventKindSchema,
  source: z
    .string()
    .nullable()
    .describe(
      "What produced the event, lifted out of `detail.source` so the timeline can tell very differently-precise observations apart without parsing `detail`: `link-sampler` is a 1 Hz observation of the physical link, `vantage-diff` a comparison of two 30 s snapshots, `router-poller` the carrier's side. Null means the writer recorded no source — every `link_change` written before `vantage-diff` was stamped carries none — and is never filled in with a plausible one.",
    ),
  detail: z.unknown(),
})

/**
 * The instant link sampling starts covering this window, or null when no cycle
 * in it reported `link_watch_s` at all.
 *
 * It rides on this route because an empty `events` array is meaningless without
 * it: zero transitions over a watched window is a measurement, zero transitions
 * over an unwatched one is silence. Bounded by the same `from`/`to` as the
 * events and answered off `probe_cycle`'s `ts` index, so it costs a range scan
 * that stops at the first watched cycle rather than a table scan.
 *
 * Strictly `> 0`, not merely non-null. `createLinkSampler.drain()` reports
 * `watchedS: 0` for a cycle in which every `ifconfig` read failed — which is
 * what a yanked adapter looks like, i.e. exactly the moment the link record
 * matters most. That row is the sampler saying it observed *nothing*, so
 * counting it as coverage would let the timeline print "watched since <ts>,
 * no transitions" off zero seconds of observation: the same
 * absence-dressed-as-measurement this table exists to prevent.
 */
function linkSamplingSince(from: number | undefined, to: number | undefined): number | null {
  const conditions: SQL[] = [gt(probeCycle.linkWatchS, 0)]
  if (from !== undefined) conditions.push(gte(probeCycle.ts, from))
  if (to !== undefined) conditions.push(lte(probeCycle.ts, to))
  const row = db
    .select({ firstTs: min(probeCycle.ts) })
    .from(probeCycle)
    .where(and(...conditions))
    .get()
  return row?.firstTs ?? null
}

/**
 * `detail` is free-form JSON per kind, so `source` is read defensively: a
 * writer that never set one, or set it to something that is not a string,
 * yields null rather than a guess about who wrote the row.
 */
function readSource(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null
  const source: unknown = (detail as { source?: unknown }).source
  return typeof source === 'string' ? source : null
}

export const eventsRoutes = new Elysia().get(
  '/api/events',
  ({ query }) => {
    const conditions: SQL[] = []
    if (query.from !== undefined) conditions.push(gte(event.ts, query.from))
    if (query.to !== undefined) conditions.push(lte(event.ts, query.to))
    if (query.kind !== undefined) conditions.push(eq(event.kind, query.kind))
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const rows = db.select().from(event).where(where).orderBy(desc(event.ts)).all()
    return {
      events: rows.map((row) => {
        const detail = JSON.parse(row.detail) as unknown
        return {
          id: row.id,
          ts: row.ts,
          kind: row.kind,
          source: readSource(detail),
          detail,
        }
      }),
      linkSamplingSince: linkSamplingSince(query.from, query.to),
    }
  },
  {
    query: z.object({
      from: z.coerce.number().int().optional(),
      to: z.coerce.number().int().optional(),
      kind: EventKindSchema.optional(),
    }),
    response: z.object({
      events: z.array(EventSchema),
      linkSamplingSince: z
        .number()
        .int()
        .nullable()
        .describe(
          'Earliest cycle in this window that actually watched the link (`probe_cycle.link_watch_s > 0`), or null when none did — a cycle reporting 0 watched seconds is the sampler saying it observed nothing, not coverage. Read it before reading an empty `events` array: with a value, no transition longer than the ~1 s sampling resolution was observed after it; with null, nothing was watching and the empty array says nothing about the link.',
        ),
    }),
    detail: {
      tags: ['Events'],
      summary: 'List timeline events',
      description:
        'The dashboard timeline overlay (docs/DESIGN.md "event" — the extension point). Read-only: every kind is materialised on write elsewhere. `link_change` has three writers — `services/cycle-vantage.ts` when the 30 s vantage diff moves (`source: vantage-diff`), the router poller from the carrier side (`router-poller`), and the collector\'s 1 Hz link sampler for transitions shorter than a cycle (`link-sampler`) — and `source` is what tells them apart, because they observe the same kind of fact at 30 s, 5 min and 1 s precision respectively. `intervention` is written by `POST /api/interventions`; `config_change` and `note` are still unwritten. Absence of a `link_change` in a range never means the link was stable there: it means no transition longer than the sampling resolution was observed, and `linkSamplingSince` is what says whether anything was watching at all.',
    },
  },
)

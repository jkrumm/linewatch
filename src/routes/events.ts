import { Elysia } from 'elysia'
import { z } from 'zod'
import { and, desc, gte, lte, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { event } from '../db/schema.js'

const EventSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  kind: z.enum(['intervention', 'link_change', 'config_change', 'note']),
  detail: z.unknown(),
})

export const eventsRoutes = new Elysia().get(
  '/api/events',
  ({ query }) => {
    const conditions: SQL[] = []
    if (query.from !== undefined) conditions.push(gte(event.ts, query.from))
    if (query.to !== undefined) conditions.push(lte(event.ts, query.to))
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const rows = db.select().from(event).where(where).orderBy(desc(event.ts)).all()
    return {
      events: rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        kind: row.kind,
        detail: JSON.parse(row.detail) as unknown,
      })),
    }
  },
  {
    query: z.object({
      from: z.coerce.number().int().optional(),
      to: z.coerce.number().int().optional(),
    }),
    response: z.object({ events: z.array(EventSchema) }),
    detail: {
      tags: ['Events'],
      summary: 'List timeline events',
      description:
        'The dashboard timeline overlay (docs/DESIGN.md "event" — the extension point). Nothing writes `intervention`/`link_change` in v1; this route is read-only.',
    },
  },
)

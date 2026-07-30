import { Elysia } from 'elysia'
import { z } from 'zod'
import { and, desc, gte, isNull, lte, or, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { outage } from '../db/schema.js'

const OutageSchema = z.object({
  id: z.number().int(),
  scope: z.enum(['gateway', 'wan']),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  durationS: z.number().int().nullable(),
  cycles: z.number().int(),
  evidence: z.array(z.string()),
})

export const outagesRoutes = new Elysia().get(
  '/api/outages',
  ({ query }) => {
    const conditions: SQL[] = []
    if (query.from !== undefined) conditions.push(gte(outage.startedAt, query.from))
    if (query.to !== undefined) conditions.push(lte(outage.startedAt, query.to))
    if (query.minDuration !== undefined) {
      // An ongoing outage (durationS still null) always passes — its final
      // duration isn't known yet, and it's the most operationally relevant row.
      conditions.push(or(isNull(outage.durationS), gte(outage.durationS, query.minDuration)) as SQL)
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const rows = db.select().from(outage).where(where).orderBy(desc(outage.startedAt)).all()
    return {
      outages: rows.map((row) => ({
        id: row.id,
        scope: row.scope,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationS: row.durationS,
        cycles: row.cycles,
        evidence: JSON.parse(row.evidence) as string[],
      })),
    }
  },
  {
    query: z.object({
      from: z.coerce.number().int().optional(),
      to: z.coerce.number().int().optional(),
      minDuration: z.coerce.number().int().optional().describe('Seconds — filters closed outages; ongoing outages always show'),
    }),
    response: z.object({ outages: z.array(OutageSchema) }),
    detail: {
      tags: ['Outages'],
      summary: 'List outages',
      description:
        'Outage rows materialised by the ingest-time state machine (never derived on read). Single-cycle blips are included honestly — filter them client-side or with `minDuration`.',
    },
  },
)

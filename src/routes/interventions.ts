import { Elysia } from 'elysia'
import { z } from 'zod'
import { db } from '../db/client.js'
import { event } from '../db/schema.js'
import { hasValidBearer } from '../lib/auth.js'

/**
 * Records a manual action on the line — power-cycled the router, swapped the
 * cable, moved the mini to another port — as an `event` of kind `intervention`.
 *
 * The point is attribution: without it a recovery two minutes after a reboot is
 * indistinguishable from a recovery that would have happened anyway, and the
 * uptime record silently credits the ISP for a fix that was a human with a
 * plug. Bearer-gated like the other writes; reads come back through
 * `GET /api/events`.
 */

const InterventionBody = z.object({
  action: z.string().min(1).describe('What was done, e.g. "power-cycled the router"'),
  note: z.string().optional().describe('Why, or what was expected of it'),
  ts: z
    .number()
    .int()
    .optional()
    .describe('When it happened, epoch ms. Defaults to now — set it when recording after the fact.'),
})

export const interventionsRoutes = new Elysia().post(
  '/api/interventions',
  ({ body, headers, status }) => {
    if (!hasValidBearer(headers)) return status(401, 'Unauthorized')

    const ts = body.ts ?? Date.now()
    const inserted = db
      .insert(event)
      .values({
        ts,
        kind: 'intervention',
        detail: JSON.stringify({
          source: 'manual',
          action: body.action,
          ...(body.note !== undefined ? { note: body.note } : {}),
        }),
      })
      .returning({ id: event.id })
      .all()

    return { ok: true as const, id: inserted[0]?.id ?? null, ts }
  },
  {
    body: InterventionBody,
    response: {
      200: z.object({ ok: z.literal(true), id: z.number().int().nullable(), ts: z.number().int() }),
      401: z.string(),
    },
    detail: {
      tags: ['Events'],
      summary: 'Record a manual intervention',
      description:
        'Writes an `event` row of kind `intervention` so a manual action can be correlated with the recovery it caused. `ts` defaults to now.',
      security: [{ BearerAuth: [] }],
    },
  },
)

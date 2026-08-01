import { Elysia } from 'elysia'
import { z } from 'zod'
import { db } from '../db/client.js'
import { event } from '../db/schema.js'
import { hasValidBearer } from '../lib/auth.js'

/**
 * Records an action on the line — power-cycled the router, swapped the cable,
 * moved the mini to another port — as an `event`.
 *
 * The point is attribution: without it a recovery two minutes after a reboot is
 * indistinguishable from a recovery that would have happened anyway, and the
 * uptime record silently credits the ISP for a fix that was a human with a
 * plug. Bearer-gated like the other writes; reads come back through
 * `GET /api/events`, which already lifts `detail.source` into a top-level field.
 *
 * `source` exists because this route used to hardcode `manual`, and an
 * automated actor posting here would have been recorded as a human with a plug
 * — the same attribution lie, told about a different actor. Six months of
 * "does rebooting actually fix this?" is unanswerable if three real human
 * interventions and forty machine ones are indistinguishable.
 *
 * `kind` splits the two things an actor produces. `intervention` means
 * something was actually done to the line, and the dashboard's attribution
 * logic depends on that meaning holding. Everything else an automated actor has
 * to say — it would have acted, it was blocked, it escalated, it watched a
 * recovery happen on its own — is a `note`. Recording a suppressed action as an
 * intervention would credit it for a line that fixed itself, which is precisely
 * the failure this route was built to prevent for humans.
 */

const InterventionBody = z.object({
  action: z.string().min(1).describe('What was done, e.g. "power-cycled the router"'),
  source: z
    .enum(['manual', 'watchdog'])
    .default('manual')
    .describe('Who did it. The whole point of the route: a machine action recorded as a human one destroys the attribution it exists to preserve.'),
  kind: z
    .enum(['intervention', 'note'])
    .default('intervention')
    .describe('`intervention` only for something actually done to the line. Everything else — blocked, suppressed, escalated, observed — is a `note`.'),
  note: z.string().optional().describe('Why, or what was expected of it'),
  detail: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Structured evidence for the action: what was measured, which preconditions passed, what the outcome was.'),
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
        kind: body.kind,
        // Caller-supplied detail first, so the fields this route owns cannot be
        // overwritten by it. A body that sets `source: 'manual'` inside `detail`
        // must not be able to launder a watchdog action into a human one — which
        // is the exact lie this route exists to prevent, arriving by the back
        // door instead of the front.
        detail: JSON.stringify({
          ...(body.detail ?? {}),
          source: body.source,
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

import { Elysia } from 'elysia'
import { z } from 'zod'
import { desc } from 'drizzle-orm'
import { db } from '../db/client.js'
import { event, routerLineSample } from '../db/schema.js'
import { hasValidBearer } from '../lib/auth.js'
import { routerConfig } from '../services/router/config.js'
import { getRouterExecutor, getRouterPoller, pollOnDemand } from '../services/router/scheduler.js'

/**
 * The two routes that reach the router rather than its record.
 *
 * **Both are bearer-gated, and the actions carry a second, independent gate.**
 * The bearer is the same one `POST /api/probes` and `POST /api/interventions`
 * use — these write to the historical record too, and one of them writes to the
 * line itself. `grep -rn hasValidBearer src/` is the source of truth for that
 * list and `CLAUDE.md` follows it, not the other way round.
 *
 * The second gate is `LINEWATCH_ROUTER_WRITE`, unset by default, which turns the
 * executor into a `NullExecutor` for the whole process. It exists because the
 * two failure modes are different: the bearer stops someone else acting, and the
 * capability switch stops *us* acting — including a watchdog that has gone
 * wrong, a bad deploy, or a test pointed at the wrong host. It is the switch
 * that matters when the thing that broke is the thing holding the token.
 *
 * Neither route is on the dashboard. `POST /api/speedtests/run` is unauthenticated
 * because its only abuse is saturating the line; these can drop the household's
 * internet, and there is no such argument to make.
 */

/**
 * Enough to be sure a poll is genuinely on demand rather than a retry storm,
 * and short enough to be useful mid-outage: the whole reason this route exists
 * is that the 10:20 poll on 2026-08-01 failed and the next carrier reading
 * landed two minutes after the box had already been rebooted by hand.
 */
const POLL_MIN_INTERVAL_S = 60

/**
 * Measured against the newest stored row rather than an in-process timer, the
 * same pattern as the speed-test limit and for the same reason: restarting the
 * container must not reset the budget.
 */
function secondsSinceLastPoll(now: number): number | null {
  const row = db.select({ ts: routerLineSample.ts }).from(routerLineSample).orderBy(desc(routerLineSample.ts)).limit(1).get()
  return row === undefined ? null : Math.floor((now - row.ts) / 1000)
}

const ActionResultSchema = z.object({
  ok: z.boolean(),
  capability: z.enum(['live', 'null']).describe('`null` means nothing was sent — the write capability is off'),
  outcome: z.enum(['executed', 'failed', 'not_executed', 'refused']),
  detail: z.string(),
  steps: z.array(
    z.object({
      oid: z.string(),
      ok: z.boolean(),
      errorcode: z.string().nullable(),
      httpStatus: z.number().int().nullable(),
    }),
  ),
})

export const routerActionRoutes = new Elysia()
  .post(
    '/api/router/poll',
    async ({ headers, status }) => {
      if (!hasValidBearer(headers)) return status(401, 'Unauthorized')
      if (getRouterPoller() === null) {
        return status(503, { error: 'router poller not configured', disabledReason: routerConfig.disabledReason })
      }

      const since = secondsSinceLastPoll(Date.now())
      if (since !== null && since < POLL_MIN_INTERVAL_S) {
        return status(429, { error: 'polled too recently', secondsUntilNext: POLL_MIN_INTERVAL_S - since })
      }

      await pollOnDemand()
      return { ok: true as const }
    },
    {
      response: {
        200: z.object({ ok: z.literal(true) }),
        401: z.string(),
        429: z.object({ error: z.string(), secondsUntilNext: z.number().int() }),
        503: z.object({ error: z.string(), disabledReason: z.string().nullable() }),
      },
      detail: {
        tags: ['Router'],
        summary: 'Poll the router now',
        description:
          'Runs one read-only poll immediately, serialised against the scheduled one. Exists because the carrier-side view is unavailable exactly when it matters: on 2026-08-01 the 10:20 poll failed 11 minutes into an outage and the next reading landed two minutes after the router had already been rebooted by hand. Rate-limited to one per 60s, measured against the newest stored sample so a container restart cannot reset the budget.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .post(
    '/api/router/actions/reconnect',
    async ({ headers, status }) => {
      if (!hasValidBearer(headers)) return status(401, 'Unauthorized')
      // Checked here as well as inside the executor. The executor being a
      // NullExecutor is what makes this safe; this check is what makes it
      // *legible* — a 403 naming the switch beats a 200 saying nothing happened.
      if (!routerConfig.writeEnabled) {
        return status(403, {
          error: 'router writes are disabled',
          hint: 'set LINEWATCH_ROUTER_WRITE=1 to enable; it is off by default and independent of the poller',
        })
      }

      const result = await getRouterExecutor().reconnect()

      // Recorded whatever happened, including a refusal. An action attempted
      // and not recorded is the failure POST /api/interventions exists to
      // prevent, and it already happened once to a human on 2026-08-01: the
      // router reboot that ended a 21.5-minute outage was never written down,
      // so the record shows an outage that ended on its own.
      db.insert(event)
        .values({
          ts: Date.now(),
          kind: result.outcome === 'executed' || result.outcome === 'failed' ? 'intervention' : 'note',
          detail: JSON.stringify({
            source: 'api',
            action: 'router_reconnect',
            outcome: result.outcome,
            capability: result.capability,
            steps: result.steps,
            before:
              result.before === null
                ? null
                : {
                    connType: result.before.connType,
                    stack: result.before.stack,
                    connStatusV4: result.before.connStatusV4,
                    connStatusV6: result.before.connStatusV6,
                    uptimeV6S: result.before.uptimeV6S,
                    lastConnError: result.before.lastConnError,
                  },
            note: result.detail,
          }),
        })
        .run()

      return {
        ok: result.ok,
        capability: result.capability,
        outcome: result.outcome,
        detail: result.detail,
        steps: result.steps,
      }
    },
    {
      response: {
        200: ActionResultSchema,
        401: z.string(),
        403: z.object({ error: z.string(), hint: z.string() }),
      },
      detail: {
        tags: ['Router'],
        summary: 'Re-dial the WAN connection',
        description:
          'Reads DEV2_ADT_WAN on the session it acts over, takes that instance\'s own stack — which is not the interface\'s — and branches on connType exactly as the firmware\'s WAN page does: a PPP disconnect/connect pair, or a DHCP renew. An unrecognised connType is refused rather than guessed. **This drops the line**: it changes the public IPv4 address and can change the delegated IPv6 prefix, and on a DS-Lite line IPv4 rides the v6 session being bounced. Whatever happens is written to the event table with the pre-action connection state.',
        security: [{ BearerAuth: [] }],
      },
    },
  )

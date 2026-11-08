import { Elysia } from 'elysia'
import { z } from 'zod'
import { db } from '../db/client.js'
import { event } from '../db/schema.js'
import { hasValidBearer } from '../lib/auth.js'
import type { ActionResult } from '../services/router/actions.js'
import {
  getRouterExecutor,
  getRouterPoller,
  pollOnDemand,
  secondsSincePollAttempt,
} from '../services/router/scheduler.js'
import { routerConfig } from '../services/router/config.js'

/**
 * The three routes that reach the router rather than its record.
 *
 * **All are bearer-gated, and the two actions carry a second, independent gate.**
 * The bearer is the same one `POST /api/probes` and `POST /api/interventions`
 * use — these write to the historical record too, and one of them writes to the
 * line itself. `grep -rn hasValidBearer src/` is the source of truth for that
 * list and `AGENTS.md` follows it, not the other way round.
 *
 * The second gate is `LINEWATCH_ROUTER_WRITE`, unset by default, which keeps the
 * executor a `NullExecutor` for the whole process. The route gate reads the
 * executor's actual capability, not the env: with the poller off the executor is
 * a `NullExecutor` whatever the env says. It exists because the
 * two failure modes are different: the bearer stops someone else acting, and the
 * capability switch stops *us* acting — including a watchdog that has gone
 * wrong, a bad deploy, or a test pointed at the wrong host. It is the switch
 * that matters when the thing that broke is the thing holding the token.
 *
 * None of them is on the dashboard. `POST /api/speedtests/run` is unauthenticated
 * because its only abuse is saturating the line; these can drop the household's
 * internet — the reboot takes the LAN with it, Tailscale included — and there is
 * no such argument to make.
 */

/**
 * Enough to be sure a poll is genuinely on demand rather than a retry storm,
 * and short enough to be useful mid-outage: the whole reason this route exists
 * is that the 10:20 poll on 2026-08-01 failed and the next carrier reading
 * landed two minutes after the box had already been rebooted by hand.
 */
const POLL_MIN_INTERVAL_S = 60

const writesEnabled = () => getRouterExecutor().capability === 'live'

const PollFailureSchema = z.object({
  ok: z.literal(false),
  outcome: z.enum(['skipped', 'login_failed', 'failed', 'unconfigured']),
  error: z.string(),
})

const ActionResultSchema = z.object({
  ok: z.boolean(),
  capability: z
    .enum(['live', 'null'])
    .describe('`null` means nothing was sent — the write capability is off'),
  outcome: z
    .enum(['executed', 'failed', 'not_executed', 'refused', 'unknown'])
    .describe(
      '`unknown` is reachable only for a reboot: the device stops answering because it is rebooting, so a verb that went out and a transport that died are the same observation. It is the expected signature of success, and only the probe record over the next few minutes settles it.',
    ),
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

/**
 * Run an action and write the attempt down, whatever it does. The record is
 * written in a `finally`, so an executor that throws still leaves a row — an
 * action attempted and not recorded is exactly the failure
 * `POST /api/interventions` was built to prevent, and it has already happened
 * once to a human: the router reboot that ended the 21.5-minute outage on
 * 2026-08-01 was never written down, so the record shows an outage that ended
 * on its own. Shared by both actions so they cannot drift in how they record.
 *
 * `intervention` only when something may have reached the line. `executed`,
 * `unknown` (the device stopped answering because it was rebooting) and a
 * reconnect `failed` (it can die between disconnect and connect) all count. A
 * refusal, a suppressed write, a thrown error before anything was sent, and a
 * reboot the device explicitly rejected (`failed`: nothing rebooted) reached
 * nothing and stay a `note`.
 */
async function runAndRecord(
  action: 'router_reconnect' | 'router_reboot',
  run: () => Promise<ActionResult>,
) {
  let result: ActionResult | null = null
  let thrown: unknown = null
  try {
    result = await run()
  } catch (error) {
    thrown = error
    throw error
  } finally {
    writeRecord(action, result, thrown)
  }

  return {
    ok: result.ok,
    capability: result.capability,
    outcome: result.outcome,
    detail: result.detail,
    steps: result.steps,
  }
}

function writeRecord(
  action: 'router_reconnect' | 'router_reboot',
  result: ActionResult | null,
  thrown: unknown,
) {
  const touchedTheLine =
    result !== null &&
    (result.outcome === 'executed' ||
      result.outcome === 'unknown' ||
      (result.outcome === 'failed' && action === 'router_reconnect'))
  db.insert(event)
    .values({
      ts: Date.now(),
      kind: touchedTheLine ? 'intervention' : 'note',
      detail: JSON.stringify({
        source: 'api',
        action,
        outcome: result?.outcome ?? 'error',
        capability: result?.capability ?? null,
        steps: result?.steps ?? [],
        // The pre-action snapshot. A reboot resets showtime, zeroes every byte
        // counter and empties the host table, so this is the only surviving
        // description of what it was done to.
        before:
          result?.before == null
            ? null
            : {
                connType: result.before.connType,
                stack: result.before.stack,
                connStatusV4: result.before.connStatusV4,
                connStatusV6: result.before.connStatusV6,
                uptimeV6S: result.before.uptimeV6S,
                lastConnError: result.before.lastConnError,
              },
        note:
          result?.detail ??
          `the executor threw before reporting: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      }),
    })
    .run()
}

export const routerActionRoutes = new Elysia()
  .post(
    '/api/router/poll',
    async ({ headers, status }) => {
      if (!hasValidBearer(headers)) return status(401, 'Unauthorized')
      if (getRouterPoller() === null) {
        return status(503, {
          error: 'router poller not configured',
          disabledReason: routerConfig.disabledReason,
        })
      }

      const since = secondsSincePollAttempt(Date.now())
      if (since !== null && since < POLL_MIN_INTERVAL_S) {
        return status(429, {
          error: 'polled too recently',
          secondsUntilNext: POLL_MIN_INTERVAL_S - since,
        })
      }

      const outcome = await pollOnDemand()
      if (outcome === 'complete' || outcome === 'partial') return { ok: true as const, outcome }
      if (outcome === 'skipped') {
        return status(409, {
          ok: false as const,
          outcome,
          error: 'a poll or an action is already in progress',
        })
      }
      return status(502, {
        ok: false as const,
        outcome,
        error: `the poll did not complete (${outcome})`,
      })
    },
    {
      response: {
        200: z.object({ ok: z.literal(true), outcome: z.enum(['complete', 'partial']) }),
        401: z.string(),
        409: PollFailureSchema,
        502: PollFailureSchema,
        429: z.object({ error: z.string(), secondsUntilNext: z.number().int() }),
        503: z.object({ error: z.string(), disabledReason: z.string().nullable() }),
      },
      detail: {
        tags: ['Router'],
        summary: 'Poll the router now',
        description:
          'Runs one read-only poll immediately, serialised against the scheduled one. Exists because the carrier-side view is unavailable exactly when it matters: on 2026-08-01 the 10:20 poll failed 11 minutes into an outage and the next reading landed two minutes after the router had already been rebooted by hand. Rate-limited to one per 60s of poll attempts (an in-memory timestamp, so a failed poll counts and the limit holds mid-outage). Answers with the real outcome of the poll: 200 for complete or partial, 409 when another poll or an action holds the router session, 502 when the login failed or the poll threw; a failed login is also written as a `note` event with reason `login_failed`.',
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
      if (!writesEnabled()) {
        return status(403, {
          error: 'router writes are disabled',
          hint: 'set LINEWATCH_ROUTER_WRITE=1 to enable; it is off by default and independent of the poller',
        })
      }

      return runAndRecord('router_reconnect', () => getRouterExecutor().reconnect())
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
          "Reads DEV2_ADT_WAN on the session it acts over, takes that instance's own stack — which is not the interface's — and branches on connType exactly as the firmware's WAN page does: a PPP disconnect/connect pair, or a DHCP renew. An unrecognised connType is refused rather than guessed. **This drops the line**: it changes the public IPv4 address and can change the delegated IPv6 prefix, and on a DS-Lite line IPv4 rides the v6 session being bounced. Whatever happens is written to the event table with the pre-action connection state.",
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .post(
    '/api/router/actions/reboot',
    async ({ headers, status }) => {
      if (!hasValidBearer(headers)) return status(401, 'Unauthorized')
      if (!writesEnabled()) {
        return status(403, {
          error: 'router writes are disabled',
          hint: 'set LINEWATCH_ROUTER_WRITE=1 to enable; it is off by default and independent of the poller',
        })
      }

      return runAndRecord('router_reboot', () => getRouterExecutor().reboot())
    },
    {
      response: {
        200: ActionResultSchema,
        401: z.string(),
        403: z.object({ error: z.string(), hint: z.string() }),
      },
      detail: {
        tags: ['Router'],
        summary: 'Reboot the router',
        description:
          'The destructive rung. Snapshots DEV2_ADT_WAN first — a reboot resets showtime, zeroes every byte counter and empties the host table, which is exactly the evidence that diagnosed the 2026-08-01 incident — then sends the reboot against the device stack `0,0,0,0,0,0`. **This takes the whole LAN down for roughly two minutes**, Tailscale included, so the machine issuing it loses its own route back. The outcome is deliberately three-valued: `executed` when the device acknowledged, `failed` only when the device explicitly rejected the operation (nothing rebooted, recorded as a `note`), and `unknown` when the transport died or the answer carried no readable errorcode — the expected signature of success, settled only by the probe record over the following minutes, never by this reply.',
        security: [{ BearerAuth: [] }],
      },
    },
  )

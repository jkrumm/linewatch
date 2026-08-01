import { RouterClient, type RouterActionIntent } from './client.js'
import { parseLiveWan, type LiveWan } from './parse.js'

/**
 * The only place in this codebase that writes to the router.
 *
 * Everything else — the poller, the range routes, the whole `GET /api/router`
 * surface — is read-only, and that invariant is worth keeping legible: it is now
 * "the poller stays read-only; writes live in this module, off by default",
 * rather than "nothing here can write".
 *
 * ## Why the surface is this narrow
 *
 * `/js/gdprProxy.js` sends every verb to one URL with the verb inside an
 * AES-encrypted body, so a factory reset and a line-statistics read are
 * indistinguishable to anything on the network. The distinction can only be
 * enforced in code, so it is enforced three times over: the intent union in
 * `client.ts` (no OID crosses a boundary), the frozen whitelist asserted at the
 * send site, and this module exposing zero-argument named methods with no
 * `performAction(oid)` anywhere. `make` targets take no OID parameter either.
 *
 * ## Why `reconnect` reads the router before it acts
 *
 * The stack and the verb are properties of the live connection and must not be
 * hardcoded or configured. `DEV2_ADT_WAN`'s live instance is stack `3,0,0,0,0,0`
 * on this line while `DEV2_IP_INTF`'s `ppp0` is stack 4 — using the interface's
 * stack addresses the wrong object — and the verb depends on `connType`, which
 * decides between a PPP bounce and a DHCP renew. Both are read fresh, from the
 * same session the action goes out on, and an unrecognised `connType` is a
 * refusal rather than a guess.
 *
 * ## What a reconnect actually costs, stated because it is easy to under-sell
 *
 * A re-dial changes the public IPv4 address and can change the delegated IPv6
 * prefix, which invalidates every LAN device's global address. On this line IPv4
 * is carried over DS-Lite, so the v6 session is the one being bounced and the v4
 * softwire rides on top of it — meaning a "reconnect to fix IPv4" breaks IPv6
 * for the whole house on the way.
 *
 * And on the 2026-08-01 incident it would not have helped. The router performed
 * this exact teardown itself, unprompted, at 10:09:38: `ppp0`'s counters reset
 * from 29.4 GB to zero, and twenty-three seconds later it had moved no bytes in
 * either direction while all three WAN anchors stayed at 100% loss for a further
 * 18.5 minutes. The rung survives because a wedge that a PPP bounce *does* clear
 * is a plausible different failure and it is far cheaper than a reboot — not
 * because it is the fix for that one.
 */

export type ActionKind = 'reconnect' | 'reboot'

export interface ActionResult {
  ok: boolean
  /** `live` = it was sent. `null` = the executor is not wired to the router at all. */
  capability: 'live' | 'null'
  /** `executed` | `failed` | `not_executed` | `refused` — what actually happened. */
  outcome: 'executed' | 'failed' | 'not_executed' | 'refused'
  /** The operations sent, in order, with what the router answered. */
  steps: Array<{ oid: string; ok: boolean; errorcode: string | null; httpStatus: number | null }>
  /** The connection state read immediately before acting — the pre-action snapshot. */
  before: LiveWan | null
  detail: string
}

export interface RouterActionExecutor {
  readonly capability: 'live' | 'null'
  reconnect(): Promise<ActionResult>
  reboot(): Promise<ActionResult>
}

/**
 * Ships first and stays the default. It logs, returns `not_executed`, and lets
 * the entire path — route, auth, rate limit, pre-action snapshot, intervention
 * record, and eventually the watchdog ladder above it — be exercised end to end
 * against the real router without ever writing to it. That is how the thresholds
 * get validated before they can cost anything.
 */
export class NullExecutor implements RouterActionExecutor {
  readonly capability = 'null' as const

  private result(kind: ActionKind): ActionResult {
    console.log(`[router] would ${kind} — LINEWATCH_ROUTER_WRITE is not enabled, nothing was sent`)
    return {
      ok: true,
      capability: 'null',
      outcome: 'not_executed',
      steps: [],
      before: null,
      detail: `would ${kind}; the write capability is not enabled`,
    }
  }

  reconnect(): Promise<ActionResult> {
    return Promise.resolve(this.result('reconnect'))
  }

  reboot(): Promise<ActionResult> {
    return Promise.resolve(this.result('reboot'))
  }
}

/**
 * `connType` → the intents that re-dial it, exactly as the firmware's own WAN
 * page branches. A type not in here is refused: guessing a verb against a
 * connection whose kind is not understood is how a "reconnect" becomes
 * something else.
 */
const RECONNECT_PLAN: Readonly<Record<string, readonly RouterActionIntent[]>> = Object.freeze({
  PPPoE: ['ppp_disconnect', 'ppp_connect'],
  PPPoA: ['ppp_disconnect', 'ppp_connect'],
  IPoA: ['ppp_disconnect', 'ppp_connect'],
  StaticIP: ['ppp_disconnect', 'ppp_connect'],
  DHCP: ['dhcp_renew'],
})

/** Between the disconnect and the connect. The firmware's own page reloads 1.5 s after a click. */
const STEP_SPACING_MS = 1_500

export class LiveExecutor implements RouterActionExecutor {
  readonly capability = 'live' as const

  constructor(
    private readonly client: RouterClient,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  async reconnect(): Promise<ActionResult> {
    await this.client.startSession()

    // The pre-action snapshot is a precondition, not a nicety. It supplies the
    // stack and the verb, and it is the only record of what the connection
    // looked like before the action — which the action then destroys, since a
    // re-dial resets the session uptime and the interface byte counters that
    // diagnose everything downstream of it.
    // Deliberately without the poller's `previousName` continuity fallback. The
    // poller carries a connection forward so the *record* does not go blind
    // through an outage; acting on a stack nothing currently vouches for is a
    // different proposition entirely. So when the router reports every instance
    // disconnected this returns null, and the refusal below is the answer.
    const rows = await this.client.read('DEV2_ADT_WAN', 'gl')
    const wan = parseLiveWan(rows)
    if (wan === null || wan.stack === null) {
      return this.refused(null, 'the router reports no connected WAN instance — nothing was sent')
    }

    const plan = wan.connType === null ? undefined : RECONNECT_PLAN[wan.connType]
    if (plan === undefined) {
      return this.refused(wan, `unrecognised connType ${JSON.stringify(wan.connType)} — refusing to guess a reconnect verb`)
    }

    const steps: ActionResult['steps'] = []
    for (const [index, intent] of plan.entries()) {
      if (index > 0) await this.sleep(STEP_SPACING_MS)
      const response = await this.client.sendAction({ intent, stack: wan.stack })
      steps.push({ oid: response.oid, ok: response.ok, errorcode: response.errorcode, httpStatus: response.httpStatus })
      // A failed disconnect does not license firing the connect: the pair is a
      // sequence, and half of it is a state nobody asked for.
      if (!response.ok) break
    }

    const ok = steps.length === plan.length && steps.every((step) => step.ok)
    return {
      ok,
      capability: 'live',
      outcome: ok ? 'executed' : 'failed',
      steps,
      before: wan,
      detail: ok
        ? `reconnected ${wan.connType} on stack ${wan.stack} (${steps.map((s) => s.oid).join(' then ')})`
        : `reconnect did not complete: ${steps.map((s) => `${s.oid}=${s.ok ? 'ok' : (s.errorcode ?? s.httpStatus ?? 'no answer')}`).join(', ')}`,
    }
  }

  /**
   * Not implemented, deliberately, and this is the honest state rather than an
   * oversight. The operation name is the one thing §7's evidence does not
   * settle — `restart.htm` says `ACT_OP_REBOOT`, `sysMode.htm` says
   * `ACT_REBOOT` — and a reboot is the one action whose transport error the
   * firmware swallows, because the device dies before answering. So a wrong
   * name and a successful reboot look identical from here: no reply either way.
   *
   * Sending an unverified destructive constant and reading "no answer" as
   * success is exactly the class of mistake the whitelist exists to prevent.
   * The name has to be confirmed from the device before this does anything.
   */
  reboot(): Promise<ActionResult> {
    return Promise.resolve({
      ok: false,
      capability: 'live',
      outcome: 'refused',
      steps: [],
      before: null,
      detail:
        'reboot is not implemented: the firmware operation name is unconfirmed, and a reboot swallows its own transport error, so a wrong name is indistinguishable from a successful one',
    })
  }

  private refused(before: LiveWan | null, detail: string): ActionResult {
    console.warn(`[router] reconnect refused — ${detail}`)
    return { ok: false, capability: 'live', outcome: 'refused', steps: [], before, detail }
  }
}

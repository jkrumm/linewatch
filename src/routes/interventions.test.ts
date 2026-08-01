import { beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'

/**
 * Route-level tests for attribution, over real HTTP.
 *
 * Everything here is about one property: the record must say who acted. A
 * recovery two minutes after an action is indistinguishable from one that would
 * have happened anyway, so the only thing separating "the reboot fixed it" from
 * "it fixed itself while someone happened to be rebooting" is this row — and if
 * a machine's action is stored as a human's, the question "does rebooting
 * actually fix this line?" becomes permanently unanswerable no matter how much
 * data accumulates.
 */

process.env['LINEWATCH_DB'] = ':memory:'
process.env['LINEWATCH_TOKEN'] ??= 'test-token-not-the-real-one'

const { interventionsRoutes } = await import('./interventions.js')
const { db } = await import('../db/client.js')
const { event } = await import('../db/schema.js')
const { config } = await import('../config.js')

const app = new Elysia().use(interventionsRoutes)

function post(body: unknown, token: string | null = config.token) {
  return app.handle(
    new Request('http://local/api/interventions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
  )
}

function rows() {
  return db
    .select()
    .from(event)
    .all()
    .map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }))
}

describe('POST /api/interventions', () => {
  beforeEach(() => {
    db.delete(event).run()
  })

  test('rejects an unauthenticated write to the historical record', async () => {
    expect((await post({ action: 'power-cycled the router' }, null)).status).toBe(401)
    expect((await post({ action: 'power-cycled the router' }, 'wrong')).status).toBe(401)
    expect(rows()).toHaveLength(0)
  })

  test('defaults to a human intervention, which is what `make intervention` sends', async () => {
    const response = await post({ action: 'swapped the LAN cable', note: 'suspected a bad crimp' })
    expect(response.status).toBe(200)

    const [row] = rows()
    expect(row?.kind).toBe('intervention')
    expect(row?.detail).toMatchObject({
      source: 'manual',
      action: 'swapped the LAN cable',
      note: 'suspected a bad crimp',
    })
  })

  test('records a machine action as one, with its evidence', async () => {
    await post({
      source: 'watchdog',
      action: 'router_reconnect',
      detail: { rung: 'reconnect', outcome: 'executed', downForS: 241 },
    })

    const [row] = rows()
    expect(row?.kind).toBe('intervention')
    expect(row?.detail).toMatchObject({
      source: 'watchdog',
      action: 'router_reconnect',
      rung: 'reconnect',
      outcome: 'executed',
      downForS: 241,
    })
  })

  /**
   * `intervention` has to keep meaning "something was done to the line". A
   * suppressed or blocked action recorded as one would credit the actor for a
   * line that recovered on its own — the same failure the route exists to
   * prevent for humans, committed by the thing built to avoid it.
   */
  test('keeps a suppressed action out of the intervention record', async () => {
    await post({
      kind: 'note',
      source: 'watchdog',
      action: 'would_reboot',
      detail: { blockedBy: ['disarmed'] },
    })

    const [row] = rows()
    expect(row?.kind).toBe('note')
    expect(row?.detail).toMatchObject({ source: 'watchdog', action: 'would_reboot' })
  })

  /**
   * The back door. `detail` is caller-supplied and gets merged, so a body that
   * smuggles `source: 'manual'` inside it must not be able to launder a machine
   * action into a human one — that is the exact lie this route prevents,
   * arriving by a different route than the one that is guarded.
   */
  test('cannot be told to attribute a watchdog action to a human via detail', async () => {
    await post({
      source: 'watchdog',
      action: 'router_reboot',
      detail: { source: 'manual', action: 'a human definitely did this' },
    })

    const [row] = rows()
    expect(row?.detail).toMatchObject({ source: 'watchdog', action: 'router_reboot' })
  })

  test('accepts a backdated timestamp, for recording after the fact', async () => {
    const ts = 1_700_000_000_000
    const response = await post({ action: 'power-cycled the router', ts })
    expect(await response.json()).toMatchObject({ ok: true, ts })
    expect(rows()[0]?.ts).toBe(ts)
  })

  test('refuses an empty action, which would record that something happened and not what', async () => {
    expect((await post({ action: '' })).status).toBe(422)
    expect(rows()).toHaveLength(0)
  })
})

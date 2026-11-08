import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import type { ActionResult, RouterActionExecutor } from '../services/router/actions.js'
import type { RouterClient } from '../services/router/client.js'
import type { RouterPoller } from '../services/router/poll.js'

/**
 * Route-level tests for the three routes that reach the router: the bearer
 * check, the write gate, the poll rate limit, and what each action leaves in
 * the `event` table. The attribution is the point — a reboot the device
 * rejected must not read as an intervention, and an executor that throws must
 * still leave a row.
 *
 * The DB is shared by every route test in the process, so each test deletes the
 * rows it created (by id) rather than clearing the table.
 */

process.env['LINEWATCH_DB'] = ':memory:'
process.env['LINEWATCH_TOKEN'] ??= 'test-token-not-the-real-one'

const { routerActionRoutes } = await import('./router-actions.js')
const { routerRoutes } = await import('./router.js')
const { db } = await import('../db/client.js')
const { event } = await import('../db/schema.js')
const { config } = await import('../config.js')
const { setRouterRuntimeForTest } = await import('../services/router/scheduler.js')
const { RouterUnreachableError } = await import('../services/router/client.js')
const { inArray } = await import('drizzle-orm')

const app = new Elysia().use(routerActionRoutes).use(routerRoutes)

let baselineIds = new Set<number>()

function allIds(): number[] {
  return db
    .select({ id: event.id })
    .from(event)
    .all()
    .map((row) => row.id)
}

function myRows() {
  return db
    .select()
    .from(event)
    .all()
    .filter((row) => !baselineIds.has(row.id))
    .map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }))
}

beforeEach(() => {
  baselineIds = new Set(allIds())
})

afterEach(() => {
  const mine = allIds().filter((id) => !baselineIds.has(id))
  if (mine.length > 0) db.delete(event).where(inArray(event.id, mine)).run()
  setRouterRuntimeForTest({ poller: null, client: null, executor: nullExecutor() })
})

function result(over: Partial<ActionResult>): ActionResult {
  return {
    ok: true,
    capability: 'live',
    outcome: 'executed',
    steps: [],
    before: null,
    detail: 'test',
    ...over,
  }
}

function nullExecutor(): RouterActionExecutor {
  const answer = () =>
    Promise.resolve(result({ capability: 'null', outcome: 'not_executed', detail: 'would act' }))
  return { capability: 'null', reconnect: answer, reboot: answer }
}

function liveExecutor(reconnect: () => Promise<ActionResult>, reboot = reconnect) {
  return { capability: 'live', reconnect, reboot } satisfies RouterActionExecutor
}

function install(executor: RouterActionExecutor, poll?: () => Promise<unknown>) {
  const poller = poll === undefined ? null : ({ poll } as unknown as RouterPoller)
  const client =
    poll === undefined ? null : ({ status: () => ({ logins: 1 }) } as unknown as RouterClient)
  setRouterRuntimeForTest({ poller, client, executor })
}

function post(path: string, token: string | null = config.token) {
  return app.handle(
    new Request(`http://local${path}`, {
      method: 'POST',
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    }),
  )
}

const summary = (outcome: 'complete' | 'partial') => ({
  outcome,
  lineStatus: 'Up',
  downSyncKbps: 1,
  upSyncKbps: 1,
  wanIfName: 'ppp0',
  wanRxKbps: 0,
  wanTxKbps: 0,
  lanRxKbps: 0,
  lanTxKbps: 0,
  intfRows: 0,
  portRows: 0,
  hostRows: 0,
  readsOk: 8,
  abandonedAt: null,
  resync: false,
  sessionRestarts: [],
  disagreements: [],
  warnings: [],
})

describe.each(['/api/router/poll', '/api/router/actions/reconnect', '/api/router/actions/reboot'])(
  'POST %s bearer check',
  (path) => {
    test('rejects a missing and a wrong bearer without touching the router', async () => {
      let calls = 0
      const count = () => {
        calls += 1
        return Promise.resolve(result({}))
      }
      install(liveExecutor(count), () => Promise.resolve(summary('complete')))
      expect((await post(path, null)).status).toBe(401)
      expect((await post(path, 'wrong')).status).toBe(401)
      expect(calls).toBe(0)
      expect(myRows()).toHaveLength(0)
    })
  },
)

describe('the write gate', () => {
  test.each(['/api/router/actions/reconnect', '/api/router/actions/reboot'])(
    '%s answers 403 while the executor is not live',
    async (path) => {
      install(nullExecutor())
      const response = await post(path)
      expect(response.status).toBe(403)
      expect(myRows()).toHaveLength(0)
    },
  )
})

describe('POST /api/router/poll', () => {
  test('answers 503 when no poller is configured', async () => {
    expect((await post('/api/router/poll')).status).toBe(503)
  })

  test('answers the real outcome and then rate-limits with 429', async () => {
    install(nullExecutor(), () => Promise.resolve(summary('complete')))
    const first = await post('/api/router/poll')
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, outcome: 'complete' })
    const second = await post('/api/router/poll')
    expect(second.status).toBe(429)
  })

  test('a failed login is reported, recorded as a note, and still rate-limited', async () => {
    install(nullExecutor(), () => Promise.reject(new RouterUnreachableError('no route')))
    const first = await post('/api/router/poll')
    expect(first.status).toBe(502)
    expect(await first.json()).toMatchObject({ ok: false, outcome: 'login_failed' })

    const rows = myRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('note')
    expect(rows[0]?.detail['reason']).toBe('login_failed')

    expect((await post('/api/router/poll')).status).toBe(429)
  })
})

describe('action attribution', () => {
  test.each([
    ['executed', 'intervention'],
    ['unknown', 'intervention'],
    ['failed', 'note'],
    ['refused', 'note'],
  ] as const)('a reboot that is %s is recorded as a %s', async (outcome, kind) => {
    install(liveExecutor(() => Promise.resolve(result({ outcome, ok: outcome !== 'failed' }))))
    const response = await post('/api/router/actions/reboot')
    expect(response.status).toBe(200)
    const rows = myRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe(kind)
    expect(rows[0]?.detail).toMatchObject({ action: 'router_reboot', outcome })
  })

  test('a reconnect that failed part-way is an intervention, with its partial steps', async () => {
    const steps = [{ oid: 'X', ok: true, errorcode: '0', httpStatus: 200 }]
    install(liveExecutor(() => Promise.resolve(result({ outcome: 'failed', ok: false, steps }))))
    await post('/api/router/actions/reconnect')
    const rows = myRows()
    expect(rows[0]?.kind).toBe('intervention')
    expect(rows[0]?.detail['steps']).toEqual(steps)
  })

  test('a suppressed write stays a note', async () => {
    install(
      liveExecutor(() => Promise.resolve(result({ outcome: 'not_executed', capability: 'null' }))),
    )
    await post('/api/router/actions/reconnect')
    expect(myRows()[0]?.kind).toBe('note')
  })

  test('an executor that throws still leaves a record, and the route answers 500', async () => {
    install(liveExecutor(() => Promise.reject(new Error('boom'))))
    const response = await post('/api/router/actions/reboot')
    expect(response.status).toBe(500)
    const rows = myRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('note')
    expect(rows[0]?.detail).toMatchObject({ action: 'router_reboot', outcome: 'error' })
    expect(String(rows[0]?.detail['note'])).toContain('boom')
  })
})

describe('GET /api/router writeEnabled', () => {
  async function writeEnabled(): Promise<boolean> {
    const response = await app.handle(new Request('http://local/api/router'))
    expect(response.status).toBe(200)
    return ((await response.json()) as { writeEnabled: boolean }).writeEnabled
  }

  test('is false while the executor is a NullExecutor', async () => {
    install(nullExecutor())
    expect(await writeEnabled()).toBe(false)
  })

  test('is true once the executor is live', async () => {
    install(liveExecutor(() => Promise.resolve(result({}))))
    expect(await writeEnabled()).toBe(true)
  })
})

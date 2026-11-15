import { describe, expect, test } from 'bun:test'
import { decide, DEFAULT_POLICY, emptyLedger, type LadderInput } from './watchdog-ladder.js'
import {
  POLL_REQUEST_MIN_GAP_MS,
  requestRouterPoll,
  wantsOnDemandPoll,
  type PollRequestDeps,
} from './watchdog-poll-request.js'

const T0 = Date.UTC(2026, 10, 15, 8, 0, 0)
const ALL_WAN_DOWN = [
  { target: 'cloudflare', received: 0 },
  { target: 'google', received: 0 },
  { target: 'quad9', received: 0 },
]

/**
 * A reboot rung that is due and fully authorised except for what a test
 * removes. Built on the real `decide()` so the request condition is pinned
 * against the ladder's own blocker list, not a copy of it.
 */
function rebootDue(over: Partial<LadderInput> = {}): LadderInput {
  const now = T0 + DEFAULT_POLICY.rebootAtS * 1000 + 5_000
  return {
    now,
    policy: { ...DEFAULT_POLICY, armed: true, rebootEnabled: true },
    record: {
      newestSampleTs: now - 10_000,
      ongoingWanOutage: { startedAt: T0, cycles: 8 },
      ongoingGatewayOutage: null,
      gateway: { target: 'gateway', received: 20 },
      wanAnchors: ALL_WAN_DOWN,
      onHomeLine: true,
      gatewayAddr: '192.168.1.1',
      linkWatchS: 30,
      speedtestRunning: false,
    },
    self: {
      probeTs: now,
      gateway: { target: 'gateway', received: 5 },
      wanAnchors: ALL_WAN_DOWN,
      v6: { target: 'v6', received: 0 },
      onHomeLine: 1,
      pathClass: 'ethernet',
      gatewayAddr: '192.168.1.1',
    },
    carrier: { stale: false, lineStatus: 'Up', showtimeStartS: 4000, freshPollAgeS: 900 },
    ledger: {
      ...emptyLedger(),
      ladder: {
        outageKey: `wan:${T0}`,
        t0: T0,
        rung: 'reconnect',
        enteredAt: T0,
        settleUntil: null,
        announcedAt: null,
      },
      v6: { lastUpTs: now - 60_000, lastCheckedTs: now },
    },
    trusted: true,
    processStartedAt: now - 3_600_000,
    disarmed: false,
    capability: 'live',
    lastHumanInterventionTs: null,
    heldTicks: 8,
    canRecord: true,
    ...over,
  }
}

function wants(input: LadderInput, over: { lastRequestedAt?: number | null } = {}): boolean {
  const outcome = decide(input)
  return wantsOnDemandPoll({
    rung: outcome.rung,
    blockedBy: outcome.blockedBy,
    now: input.now,
    lastRequestedAt: over.lastRequestedAt ?? null,
    minGapMs: POLL_REQUEST_MIN_GAP_MS,
  })
}

function announced(input: LadderInput, agoMs: number): LadderInput {
  return {
    ...input,
    ledger: {
      ...input.ledger,
      ladder: { ...input.ledger.ladder, announcedAt: input.now - agoMs },
    },
  }
}

describe('wantsOnDemandPoll against the real ladder', () => {
  test('asks when the rung is due and only the stale reading stops the announce', () => {
    const input = rebootDue()
    expect(decide(input).blockedBy).toEqual(['no_fresh_poll', 'not_announced'])
    expect(wants(input)).toBe(true)
  })

  test('asks again once the announce lead has passed and the reading went stale', () => {
    const input = announced(rebootDue(), 61_000)
    expect(decide(input).blockedBy).toEqual(['no_fresh_poll'])
    expect(wants(input)).toBe(true)
  })

  test('does not ask while the announce lead is still running', () => {
    const input = announced(rebootDue(), 20_000)
    expect(decide(input).blockedBy).toContain('announce_pending')
    expect(wants(input)).toBe(false)
  })

  test('does not ask when the reading is already fresh', () => {
    const input = rebootDue({
      carrier: { stale: false, lineStatus: 'Up', showtimeStartS: 4000, freshPollAgeS: 10 },
    })
    expect(wants(input)).toBe(false)
  })

  test('asks when the carrier could not be read at all, since that is also no_fresh_poll', () => {
    expect(wants(rebootDue({ carrier: null }))).toBe(true)
  })

  test('never asks while the reboot rung is switched off — deploying this changes nothing', () => {
    const input = rebootDue({ policy: { ...DEFAULT_POLICY, armed: true, rebootEnabled: false } })
    expect(decide(input).blockedBy).toContain('reboot_disabled')
    expect(wants(input)).toBe(false)
  })

  test('never asks when the watchdog is not armed', () => {
    const input = rebootDue({ policy: { ...DEFAULT_POLICY, armed: false, rebootEnabled: true } })
    expect(decide(input).blockedBy).toContain('not_armed')
    expect(wants(input)).toBe(false)
  })

  test('never asks while a human has the disarm file down', () => {
    const input = rebootDue({ disarmed: true })
    expect(decide(input).blockedBy.length).toBeGreaterThan(2)
    expect(wants(input)).toBe(false)
  })

  test('never asks on the reconnect rung, which has no freshness gate', () => {
    const input = rebootDue({
      now: T0 + 200_000,
      carrier: { stale: false, lineStatus: 'Up', showtimeStartS: 4000, freshPollAgeS: 900 },
    })
    expect(decide(input).rung).not.toBe('reboot')
    expect(wants(input)).toBe(false)
  })

  test('never asks for a rung that is rate-limited, whatever the reading', () => {
    const input = rebootDue()
    const limited: LadderInput = {
      ...input,
      ledger: {
        ...input.ledger,
        actions: [
          {
            ts: input.now - 3_600_000,
            kind: 'reboot',
            outageKey: 'wan:old',
            outcome: 'executed',
          },
        ],
      },
    }
    expect(decide(limited).blockedBy).toContain('reboot_min_interval')
    expect(wants(limited)).toBe(false)
  })

  test('holds its own gap, so a stuck rung is not a request every tick', () => {
    const input = rebootDue()
    expect(wants(input, { lastRequestedAt: input.now - 15_000 })).toBe(false)
    expect(wants(input, { lastRequestedAt: input.now - (POLL_REQUEST_MIN_GAP_MS - 1) })).toBe(false)
    expect(wants(input, { lastRequestedAt: input.now - POLL_REQUEST_MIN_GAP_MS })).toBe(true)
  })
})

describe('wantsOnDemandPoll on blocker lists the ladder does not yet produce', () => {
  const base = { rung: 'reboot', now: 1_000_000, lastRequestedAt: null, minGapMs: 120_000 }

  test('an unknown blocker beside no_fresh_poll fails closed', () => {
    expect(wantsOnDemandPoll({ ...base, blockedBy: ['no_fresh_poll', 'some_new_blocker'] })).toBe(
      false,
    )
  })

  test('no_fresh_poll absent means nothing to ask for', () => {
    expect(wantsOnDemandPoll({ ...base, blockedBy: ['not_announced'] })).toBe(false)
    expect(wantsOnDemandPoll({ ...base, blockedBy: [] })).toBe(false)
  })
})

describe('requestRouterPoll', () => {
  function deps(respond: () => Promise<Response>, seen?: Request[]): PollRequestDeps {
    return {
      fetch: ((url: string, init: RequestInit) => {
        seen?.push(new Request(url, init))
        return respond()
      }) as unknown as typeof fetch,
      apiUrl: 'http://api.test',
      token: 'secret-token',
      timeoutMs: 1_000,
    }
  }

  test('POSTs the poll route with the bearer', async () => {
    const seen: Request[] = []
    const outcome = await requestRouterPoll(
      deps(async () => Response.json({ ok: true, outcome: 'complete' }), seen),
    )
    expect(outcome).toEqual({ kind: 'complete' })
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.url).toBe('http://api.test/api/router/poll')
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer secret-token')
  })

  test('a partial poll is reported as partial', async () => {
    const outcome = await requestRouterPoll(
      deps(async () => Response.json({ ok: true, outcome: 'partial' })),
    )
    expect(outcome).toEqual({ kind: 'partial' })
  })

  test.each([
    [429, { kind: 'rate_limited' }],
    [409, { kind: 'busy' }],
    [502, { kind: 'failed', status: 502 }],
    [503, { kind: 'failed', status: 503 }],
    [401, { kind: 'failed', status: 401 }],
  ])('HTTP %i is classified without throwing', async (status, expected) => {
    const outcome = await requestRouterPoll(
      deps(async () => Response.json({ ok: false }, { status })),
    )
    expect(outcome).toEqual(expected as never)
  })

  test('a thrown fetch is no_answer, not an exception', async () => {
    const outcome = await requestRouterPoll(
      deps(async () => {
        throw new Error('connection refused')
      }),
    )
    expect(outcome).toEqual({ kind: 'no_answer', reason: 'connection refused' })
  })

  test('an unreadable 200 body is no_answer rather than a crash', async () => {
    const outcome = await requestRouterPoll(deps(async () => new Response('not json')))
    expect(outcome.kind).toBe('no_answer')
  })

  test('a hung answer is cut off by the timeout', async () => {
    const outcome = await requestRouterPoll({
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })) as unknown as typeof fetch,
      apiUrl: 'http://api.test',
      token: 't',
      timeoutMs: 20,
    })
    expect(outcome.kind).toBe('no_answer')
  })
})

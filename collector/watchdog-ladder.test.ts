import { describe, expect, test } from 'bun:test'
import {
  classify,
  decide,
  DEFAULT_POLICY,
  type CarrierEvidence,
  type LadderInput,
  type Ledger,
  type RecordEvidence,
  type SelfEvidence,
  type WatchdogPolicy,
} from './watchdog-ladder.js'

/**
 * Table-driven over the pure decision, which is the only place this system has
 * judgement. Three of these replay real windows out of the database, because the
 * thing most likely to be wrong about a watchdog is not its code but its
 * thresholds — and the record contains exactly one event it should have acted
 * on and three it should have left alone.
 */

const T0 = Date.UTC(2026, 7, 1, 10, 9, 4)

function ledger(over: Partial<Ledger> = {}): Ledger {
  return {
    version: 1,
    ladder: { outageKey: null, t0: null, rung: 'observe', enteredAt: 0, settleUntil: null, announcedAt: null },
    actions: [],
    pending: null,
    v6: { lastUpTs: null, lastCheckedTs: null },
    postActionCooldownUntil: null,
    lastEscalationTs: null,
    consecutiveActions: 0,
    healthySince: null,
    ...over,
  }
}

function record(over: Partial<RecordEvidence> = {}): RecordEvidence {
  return {
    newestSampleTs: T0,
    ongoingWanOutage: null,
    ongoingGatewayOutage: null,
    gateway: { target: 'gateway', received: 20 },
    wanAnchors: [
      { target: 'cloudflare', received: 20 },
      { target: 'google', received: 20 },
      { target: 'quad9', received: 20 },
    ],
    onHomeLine: true,
    pathClass: 'ethernet',
    gatewayAddr: '192.168.1.1',
    linkWatchS: 30,
    speedtestRunning: false,
    ...over,
  }
}

function self(over: Partial<SelfEvidence> = {}): SelfEvidence {
  return {
    probeTs: T0,
    gateway: { target: 'gateway', received: 5 },
    wanAnchors: [
      { target: 'cloudflare', received: 5 },
      { target: 'google', received: 5 },
      { target: 'quad9', received: 5 },
    ],
    v6: { target: 'cloudflare-v6', received: 5 },
    onHomeLine: 1,
    pathClass: 'ethernet',
    gatewayAddr: '192.168.1.1',
    ...over,
  }
}

const ALL_WAN_DOWN = [
  { target: 'cloudflare', received: 0 },
  { target: 'google', received: 0 },
  { target: 'quad9', received: 0 },
]

/** Everything a fully-authorised action needs, so a test can remove one thing at a time. */
function armedInput(over: Partial<LadderInput> = {}): LadderInput {
  const now = T0 + 250_000
  const policy: WatchdogPolicy = { ...DEFAULT_POLICY, armed: true }
  return {
    now,
    policy,
    record: record({
      newestSampleTs: now - 10_000,
      wanAnchors: ALL_WAN_DOWN,
      ongoingWanOutage: { startedAt: T0, cycles: 8, evidence: ['cloudflare', 'google', 'quad9'] },
    }),
    self: self({ probeTs: now, wanAnchors: ALL_WAN_DOWN, v6: { target: 'v6', received: 0 } }),
    carrier: null,
    ledger: ledger({ v6: { lastUpTs: now - 60_000, lastCheckedTs: now } }),
    processStartedAt: now - 3_600_000,
    disarmed: false,
    capability: 'live',
    lastHumanInterventionTs: null,
    heldTicks: 8,
    canRecord: true,
    ...over,
  }
}

describe('classify', () => {
  test('a clean line is healthy', () => {
    expect(classify(armedInput({ record: record(), self: self() }))).toBe('healthy')
  })

  test('one anchor down is partial, not an outage', () => {
    const anchors = [
      { target: 'cloudflare', received: 0 },
      { target: 'google', received: 5 },
      { target: 'quad9', received: 5 },
    ]
    const input = armedInput({ record: record({ wanAnchors: anchors }), self: self({ wanAnchors: anchors }) })
    expect(classify(input)).toBe('partial')
  })

  test('a reachable v6 anchor makes it v4-only, not a full WAN failure', () => {
    const input = armedInput({ self: self({ wanAnchors: ALL_WAN_DOWN, v6: { target: 'v6', received: 5 } }) })
    expect(classify(input)).toBe('v4_only_down')
  })

  /** The watchdog does not infer a negative from a channel it has never seen work. */
  test('an IPv6 anchor that has never answered is unknown, not down', () => {
    const input = armedInput({
      self: self({ wanAnchors: ALL_WAN_DOWN, v6: { target: 'v6', received: 0 } }),
      ledger: ledger({ v6: { lastUpTs: null, lastCheckedTs: T0 } }),
    })
    expect(classify(input)).toBe('wan_down_v6_unknown')
  })

  test('a v6 baseline older than a day is no longer a baseline', () => {
    const now = T0 + 250_000
    const input = armedInput({
      self: self({ wanAnchors: ALL_WAN_DOWN, v6: { target: 'v6', received: 0 } }),
      ledger: ledger({ v6: { lastUpTs: now - 2 * 86_400_000, lastCheckedTs: now } }),
    })
    expect(classify(input)).toBe('wan_down_v6_unknown')
  })

  test('an unreachable gateway is named as the router, not the WAN', () => {
    const input = armedInput({ self: self({ wanAnchors: ALL_WAN_DOWN, gateway: { target: 'gateway', received: 0 } }) })
    expect(classify(input)).toBe('local_link_down')
  })

  test('a line not in showtime cannot be helped locally', () => {
    const carrier: CarrierEvidence = { stale: false, lineStatus: 'Down', showtimeStartS: null, freshPollAgeS: 5 }
    expect(classify(armedInput({ carrier }))).toBe('carrier_down')
  })

  /** Absence of carrier evidence is not evidence. The poller stores under half its due polls. */
  test('a stale carrier reading does not veto anything', () => {
    const carrier: CarrierEvidence = { stale: true, lineStatus: 'Down', showtimeStartS: null, freshPollAgeS: null }
    expect(classify(armedInput({ carrier }))).toBe('full_wan_down')
  })

  test('measuring some other uplink outranks every WAN class', () => {
    expect(classify(armedInput({ self: self({ wanAnchors: ALL_WAN_DOWN, onHomeLine: 0 }) }))).toBe('off_home_line')
    expect(classify(armedInput({ self: self({ wanAnchors: ALL_WAN_DOWN, onHomeLine: null }) }))).toBe('off_home_line')
  })

  /** Disagreement is never resolved by believing the alarming source. */
  test('a self-probe that disagrees with the record does not produce an outage class', () => {
    const input = armedInput({ record: record({ newestSampleTs: T0 + 240_000 }), self: self({ wanAnchors: ALL_WAN_DOWN }) })
    expect(classify(input)).toBe('partial')
  })

  test('no usable evidence at all is its own class', () => {
    expect(classify(armedInput({ record: null, self: null }))).toBe('no_evidence')
  })
})

describe('decide', () => {
  test('a fully authorised reconnect fires', () => {
    const decision = decide(armedInput())
    expect(decision.blockedBy).toEqual([])
    expect(decision.action).toBe('reconnect')
    expect(decision.state).toBe('armed')
    expect(decision.shadow).toBe(false)
  })

  /**
   * The defect that made two weeks of shadow mode worthless: executor
   * capability used to be a precondition, so the machine could never reach
   * `armed` with a NullExecutor wired in and no `would_*` note was ever
   * written. The whole point of shadow mode is the output.
   */
  test('shadow mode reports the action it would have taken', () => {
    const decision = decide(armedInput({ capability: 'null' }))
    expect(decision.blockedBy).toEqual([])
    expect(decision.state).toBe('armed')
    expect(decision.action).toBe('none')
    expect(decision.shadow).toBe(true)
    expect(decision.note).toContain('would reconnect')
  })

  test('it does nothing at all until it is armed', () => {
    const decision = decide(armedInput({ policy: { ...DEFAULT_POLICY, armed: false } }))
    expect(decision.blockedBy).toContain('not_armed')
    expect(decision.action).toBe('none')
  })

  test('the disarm file wins on its own', () => {
    expect(decide(armedInput({ disarmed: true })).blockedBy).toContain('disarmed_file')
  })

  /** A stand-down whose reason is a single name is a stand-down nobody can debug at 03:00. */
  test('every failed precondition is reported, not just the first', () => {
    const decision = decide(
      armedInput({ disarmed: true, canRecord: false, policy: { ...DEFAULT_POLICY, armed: false } }),
    )
    expect(decision.blockedBy).toContain('disarmed_file')
    expect(decision.blockedBy).toContain('not_armed')
    expect(decision.blockedBy).toContain('cannot_record')
    expect(decision.blockedBy.length).toBeGreaterThanOrEqual(3)
  })

  test('an action that cannot be recorded is not taken', () => {
    expect(decide(armedInput({ canRecord: false })).blockedBy).toEqual(['cannot_record'])
  })

  test('a human already working on it stands the ladder down', () => {
    const input = armedInput()
    const decision = decide({ ...input, lastHumanInterventionTs: input.now - 60_000 })
    expect(decision.blockedBy).toContain('human_quiet_period')
  })

  test('a freshly started process acts on nothing', () => {
    const input = armedInput()
    const decision = decide({ ...input, processStartedAt: input.now - 10_000 })
    expect(decision.blockedBy).toContain('process_too_young')
  })

  test('an in-flight speed test is waited out rather than poisoned', () => {
    const input = armedInput()
    const decision = decide({
      ...input,
      record: { ...input.record!, speedtestRunning: true },
    })
    expect(decision.blockedBy).toContain('speedtest_running')
  })

  test('incomplete link-sampler coverage blocks, because absence is not stability', () => {
    const input = armedInput()
    const decision = decide({ ...input, record: { ...input.record!, linkWatchS: 12 } })
    expect(decision.blockedBy).toContain('link_coverage_incomplete')
  })

  test('a line that just resynced is given a moment', () => {
    const carrier: CarrierEvidence = { stale: false, lineStatus: 'Up', showtimeStartS: 23, freshPollAgeS: 5 }
    expect(decide(armedInput({ carrier })).blockedBy).toContain('resync_grace')
  })

  test('the timer and the cycle count must agree', () => {
    const input = armedInput()
    const decision = decide({
      ...input,
      heldTicks: 2,
      record: { ...input.record!, ongoingWanOutage: { startedAt: T0, cycles: 3, evidence: [] } },
    })
    expect(decision.blockedBy).toContain('insufficient_cycles')
  })

  test('an unconfirmed class starts no clock', () => {
    const decision = decide(armedInput({ heldTicks: 1 }))
    expect(decision.state).toBe('suspect')
    expect(decision.action).toBe('none')
  })

  test('a pending action is treated as having fired', () => {
    const decision = decide(
      armedInput({ ledger: ledger({ pending: { ts: T0, kind: 'reconnect', outageKey: 'wan:1' } }) }),
    )
    expect(decision.state).toBe('settling')
    expect(decision.action).toBe('none')
    expect(decision.note).toContain('counted as fired')
  })

  test('the latch self-disarms and stays that way', () => {
    const decision = decide(armedInput({ ledger: ledger({ consecutiveActions: 2 }) }))
    expect(decision.state).toBe('latched')
    expect(decision.action).toBe('none')
    expect(decision.note).toContain('needs a human')
  })

  test('rate limits stand the rung down rather than stalling it', () => {
    const input = armedInput()
    const actions = Array.from({ length: 6 }, (_, i) => ({
      ts: input.now - (i + 1) * 3_600_001,
      kind: 'reconnect' as const,
      outageKey: `wan:${i}`,
      outcome: 'executed' as const,
    }))
    const decision = decide({ ...input, ledger: ledger({ actions, v6: { lastUpTs: input.now, lastCheckedTs: input.now } }) })
    expect(decision.blockedBy).toContain('reconnect_rate_limit')
  })
})

describe('the reboot rung', () => {
  function rebootDue(over: Partial<LadderInput> = {}): LadderInput {
    const input = armedInput()
    const now = T0 + DEFAULT_POLICY.rebootAtS * 1000 + 5_000
    return {
      ...input,
      now,
      policy: { ...DEFAULT_POLICY, armed: true, rebootEnabled: true },
      record: { ...input.record!, newestSampleTs: now - 10_000 },
      self: { ...input.self!, probeTs: now },
      carrier: { stale: false, lineStatus: 'Up', showtimeStartS: 4000, freshPollAgeS: 10 },
      ledger: ledger({
        ladder: { outageKey: `wan:${T0}`, t0: T0, rung: 'reconnect', enteredAt: T0, settleUntil: null, announcedAt: null },
        v6: { lastUpTs: now - 60_000, lastCheckedTs: now },
      }),
      ...over,
    }
  }

  test('announces before it fires, so the abort window is real', () => {
    const decision = decide(rebootDue())
    expect(decision.state).toBe('pre_announce')
    expect(decision.action).toBe('announce')
  })

  test('fires once the announcement has been standing long enough', () => {
    const input = rebootDue()
    const decision = decide({
      ...input,
      ledger: {
        ...input.ledger,
        ladder: { ...input.ledger.ladder, announcedAt: input.now - 61_000 },
      },
    })
    expect(decision.blockedBy).toEqual([])
    expect(decision.action).toBe('reboot')
  })

  test('is never reached without the cheap rung having been tried', () => {
    const input = rebootDue()
    const decision = decide({
      ...input,
      ledger: { ...input.ledger, ladder: { ...input.ledger.ladder, rung: 'observe', announcedAt: input.now - 61_000 } },
    })
    // At this point the reconnect rung is what is due instead.
    expect(decision.rung).toBe('reconnect')
  })

  test('needs a successful poll in the last minute — no writing to what cannot be read', () => {
    const input = rebootDue()
    const decision = decide({
      ...input,
      carrier: { stale: false, lineStatus: 'Up', showtimeStartS: 4000, freshPollAgeS: 900 },
      ledger: { ...input.ledger, ladder: { ...input.ledger.ladder, announcedAt: input.now - 61_000 } },
    })
    expect(decision.blockedBy).toContain('no_fresh_poll')
  })

  test('stays off behind its own switch even when everything else passes', () => {
    const input = rebootDue()
    const decision = decide({
      ...input,
      policy: { ...input.policy, rebootEnabled: false },
      ledger: { ...input.ledger, ladder: { ...input.ledger.ladder, announcedAt: input.now - 61_000 } },
    })
    expect(decision.blockedBy).toContain('reboot_disabled')
  })

  /**
   * The defect that made this rung structurally unreachable for the class it
   * would most often see. Two preconditions consulted `rebootOnV4Only`, which
   * the default policy did not define — so it read `undefined`, blocked
   * forever, and on a DS-Lite line `v4_only_down` is the expected class.
   */
  test('the v4-only switch exists and defaults to off', () => {
    expect(DEFAULT_POLICY).toHaveProperty('rebootOnV4Only')
    expect(DEFAULT_POLICY.rebootOnV4Only).toBe(false)

    const input = rebootDue()
    const v4Only = {
      ...input,
      now: T0 + DEFAULT_POLICY.rebootAtSv4Only * 1000 + 5_000,
      self: { ...input.self!, v6: { target: 'v6', received: 5 } },
    }
    const decision = decide({
      ...v4Only,
      record: { ...v4Only.record!, newestSampleTs: v4Only.now - 10_000 },
      ledger: { ...input.ledger, ladder: { ...input.ledger.ladder, announcedAt: v4Only.now - 61_000 } },
    })
    expect(decision.outageClass).toBe('v4_only_down')
    expect(decision.blockedBy).toContain('reboot_on_v4_only_disabled')
  })

  /** Every rung must fire strictly before the ladder gives up, or ordering decides. */
  test('no rung becomes due on the same tick the ladder exhausts', () => {
    expect(DEFAULT_POLICY.rebootAtS + DEFAULT_POLICY.announceLeadS).toBeLessThan(DEFAULT_POLICY.exhaustAtS)
    expect(DEFAULT_POLICY.rebootAtSv4Only + DEFAULT_POLICY.announceLeadS).toBeLessThan(DEFAULT_POLICY.exhaustAtS)
    expect(DEFAULT_POLICY.observeS).toBeLessThan(DEFAULT_POLICY.rebootAtS)
  })
})

/**
 * The three windows the specification demands be asserted, plus the one the
 * record produced while this was being written. Thresholds are the part of a
 * watchdog most likely to be wrong, and these are the only real evidence there
 * is: one event it should act on, three it must leave alone.
 */
describe('replaying the record', () => {
  function atOutage(startedAt: number, elapsedS: number, over: Partial<LadderInput> = {}): LadderInput {
    const now = startedAt + elapsedS * 1000
    const cycles = Math.floor(elapsedS / 30)
    const input = armedInput()
    return {
      ...input,
      now,
      record: {
        ...input.record!,
        newestSampleTs: now - 10_000,
        ongoingWanOutage: { startedAt, cycles, evidence: ['cloudflare', 'google', 'quad9'] },
      },
      self: { ...input.self!, probeTs: now },
      ledger: ledger({ v6: { lastUpTs: now - 60_000, lastCheckedTs: now } }),
      heldTicks: Math.min(cycles * 2, 20),
      ...over,
    }
  }

  /** 2026-08-01 10:09:04 → 10:30:34. 1290 s. Ended only when a human rebooted the router. */
  test('fires on the 2026-08-01 outage, at 240s of a 1290s event', () => {
    expect(decide(atOutage(T0, 239)).action).toBe('none')
    const armed = decide(atOutage(T0, 245))
    expect(armed.blockedBy).toEqual([])
    expect(armed.action).toBe('reconnect')
  })

  /** 2026-07-30 12:07:51 → 12:09:21. 90 s. IPv4 back 14–16 s after showtime, no intervention. */
  test('does not fire on the 07-30 outage, which healed itself in 90s', () => {
    for (const elapsed of [30, 60, 90]) {
      const decision = decide(atOutage(Date.UTC(2026, 6, 30, 12, 7, 51), elapsed))
      expect(decision.action).toBe('none')
    }
  })

  /**
   * 2026-08-01 12:28:35 → 12:30:05. 90 s, ppp0's counters reset 4.74 GB → 2.4 MB,
   * recovered on its own. Recorded while this watchdog was being written, which
   * is the third independent confirmation that 240 s is not too long a wait.
   */
  test('does not fire on the 08-01 12:28 outage, which also healed itself in 90s', () => {
    for (const elapsed of [30, 60, 90]) {
      expect(decide(atOutage(Date.UTC(2026, 7, 1, 12, 28, 35), elapsed)).action).toBe('none')
    }
  })

  /** 2026-07-31 06:07–07:15: six cycles over en1. Not this line, however bad the numbers look. */
  test('does not fire while the mini is measuring some other uplink', () => {
    const input = atOutage(Date.UTC(2026, 6, 31, 6, 7, 0), 600, {})
    const offLine = {
      ...input,
      self: { ...input.self!, onHomeLine: 0 as const, pathClass: 'wifi' },
      record: { ...input.record!, onHomeLine: false },
    }
    const decision = decide(offLine)
    expect(decision.outageClass).toBe('off_home_line')
    expect(decision.action).toBe('none')
  })

  /**
   * The 09:38:34 precursor: 40–45% loss on all three anchors with a clean
   * gateway, healed in about two seconds. It classifies as **healthy**, and
   * that is the deliberate blind spot rather than a bug — the trigger is
   * `received === 0` on every anchor, the same strict rule
   * `outage-detector.ts` uses, so a line at 95% loss never opens an outage and
   * this never fires while the connection is unusable.
   *
   * Widening it walks straight into the opposite failure, which this very cycle
   * is the evidence for: a 2 s blackout inside one 4 s probe window would have
   * armed a ladder. The blind spot is stated here so it is found by reading
   * rather than during a bad month. A human still sees it — the Uptime Kuma
   * heartbeat carries the worst anchor's loss in its message and flags it as
   * DEGRADED without paging.
   */
  test('treats heavy loss on every anchor as healthy, which is the stated blind spot', () => {
    const input = armedInput()
    const degraded = [
      { target: 'cloudflare', received: 12 },
      { target: 'google', received: 11 },
      { target: 'quad9', received: 12 },
    ]
    const decision = decide({
      ...input,
      record: { ...input.record!, wanAnchors: degraded },
      self: { ...input.self!, wanAnchors: degraded },
    })
    expect(decision.outageClass).toBe('healthy')
    expect(decision.action).toBe('none')
  })

  /** One anchor at zero is `partial` — three networks is the existing defence against one provider. */
  test('one dead anchor is partial and never actionable', () => {
    const input = armedInput()
    const oneDown = [
      { target: 'cloudflare', received: 0 },
      { target: 'google', received: 5 },
      { target: 'quad9', received: 5 },
    ]
    const decision = decide({
      ...input,
      record: { ...input.record!, wanAnchors: oneDown },
      self: { ...input.self!, wanAnchors: oneDown },
    })
    expect(decision.outageClass).toBe('partial')
    expect(decision.action).toBe('none')
  })
})

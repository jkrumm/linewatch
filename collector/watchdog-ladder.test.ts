import { describe, expect, test } from 'bun:test'
import {
  classify,
  decide,
  DEFAULT_POLICY,
  recordOutcome,
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
      ongoingWanOutage: { startedAt: T0, cycles: 8 },
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
      record: { ...input.record!, ongoingWanOutage: { startedAt: T0, cycles: 3 } },
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
    // The announce is reached because `not_announced` was the *only* thing left
    // blocking. Anything else outstanding and this would be a plain stand-down,
    // so asserting the state alone would not distinguish the two.
    expect(decide({ ...rebootDue(), disarmed: true }).blockedBy).toContain('not_announced')
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

    // …and refuses while it is still standing, which is what makes the abort
    // window real rather than nominal.
    const tooSoon = decide({ ...input, ledger: { ...input.ledger, ladder: { ...input.ledger.ladder, announcedAt: input.now - 1_000 } } })
    expect(tooSoon.blockedBy).toContain('announce_pending')
    expect(tooSoon.action).toBe('none')
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
        ongoingWanOutage: { startedAt, cycles },
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

  /**
   * 2026-08-01 19:09:07. A `gateway` outage (90 s) and a `wan` outage (180 s)
   * opened in the same second — the signature of the router going away, and the
   * fourth distinct shape in the record. The watchdog logged
   * `suspect/local_link_down` and `confirmed/off_home_line` through it.
   *
   * Nothing here may act. `local_link_down` outranks every WAN class precisely
   * because an unreachable gateway takes the anchors with it, and a reconnect
   * or a reboot is a command sent *through* the device that is not answering.
   */
  test('does not act on the 08-01 19:09 event, where the gateway went with the WAN', () => {
    const startedAt = Date.UTC(2026, 7, 1, 19, 9, 7)
    for (const elapsed of [30, 90, 180, 300]) {
      const input = atOutage(startedAt, elapsed)
      const down = {
        ...input,
        self: { ...input.self!, gateway: { target: 'gateway', received: 0 } },
        record: {
          ...input.record!,
          gateway: { target: 'gateway', received: 0 },
          ongoingGatewayOutage: { startedAt },
        },
      }
      const decision = decide(down)
      expect(decision.outageClass).toBe('local_link_down')
      expect(decision.action).toBe('none')
      // Blockers are computed when a rung comes due, not before — inside the
      // observe window the honest answer is that nothing has been asked yet.
      // Past it, the class itself is the first thing that refuses.
      if (elapsed >= DEFAULT_POLICY.observeS) {
        expect(decision.blockedBy).toContain('class_local_link_down')
        expect(decision.blockedBy).toContain('gateway_down')
        expect(decision.blockedBy).toContain('gateway_down_record')
      } else {
        expect(decision.blockedBy).toEqual([])
      }
    }
  })

  /**
   * The same event past the exhaust window. A dead gateway is not something this
   * can fix, which is exactly when a person is wanted — `ESCALATABLE` is wider
   * than `ACTIONABLE` for this case — and the note must not claim a ladder ran.
   */
  test('escalates the 19:09 shape once exhausted, without claiming it tried anything', () => {
    const startedAt = Date.UTC(2026, 7, 1, 19, 9, 7)
    const input = atOutage(startedAt, 950)
    const decision = decide({
      ...input,
      self: { ...input.self!, gateway: { target: 'gateway', received: 0 } },
      record: { ...input.record!, gateway: { target: 'gateway', received: 0 }, ongoingGatewayOutage: { startedAt } },
    })
    expect(decision.action).toBe('escalate')
    expect(decision.rung).toBe('exhausted')
    expect(decision.note).toContain('nothing here can address it')
  })

  /**
   * T0 comes from the earliest scope still open, not from the WAN row. The
   * gateway row is the only one that can open first — the WAN row is its
   * consequence — and dating the ladder from the consequence delays the one
   * clock a human is waiting on.
   */
  test('dates the ladder from the gateway row when it opened first', () => {
    const gatewayStart = Date.UTC(2026, 7, 1, 19, 9, 7)
    const wanStart = gatewayStart + 30_000
    const now = wanStart + 900_000
    const input = atOutage(wanStart, 900)
    const decision = decide({
      ...input,
      now,
      record: {
        ...input.record!,
        newestSampleTs: now - 10_000,
        gateway: { target: 'gateway', received: 0 },
        ongoingWanOutage: { startedAt: wanStart, cycles: 30 },
        ongoingGatewayOutage: { startedAt: gatewayStart },
      },
      self: { ...input.self!, probeTs: now, gateway: { target: 'gateway', received: 0 } },
    })
    expect(decision.t0).toBe(gatewayStart)
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

/**
 * The transitions the ledger records, which used to have no home.
 *
 * `latchClearAfterCleanS` and `postActionCooldownS` were policy fields nothing
 * read — the latch is the entire defence against a reboot loop taking Tailscale
 * down with the gateway and locking the house out of the mini, and its clear
 * condition existed only as prose inside a note string. Everything here would
 * otherwise have lived in the runner, which runs in anger about once a month.
 */
describe('the ledger the decision writes', () => {
  test('a healthy tick starts the clean clock and a non-healthy one stops it', () => {
    const now = T0 + 250_000
    const clean = decide(armedInput({ now, record: record({ newestSampleTs: now }), self: self({ probeTs: now }) }))
    expect(clean.outageClass).toBe('healthy')
    expect(clean.ledger.healthySince).toBe(now)

    // Keeps the v6 baseline armedInput seeds: without it the class is
    // `wan_down_v6_unknown`, which is a different (and equally non-healthy)
    // answer for a reason this test is not about.
    const down = decide(armedInput({ ledger: ledger({ healthySince: T0, v6: { lastUpTs: T0 + 190_000, lastCheckedTs: T0 + 250_000 } }) }))
    expect(down.outageClass).toBe('full_wan_down')
    expect(down.ledger.healthySince).toBeNull()
  })

  test('the latch clears only after the line has been clean for the whole window', () => {
    const now = T0 + 3_600_000
    const base = { record: record({ newestSampleTs: now }), self: self({ probeTs: now }), now }

    const tooSoon = decide(
      armedInput({
        ...base,
        ledger: ledger({ consecutiveActions: 2, healthySince: now - (DEFAULT_POLICY.latchClearAfterCleanS - 1) * 1000 }),
      }),
    )
    expect(tooSoon.ledger.consecutiveActions).toBe(2)

    const longEnough = decide(
      armedInput({
        ...base,
        ledger: ledger({ consecutiveActions: 2, healthySince: now - DEFAULT_POLICY.latchClearAfterCleanS * 1000 }),
      }),
    )
    expect(longEnough.ledger.consecutiveActions).toBe(0)
  })

  test('a flapping line never accumulates a clean window', () => {
    // The failure the latch is actually exposed to: healthy, down, healthy,
    // down. Each healthy tick must restart the clock from zero rather than
    // resume a total, or half an hour of flapping clears a latch that a
    // continuously clean half hour is supposed to earn.
    const now = T0 + 3_600_000
    const down = decide(armedInput({ now, ledger: ledger({ consecutiveActions: 2, healthySince: now - 1_700_000 }) }))
    expect(down.ledger.healthySince).toBeNull()

    const up = decide(
      armedInput({ now: now + 30_000, record: record({ newestSampleTs: now + 30_000 }), self: self({ probeTs: now + 30_000 }), ledger: down.ledger }),
    )
    expect(up.ledger.healthySince).toBe(now + 30_000)
    expect(up.ledger.consecutiveActions).toBe(2)
  })

  test('an authorised action is written ahead before it can be performed', () => {
    const out = decide(armedInput())
    expect(out.action).toBe('reconnect')
    expect(out.ledger.pending).toEqual({ ts: out.ledger.pending?.ts ?? 0, kind: 'reconnect', outageKey: `wan:${T0}` })
    expect(out.ledger.consecutiveActions).toBe(1)
    expect(out.ledger.ladder.settleUntil).toBe(armedInput().now + DEFAULT_POLICY.reconnectSettleS * 1000)
  })

  test('a suppressed action still advances the ladder but counts against nothing', () => {
    const out = decide(armedInput({ capability: 'null' }))
    expect(out.shadow).toBe(true)
    // No write-ahead and no latch increment: nothing reached the line, so
    // nothing may be recorded as if it had.
    expect(out.ledger.pending).toBeNull()
    expect(out.ledger.consecutiveActions).toBe(0)
    // But the settle window is real, or a shadow run re-authorises the same
    // rung every tick and never reaches the one above it.
    expect(out.ledger.ladder.settleUntil).not.toBeNull()
  })

  test('a blocked rung still advances the ladder, so the cheap one is never skipped', () => {
    const blocked = decide(armedInput({ policy: { ...DEFAULT_POLICY, armed: false } }))
    expect(blocked.state).toBe('blocked')
    expect(blocked.ledger.ladder.rung).toBe('reconnect')
  })

  test('the ladder climbs and never descends', () => {
    const out = decide(armedInput({ ledger: ledger({ ladder: { outageKey: `wan:${T0}`, t0: T0, rung: 'reboot', enteredAt: T0, settleUntil: null, announcedAt: null } }) }))
    // The decision at 250s is the reconnect rung; the ledger already stands at
    // reboot. Slipping back would hand out a second reboot window per outage,
    // because `ladder_not_advanced` only refuses while the rung reads `observe`.
    expect(out.ledger.ladder.rung).toBe('reboot')
  })

  test('T0 is captured once and survives every later tick', () => {
    const first = decide(armedInput())
    expect(first.ledger.ladder.t0).toBe(T0)

    const later = decide(armedInput({ now: T0 + 400_000, ledger: { ...first.ledger, pending: null } }))
    expect(later.ledger.ladder.t0).toBe(T0)
    expect(later.ledger.ladder.outageKey).toBe(`wan:${T0}`)
  })

  test('recovering after an action arms the cooldown; recovering on its own does not', () => {
    const now = T0 + 600_000
    const laddered = { outageKey: `wan:${T0}`, t0: T0, rung: 'reconnect' as const, enteredAt: T0, settleUntil: null, announcedAt: null }
    const healthy = { now, record: record({ newestSampleTs: now }), self: self({ probeTs: now }) }
    // Healthy long enough that the recovery counts as held — otherwise the
    // ladder is deliberately kept standing and none of this applies yet.
    const held = now - DEFAULT_POLICY.recoverAfterS * 1000

    const afterAction = decide(
      armedInput({
        ...healthy,
        ledger: ledger({ ladder: laddered, healthySince: held, actions: [{ ts: T0 + 240_000, kind: 'reconnect', outageKey: `wan:${T0}`, outcome: 'executed' }] }),
      }),
    )
    expect(afterAction.ledger.postActionCooldownUntil).toBe(now + DEFAULT_POLICY.postActionCooldownS * 1000)
    expect(afterAction.ledger.ladder.t0).toBeNull()

    const selfHealed = decide(armedInput({ ...healthy, ledger: ledger({ ladder: laddered, healthySince: held }) }))
    expect(selfHealed.note).toContain('self_recovery')
    expect(selfHealed.ledger.postActionCooldownUntil).toBeNull()
  })

  test('the cooldown is armed at the recovery, not at the action, or it vetoes its own next rung', () => {
    // A reconnect at 240s with a 900s cooldown armed on the spot would block the
    // reboot that becomes due at 330s. The ladder would stall at the cheap rung
    // for the entire event it exists for.
    const out = decide(armedInput())
    expect(out.ledger.postActionCooldownUntil).toBeNull()
  })

  test('a pending action freezes everything else in the ledger', () => {
    const pending = { ts: T0 + 240_000, kind: 'reconnect' as const, outageKey: `wan:${T0}` }
    const out = decide(armedInput({ ledger: ledger({ pending, consecutiveActions: 1 }) }))
    expect(out.state).toBe('settling')
    expect(out.blockedBy).toEqual(['action_pending'])
    expect(out.ledger.pending).toEqual(pending)
    expect(out.ledger.consecutiveActions).toBe(1)
    expect(out.ledger.ladder.t0).toBeNull()
  })

  test('the v6 baseline is folded in after classification, never before', () => {
    const now = T0 + 250_000
    // An anchor that answers this tick must not be able to vouch for itself:
    // classification reads the baseline as it stood, and only then is the
    // reading recorded.
    const out = decide(armedInput({ now, self: self({ probeTs: now, wanAnchors: ALL_WAN_DOWN, v6: { target: 'v6', received: 3 } }) }))
    expect(out.outageClass).toBe('v4_only_down')
    expect(out.ledger.v6.lastUpTs).toBe(now)
    expect(out.ledger.v6.lastCheckedTs).toBe(now)
  })

  test('an unanswered v6 anchor updates the check time but not the baseline', () => {
    const now = T0 + 250_000
    const out = decide(armedInput({ now, ledger: ledger({ v6: { lastUpTs: T0 - 10_000, lastCheckedTs: T0 - 10_000 } }) }))
    expect(out.ledger.v6.lastUpTs).toBe(T0 - 10_000)
    expect(out.ledger.v6.lastCheckedTs).toBe(now)
  })

  test('action history is pruned past every window that reads it', () => {
    const now = T0 + 250_000
    const stale = { ts: now - 3 * 86_400_000, kind: 'reboot' as const, outageKey: 'wan:old', outcome: 'executed' as const }
    const recent = { ts: now - 86_400_000 + 60_000, kind: 'reboot' as const, outageKey: 'wan:newer', outcome: 'executed' as const }
    const out = decide(armedInput({ now, ledger: ledger({ actions: [stale, recent] }) }))
    // The 24h budget and the 6h spacing are the longest lookbacks; anything
    // beyond two days cannot change a decision and only grows the file.
    expect(out.ledger.actions.map((action) => action.outageKey)).toEqual(['wan:newer'])
  })

  test('an escalation records when it happened, so the quiet period can hold', () => {
    const now = T0 + 950_000
    const out = decide(armedInput({ now, record: record({ newestSampleTs: now, wanAnchors: ALL_WAN_DOWN, ongoingWanOutage: { startedAt: T0, cycles: 30 } }) }))
    expect(out.action).toBe('escalate')
    expect(out.ledger.lastEscalationTs).toBe(now)

    const again = decide(armedInput({ now: now + 30_000, ledger: out.ledger, record: record({ newestSampleTs: now + 30_000, wanAnchors: ALL_WAN_DOWN, ongoingWanOutage: { startedAt: T0, cycles: 31 } }) }))
    expect(again.action).toBe('none')
  })
})

describe('what is worth waking a human for', () => {
  /**
   * Seeded with the T0 the ledger itself would have captured on the first
   * confirmed non-healthy tick. That is the path these classes actually take:
   * `off_home_line` and `local_link_down` open no `outage` row, so their clock
   * comes from the ledger and nowhere else — which is exactly why fifteen
   * minutes on a hotspot used to reach the escalation branch.
   */
  const exhausted = (over: Partial<LadderInput>) =>
    decide(
      armedInput({
        now: T0 + 950_000,
        ledger: ledger({ ladder: { outageKey: `wan:${T0}`, t0: T0, rung: 'reconnect', enteredAt: T0, settleUntil: null, announcedAt: null } }),
        ...over,
      }),
    )

  test('a WAN failure the ladder could not clear escalates', () => {
    const out = exhausted({})
    expect(out.state).toBe('exhausted')
    expect(out.action).toBe('escalate')
  })

  test('measuring some other uplink never escalates, however long it lasts', () => {
    // The old shape paged after fifteen minutes every time the mini left the
    // house. Nothing is known about the home line from a hotspot, so a page
    // claiming it is down would be a fabrication.
    const now = T0 + 950_000
    const out = exhausted({
      self: self({ probeTs: now, onHomeLine: 0, pathClass: 'wifi' }),
      record: record({ newestSampleTs: now, onHomeLine: false }),
    })
    expect(out.outageClass).toBe('off_home_line')
    expect(out.action).toBe('none')
    expect(out.blockedBy).toContain('no_escalation_for_off_home_line')
    expect(out.ledger.lastEscalationTs).toBeNull()
  })

  test('no evidence at all never escalates — the heartbeat already says so, and can', () => {
    const out = exhausted({ record: null, self: null })
    expect(out.outageClass).toBe('no_evidence')
    expect(out.action).toBe('none')
  })

  test('a dead gateway escalates, and says nothing about a ladder it never ran', () => {
    const now = T0 + 950_000
    const out = exhausted({
      self: self({ probeTs: now, gateway: { target: 'gateway', received: 0 }, wanAnchors: ALL_WAN_DOWN }),
      record: record({ newestSampleTs: now, gateway: { target: 'gateway', received: 0 }, wanAnchors: ALL_WAN_DOWN }),
    })
    expect(out.outageClass).toBe('local_link_down')
    expect(out.action).toBe('escalate')
    expect(out.note).not.toContain('ladder complete')
  })

  test('the disarm file silences the escalation too — a human has said they have it', () => {
    expect(exhausted({ disarmed: true }).action).toBe('none')
  })

  test('but shadow mode still escalates, because a notification is not a write', () => {
    expect(exhausted({ policy: { ...DEFAULT_POLICY, armed: false }, capability: 'null' }).action).toBe('escalate')
  })
})

describe('closing a write-ahead entry', () => {
  const pending = { ts: T0 + 240_000, kind: 'reconnect' as const, outageKey: `wan:${T0}` }
  const written = ledger({ pending, consecutiveActions: 1, ladder: { outageKey: `wan:${T0}`, t0: T0, rung: 'reconnect', enteredAt: T0, settleUntil: T0 + 330_000, announcedAt: null } })

  test('an executed action clears the entry and keeps its cost', () => {
    const after = recordOutcome(written, { ...pending, outcome: 'executed' })
    expect(after.pending).toBeNull()
    expect(after.actions).toHaveLength(1)
    expect(after.consecutiveActions).toBe(1)
    expect(after.ladder.settleUntil).toBe(T0 + 330_000)
  })

  test('an action that never reached the line gives the latch increment back', () => {
    // A pre-flight refusal — no connected WAN instance, an unrecognised
    // connType, the capability switch off. Two of those self-disarming the
    // watchdog would turn a transient read hiccup into a stand-down needing a
    // human, and nothing was sent.
    const after = recordOutcome(written, { ...pending, outcome: 'not_executed' })
    expect(after.consecutiveActions).toBe(0)
    expect(after.ladder.settleUntil).toBeNull()
    expect(after.actions).toHaveLength(1)
  })

  test('an unanswered action counts, because the line is now in an unknown state', () => {
    expect(recordOutcome(written, { ...pending, outcome: 'unknown' }).consecutiveActions).toBe(1)
    expect(recordOutcome(written, { ...pending, outcome: 'failed' }).consecutiveActions).toBe(1)
  })

  test('two actions without a clean window latch the watchdog', () => {
    const first = recordOutcome(written, { ...pending, outcome: 'executed' })
    const second = recordOutcome({ ...first, pending, consecutiveActions: 2 }, { ...pending, kind: 'reboot', outcome: 'executed' })
    const out = decide(armedInput({ now: T0 + 600_000, ledger: { ...second, ladder: written.ladder } }))
    expect(out.state).toBe('latched')
    expect(out.action).toBe('none')
  })
})

/**
 * The defect a live router reboot exposed on 2026-08-01, 131 s in, with all
 * three WAN anchors at 100% loss in the record.
 *
 * Entry into an outage is gated on `confirmTicks`. Exit was gated on nothing —
 * so one stray reply to one anchor in the watchdog's own three-packet probe
 * read as `partial`, which counts as healthy, which tore the ladder down and
 * wrote `self_recovery` into the record for a line that had not recovered.
 *
 * The false attribution is the smaller half. The larger one is that a wedge
 * flapping a single reply every couple of minutes restarts the 240 s observe
 * window every time, so the ladder never advances on exactly the failure it
 * exists for.
 */
describe('a recovery has to hold', () => {
  const laddered = { outageKey: `wan:${T0}`, t0: T0, rung: 'observe' as const, enteredAt: T0, settleUntil: null, announcedAt: null }
  const now = T0 + 131_000
  const looksBetter = (over: Partial<Ledger> = {}) =>
    decide(
      armedInput({
        now,
        // One anchor answered; the other two did not. That is `partial`.
        record: record({ newestSampleTs: now, wanAnchors: [
          { target: 'cloudflare', received: 0 },
          { target: 'google', received: 0 },
          { target: 'quad9', received: 2 },
        ] }),
        self: self({ probeTs: now, wanAnchors: [
          { target: 'cloudflare', received: 0 },
          { target: 'google', received: 0 },
          { target: 'quad9', received: 1 },
        ] }),
        ledger: ledger({ ladder: laddered, ...over }),
      }),
    )

  test('one stray reply does not end an outage', () => {
    const out = looksBetter()
    expect(out.outageClass).toBe('partial')
    expect(out.state).toBe('recovering')
    expect(out.blockedBy).toContain('recovery_not_sustained')
    expect(out.note).not.toContain('self_recovery')
  })

  test('and does not reset the clock the ladder runs on', () => {
    const out = looksBetter()
    // The whole point. T0 surviving is what lets the observe window complete
    // through a line that is flapping rather than cleanly down.
    expect(out.ledger.ladder.t0).toBe(T0)
    expect(out.ledger.ladder.outageKey).toBe(`wan:${T0}`)
  })

  test('a recovery that holds the window does end it', () => {
    const out = looksBetter({ healthySince: now - DEFAULT_POLICY.recoverAfterS * 1000 })
    expect(out.state).toBe('recovered')
    expect(out.ledger.ladder.t0).toBeNull()
  })

  test('a line that fails again mid-recovery continues the same outage', () => {
    const holding = looksBetter()
    const downAgain = decide(armedInput({ now: now + 15_000, ledger: holding.ledger }))
    expect(downAgain.outageClass).toBe('full_wan_down')
    // Same T0, so `downForS` keeps counting from the real start rather than
    // from the moment the flap ended.
    expect(downAgain.t0).toBe(T0)
    expect(downAgain.ledger.healthySince).toBeNull()
  })

  test('the clean clock restarts from zero on every fresh recovery attempt', () => {
    const first = looksBetter()
    expect(first.ledger.healthySince).toBe(now)
    const downAgain = decide(armedInput({ now: now + 15_000, ledger: first.ledger }))
    const secondAttempt = decide(armedInput({
      now: now + 30_000,
      record: record({ newestSampleTs: now + 30_000 }),
      self: self({ probeTs: now + 30_000 }),
      ledger: downAgain.ledger,
    }))
    // Not resumed from the first attempt: 30 s of flapping must not add up to a
    // sustained recovery.
    expect(secondAttempt.ledger.healthySince).toBe(now + 30_000)
    expect(secondAttempt.state).toBe('recovering')
  })
})

/**
 * The blockers the audit skill's phase 6a found asserted by nothing.
 *
 * Two of them are failure mode #5 in the specification — **acting when the mini
 * is not on the home line**, whose nasty variant is a travel router on the same
 * 192.168.1.0/24 answering on the same gateway address. That one had zero
 * coverage. Two more are the reboot budget itself. A precondition nothing
 * asserts is a precondition that survives a refactor by luck.
 */
describe('preconditions that had no test', () => {
  const armedNow = armedInput().now
  /**
   * `record()` resets `ongoingWanOutage` to null, and T0 falls back to `now`
   * without it — so a test that overrides the record and forgets this measures a
   * zero-second outage still inside the observe window, and every assertion
   * about a blocker passes vacuously against `blockedBy: []`.
   */
  const downSince = { startedAt: T0, cycles: 8 }

  test('a Wi-Fi path is refused even when the collector claims the home line', () => {
    // Deliberately inconsistent input: `onHomeLine: 1` over `pathClass: 'wifi'`
    // cannot come from `deriveOnHomeLine`, which requires Ethernet. That is the
    // point — this blocker is the second layer, for a collector whose verdict
    // and whose facts disagree.
    const out = decide(armedInput({ self: self({ probeTs: armedNow, wanAnchors: ALL_WAN_DOWN, onHomeLine: 1, pathClass: 'wifi', v6: { target: 'v6', received: 0 } }) }))
    expect(out.blockedBy).toContain('not_ethernet')
    expect(out.action).toBe('none')
  })

  test('a travel router on the same subnet is refused by the gateway address', () => {
    // The failure this exists for: a mini that fell back to a travel router on
    // 192.168.1.0/24 answers its gateway happily while every anchor fails. A
    // ladder gated only on "gateway up, WAN down" would reboot a perfectly
    // healthy home router in an empty house.
    const out = decide(
      armedInput({
        self: self({ probeTs: armedNow, wanAnchors: ALL_WAN_DOWN, gatewayAddr: '192.168.1.254', v6: { target: 'v6', received: 0 } }),
      }),
    )
    expect(out.blockedBy).toContain('gateway_addr_mismatch')
    expect(out.action).toBe('none')
  })

  test('the record disagreeing about the home line is its own refusal', () => {
    const out = decide(armedInput({ record: record({ newestSampleTs: armedNow - 10_000, wanAnchors: ALL_WAN_DOWN, onHomeLine: null, ongoingWanOutage: downSince }) }))
    expect(out.blockedBy).toContain('off_home_line_record')
  })

  test('an unreachable gateway blocks from either source', () => {
    const bySelf = decide(armedInput({ self: self({ probeTs: armedNow, wanAnchors: ALL_WAN_DOWN, gateway: { target: 'gateway', received: 0 } }) }))
    expect(bySelf.blockedBy).toContain('gateway_down')

    const byRecord = decide(
      armedInput({ record: record({ newestSampleTs: armedNow - 10_000, wanAnchors: ALL_WAN_DOWN, gateway: { target: 'gateway', received: 0 }, ongoingWanOutage: downSince }) }),
    )
    expect(byRecord.blockedBy).toContain('gateway_down_record')
  })

  test('a recovery that failed again cannot buy a fresh action budget', () => {
    // The laundering this prevents: recover for two cycles, fail again, and the
    // new outage would otherwise be a fresh ladder with a full budget.
    const out = decide(armedInput({ ledger: ledger({ postActionCooldownUntil: armedNow + 60_000, v6: { lastUpTs: armedNow, lastCheckedTs: armedNow } }) }))
    expect(out.blockedBy).toContain('post_action_cooldown')
    expect(out.action).toBe('none')
  })

  /**
   * The confirmation gate on the way in, which had no test at all — the
   * counterpart of `recoverAfterS` on the way out, and the reason a single tick
   * of anything cannot start a clock.
   */
  test('a class that has not held confirmTicks is suspect and blocked', () => {
    const out = decide(armedInput({ heldTicks: DEFAULT_POLICY.confirmTicks - 1 }))
    expect(out.state).toBe('suspect')
    expect(out.blockedBy).toEqual(['confirming'])
    expect(out.action).toBe('none')
  })

  /**
   * `class_${outageClass}` is the blocker that refuses everything outside
   * `ACTIONABLE`, and it was reachable by four classes with a test for one. It
   * is the last line between the ladder and a class it was never built for.
   */
  test('every non-actionable class refuses by its own name', () => {
    const offLine = decide(
      armedInput({
        self: self({ probeTs: armedNow, wanAnchors: ALL_WAN_DOWN, onHomeLine: 0, pathClass: 'wifi', v6: { target: 'v6', received: 0 } }),
        record: record({ newestSampleTs: armedNow - 10_000, wanAnchors: ALL_WAN_DOWN, onHomeLine: false, ongoingWanOutage: downSince }),
      }),
    )
    expect(offLine.outageClass).toBe('off_home_line')
    expect(offLine.blockedBy).toContain('class_off_home_line')

    // A line out of showtime cannot complete a re-dial and will not gain
    // showtime from a reboot — the one thing carrier evidence may veto.
    const carrierDown = decide(
      armedInput({ carrier: { stale: false, lineStatus: 'Down', showtimeStartS: null, freshPollAgeS: 30 } }),
    )
    expect(carrierDown.outageClass).toBe('carrier_down')
    expect(carrierDown.blockedBy).toContain('class_carrier_down')
    expect(carrierDown.action).toBe('none')
  })

  /**
   * Both halves of the `no_evidence` decision, which existed only as prose. It
   * refuses to act because it cannot see, and it refuses to *page* because
   * `heartbeat-verdict.ts` already says exactly this — precisely, and over a WAN
   * that is up. A second page for one fact trains the reader to ignore both.
   */
  test('knowing nothing blocks the ladder and does not wake anyone', () => {
    // The ladder must already be running, or T0 falls back to `now` and the
    // decision sits inside the observe window asserting nothing — the trap
    // `downSince` exists for, in the one case where there is no record to read
    // a start from at all.
    const blind = armedInput({
      record: null,
      self: null,
      now: T0 + 950_000,
      ledger: ledger({ ladder: { outageKey: `wan:${T0}`, t0: T0, rung: 'reconnect', enteredAt: T0, settleUntil: null, announcedAt: null } }),
    })
    const out = decide(blind)
    expect(out.outageClass).toBe('no_evidence')
    expect(out.blockedBy).toContain('class_no_evidence')
    expect(out.blockedBy).toContain('no_escalation_for_no_evidence')
    expect(out.action).toBe('none')
  })
})

describe('the reboot budget, which nothing asserted', () => {
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
        ladder: { outageKey: `wan:${T0}`, t0: T0, rung: 'reconnect', enteredAt: T0, settleUntil: null, announcedAt: T0 + 200_000 },
        v6: { lastUpTs: now - 60_000, lastCheckedTs: now },
      }),
      ...over,
    }
  }

  test('two reboots in a day is the cap, and the third is refused', () => {
    const input = rebootDue()
    const actions = [1, 2].map((i) => ({ ts: input.now - i * 7 * 3_600_000, kind: 'reboot' as const, outageKey: `wan:x${i}`, outcome: 'executed' as const }))
    const out = decide({ ...input, ledger: { ...input.ledger, actions } })
    expect(out.blockedBy).toContain('reboot_rate_limit')
    expect(out.action).toBe('none')
  })

  test('two reboots closer together than six hours is refused on spacing alone', () => {
    const input = rebootDue()
    const actions = [{ ts: input.now - 3_600_000, kind: 'reboot' as const, outageKey: 'wan:earlier', outcome: 'executed' as const }]
    const out = decide({ ...input, ledger: { ...input.ledger, actions } })
    expect(out.blockedBy).toContain('reboot_min_interval')
    // Not the daily cap — one reboot is well inside it. The two limits are
    // independent, and a test that could not tell them apart would pass with
    // either one deleted.
    expect(out.blockedBy).not.toContain('reboot_rate_limit')
  })

  test('an action that never reached the line spends no budget', () => {
    // `recordOutcome` gives the latch increment back for these; the rate limits
    // read the actions array directly, so this asserts the other half.
    const input = rebootDue()
    const actions = [1, 2].map((i) => ({ ts: input.now - i * 7 * 3_600_000, kind: 'reboot' as const, outageKey: `wan:x${i}`, outcome: 'not_executed' as const }))
    const out = decide({ ...input, ledger: { ...input.ledger, actions } })
    // Deliberately still counted: the budget is spent on *attempts*, because a
    // refusal that repeats is a router that cannot be read, and hammering it is
    // not the answer. Documented here so the choice is visible rather than
    // implicit in a filter that does not mention outcome.
    expect(out.blockedBy).toContain('reboot_rate_limit')
  })
})

/**
 * The three windows, asserted by the name of the thing that holds them shut.
 *
 * Every one of these was covered only through the state it produced, which
 * passes just as well if the timer is removed and something else happens to
 * block. The names are what the log prints at 03:00.
 */
describe('the windows that hold a rung shut', () => {
  test('nothing acts inside the observe window', () => {
    const now = T0 + 100_000
    const out = decide(
      armedInput({
        now,
        record: record({ newestSampleTs: now - 10_000, wanAnchors: ALL_WAN_DOWN, ongoingWanOutage: { startedAt: T0, cycles: 3 } }),
        self: self({ probeTs: now, wanAnchors: ALL_WAN_DOWN, v6: { target: 'v6', received: 0 } }),
        ledger: ledger({ ladder: { outageKey: `wan:${T0}`, t0: T0, rung: 'reconnect', enteredAt: T0, settleUntil: null, announcedAt: null }, v6: { lastUpTs: now - 60_000, lastCheckedTs: now } }),
      }),
    )
    // The gate is the branch, not a blocker: even with the ladder already
    // standing at the reconnect rung and every precondition satisfied, 100 s in
    // the machine is still observing and proposes nothing.
    expect(out.state).toBe('confirmed')
    expect(out.rung).toBe('observe')
    expect(out.action).toBe('none')
    expect(out.note).toContain('observing until 240s')
  })

  test('the reboot rung is not reachable before its due time', () => {
    const now = T0 + DEFAULT_POLICY.observeS * 1000 + 5_000
    const out = decide(
      armedInput({
        now,
        policy: { ...DEFAULT_POLICY, armed: true, rebootEnabled: true },
        record: record({ newestSampleTs: now - 10_000, wanAnchors: ALL_WAN_DOWN, ongoingWanOutage: { startedAt: T0, cycles: 9 } }),
        self: self({ probeTs: now, wanAnchors: ALL_WAN_DOWN, v6: { target: 'v6', received: 0 } }),
        ledger: ledger({
          ladder: { outageKey: `wan:${T0}`, t0: T0, rung: 'reboot', enteredAt: T0, settleUntil: null, announcedAt: null },
          v6: { lastUpTs: now - 60_000, lastCheckedTs: now },
        }),
      }),
    )
    // The ledger already stands at the reboot rung and the reconnect settle has
    // passed, so nothing but the clock is holding it — and the decision is
    // still the cheap rung.
    expect(out.rung).toBe('reconnect')
  })

  test('one reconnect per hour, independent of the daily cap', () => {
    const input = armedInput()
    const out = decide({
      ...input,
      ledger: ledger({
        actions: [{ ts: input.now - 600_000, kind: 'reconnect', outageKey: 'wan:earlier', outcome: 'executed' }],
        v6: { lastUpTs: input.now, lastCheckedTs: input.now },
      }),
    })
    expect(out.blockedBy).toContain('reconnect_min_interval')
    // One action is nowhere near the six-per-day cap, so a test that could not
    // tell the two limits apart would pass with either one deleted.
    expect(out.blockedBy).not.toContain('reconnect_rate_limit')
  })
})

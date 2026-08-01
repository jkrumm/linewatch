import { describe, expect, test } from 'bun:test'
import { eventKindFor, ledgerOutcome, markDelay, notificationMessage, notificationStatus } from './watchdog-report.js'

describe('what an attempt costs the latch', () => {
  /**
   * The distinction the latch depends on: **did anything reach the line**.
   * `recordOutcome` gives the increment back for the ones that did not, so
   * getting this mapping wrong in either direction is a real failure — too
   * strict and two pre-flight refusals self-disarm a watchdog that never sent a
   * verb; too loose and a reboot whose reply never came is forgotten.
   */
  test('nothing that was refused or suppressed counts', () => {
    expect(ledgerOutcome({ outcome: 'refused' })).toBe('not_executed')
    expect(ledgerOutcome({ outcome: 'not_executed' })).toBe('not_executed')
  })

  test('a verb the device rejected counts, because one went out', () => {
    expect(ledgerOutcome({ outcome: 'failed' })).toBe('failed')
  })

  test('an unanswered action counts — the line may have been touched', () => {
    expect(ledgerOutcome({ outcome: 'unknown' })).toBe('unknown')
    // A request that never completed is the same ambiguity, and gets the same
    // conservative reading rather than being treated as "nothing happened".
    expect(ledgerOutcome(null)).toBe('unknown')
  })

  test('only what reached the line is recorded as an intervention', () => {
    expect(eventKindFor('not_executed')).toBe('note')
    expect(eventKindFor('executed')).toBe('intervention')
    expect(eventKindFor('failed')).toBe('intervention')
    // A reboot with no acknowledgement is still a reboot. Recording it as a
    // note would leave it invisible in the attribution the table exists for.
    expect(eventKindFor('unknown')).toBe('intervention')
  })
})

describe('a notification that arrived late', () => {
  test('says so, in seconds', () => {
    expect(markDelay('wan down', 1_000_000_000, 1_000_090_000)).toBe('[90s ago] wan down')
  })

  test('a push that merely queued is not stamped', () => {
    expect(markDelay('wan down', 1_000_000_000, 1_000_002_000)).toBe('wan down')
  })

  /**
   * The whole reason the marker exists. The notification spool drains across
   * the WAN, which is down by definition when there is something worth saying —
   * so an unstamped delayed message would date the outage to whenever the line
   * came back rather than to when it started.
   */
  test('a message held through a 20-minute outage cannot read as current', () => {
    expect(markDelay('escalating', 0, 20 * 60_000)).toContain('1200s ago')
  })
})

describe('what turns the watchdog monitor red', () => {
  const subject = { state: 'blocked', outageClass: 'full_wan_down', action: 'none', note: '', armed: true, consecutiveActions: 0 }

  test('a latched watchdog is down — it has taken itself out of service', () => {
    expect(notificationStatus({ ...subject, state: 'latched' })).toBe('down')
  })

  test('an escalation is down — it has run out of ladder and wants a human', () => {
    expect(notificationStatus({ ...subject, action: 'escalate' })).toBe('down')
  })

  /**
   * Down here means "the watchdog can no longer help", never "the line is bad".
   * The line has its own monitor and that one is silence-means-down. A blocked
   * rung is ordinary operation, and so is every shadow evaluation — two weeks
   * of shadow mode must not page continuously, which is what makes the run
   * usable at all.
   */
  test('a blocked rung and a healthy shadow run are both up', () => {
    expect(notificationStatus(subject)).toBe('up')
    expect(notificationStatus({ ...subject, state: 'normal' })).toBe('up')
    expect(notificationStatus({ ...subject, state: 'armed' })).toBe('up')
  })

  test('the message leads with the state and names the mode', () => {
    expect(notificationMessage({ ...subject, note: 'observing' })).toBe('blocked · full_wan_down · armed · observing')
    expect(notificationMessage({ ...subject, armed: false, note: 'observing' })).toContain('· shadow ·')
  })

  test('uncleared actions are on the face of it, because they are how it latches', () => {
    expect(notificationMessage({ ...subject, consecutiveActions: 1, note: 'x' })).toContain('1 action(s) uncleared')
  })

  test('a long note is truncated rather than allowed to be dropped by Kuma', () => {
    expect(notificationMessage({ ...subject, note: 'x'.repeat(500) })).toHaveLength(240)
  })
})

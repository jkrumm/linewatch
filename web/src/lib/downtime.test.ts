import { describe, expect, test } from 'bun:test'
import { windowDowntime } from './downtime'
import type { Outage } from './types'

const HOUR_MS = 3_600_000
const TO = Date.UTC(2026, 6, 30, 12, 0, 0)
const FROM = TO - 24 * HOUR_MS

function closed(startedAt: number, endedAt: number, id = 1): Outage {
  return {
    id,
    scope: 'wan',
    startedAt,
    endedAt,
    // Exactly what `src/services/outage-detector.ts` writes when it closes a row.
    durationS: Math.round((endedAt - startedAt) / 1000),
    cycles: Math.round((endedAt - startedAt) / 30_000),
    evidence: ['cloudflare', 'google', 'quad9'],
  }
}

function ongoing(startedAt: number, id = 2): Outage {
  return {
    id,
    scope: 'wan',
    startedAt,
    // Null by design while the outage is open — the state machine fills both fields on close.
    endedAt: null,
    durationS: null,
    cycles: 4,
    evidence: ['cloudflare', 'google', 'quad9'],
  }
}

describe('windowDowntime', () => {
  test('sums closed outages inside the window from their recorded duration', () => {
    const outages = [closed(TO - 5 * HOUR_MS, TO - 5 * HOUR_MS + 120_000, 1), closed(TO - 2 * HOUR_MS, TO - 2 * HOUR_MS + 45_000, 2)]
    expect(windowDowntime(outages, { from: FROM, to: TO }, TO)).toEqual({ seconds: 165, openCount: 0 })
  })

  test('an ongoing outage counts from its start to now — never as zero', () => {
    // The screen this pins: "Total downtime: 0 min" under a red "WAN outage in progress" banner,
    // produced by coalescing the open row's null durationS to 0.
    const result = windowDowntime([ongoing(TO - 180_000)], { from: FROM, to: TO }, TO)
    expect(result.seconds).toBe(180)
    expect(result.openCount).toBe(1)
  })

  test('clips an outage that began before the window to its in-window seconds', () => {
    // `GET /api/outages` filters on overlap, so this row is returned whole: it began 30 min before
    // `from` and ran three hours into the range. Only the in-window part is this range's downtime.
    const outage = closed(FROM - 1800_000, FROM + 3 * HOUR_MS)
    expect(windowDowntime([outage], { from: FROM, to: TO }, TO).seconds).toBe(3 * 3600)
  })

  test('clips an ongoing outage at the window end, not at the unfloored clock', () => {
    // `to` is the clock floored to one probe cycle, so `now` runs up to 30 s ahead of it. Counting
    // that overshoot reports downtime in a stretch of time the window does not cover.
    const now = TO + 29_000
    expect(windowDowntime([ongoing(TO - 60_000)], { from: FROM, to: TO }, now).seconds).toBe(60)
  })

  test('an outage entirely before the window contributes nothing but is still not negative', () => {
    const outage = closed(FROM - 2 * HOUR_MS, FROM - HOUR_MS)
    expect(windowDowntime([outage], { from: FROM, to: TO }, TO)).toEqual({ seconds: 0, openCount: 0 })
  })

  test('counts every open row, including one whose measured overlap rounds to nothing', () => {
    // It started after the last floored cycle boundary, so it has contributed no measured seconds
    // yet — but "(1 still open)" is the whole point of the suffix.
    const result = windowDowntime([ongoing(TO + 5_000)], { from: FROM, to: TO }, TO + 5_000)
    expect(result).toEqual({ seconds: 0, openCount: 1 })
  })

  test('no outages is a real zero', () => {
    expect(windowDowntime([], { from: FROM, to: TO }, TO)).toEqual({ seconds: 0, openCount: 0 })
  })
})

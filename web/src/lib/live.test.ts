import { describe, expect, test } from 'bun:test'
import { liveGateway, liveInternet } from './live'
import type { StatusSample } from './types'

function sample(patch: Partial<StatusSample> & Pick<StatusSample, 'target'>): StatusSample {
  return {
    scope: patch.target === 'gateway' ? 'gateway' : 'wan',
    ts: 1_000,
    addr: '203.0.113.1',
    sent: 5,
    received: 5,
    lossPct: 0,
    medMs: 5,
    jitterMs: 0.2,
    up: true,
    ...patch,
  }
}

describe('liveGateway', () => {
  test('reports the single gateway sample as itself', () => {
    const reading = liveGateway([sample({ target: 'gateway', medMs: 1.2 }), sample({ target: 'cloudflare', medMs: 9 })])
    expect(reading).toMatchObject({ medMs: 1.2, total: 1, upCount: 1 })
  })

  test('no gateway sample is an empty reading, not a zero one', () => {
    expect(liveGateway([sample({ target: 'cloudflare' })])).toMatchObject({
      medMs: null,
      worstLossPct: null,
      ts: null,
      total: 0,
      upCount: 0,
    })
  })
})

describe('liveInternet', () => {
  test('folds the anchors to their median and excludes the gateway', () => {
    const reading = liveInternet([
      sample({ target: 'gateway', medMs: 1 }),
      sample({ target: 'cloudflare', medMs: 5 }),
      sample({ target: 'google', medMs: 9 }),
      sample({ target: 'quad9', medMs: 7 }),
    ])
    expect(reading.medMs).toBe(7)
    expect(reading.total).toBe(3)
  })

  /**
   * The load-bearing case. A dead anchor reports `medMs: null`, and counting that as 0 would report
   * a *faster* internet for a cycle that measured less of it — an absent measurement rendered as a
   * good one, which is the failure this whole project is built to refuse.
   */
  test('an anchor that did not answer is skipped, never counted as zero', () => {
    const reading = liveInternet([
      sample({ target: 'cloudflare', medMs: 10 }),
      sample({ target: 'google', medMs: null, received: 0, lossPct: 100, up: false }),
      sample({ target: 'quad9', medMs: 20 }),
    ])
    expect(reading.medMs).toBe(15)
    expect(reading.upCount).toBe(2)
    expect(reading.total).toBe(3)
  })

  /** The worst, not the middle: a tile showing the median of {0%, 0%, 100%} says nothing is wrong
   * at the exact moment something is. `upCount` is what stops that over-claiming. */
  test('loss is the worst any anchor saw', () => {
    const reading = liveInternet([
      sample({ target: 'cloudflare', lossPct: 0 }),
      sample({ target: 'google', lossPct: 0 }),
      sample({ target: 'quad9', lossPct: 100, received: 0, medMs: null, up: false }),
    ])
    expect(reading.worstLossPct).toBe(100)
    expect(reading.upCount).toBe(2)
  })

  /** The tile's staleness is decided by this, and the newest constituent is the only honest answer:
   * one anchor that stopped reporting a month ago must not age the whole reading. */
  test('the timestamp is the newest constituent, not the oldest', () => {
    const reading = liveInternet([
      sample({ target: 'cloudflare', ts: 500 }),
      sample({ target: 'google', ts: 9_000 }),
    ])
    expect(reading.ts).toBe(9_000)
  })

  test('nothing reporting is an empty reading', () => {
    expect(liveInternet([])).toMatchObject({ medMs: null, worstLossPct: null, ts: null, total: 0, upCount: 0 })
  })
})

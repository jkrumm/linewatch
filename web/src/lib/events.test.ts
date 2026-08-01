import { describe, expect, test } from 'bun:test'
import { eventSourceLabel, summariseEventDetail, timelineEmptyState } from './events'
import { generateEvents } from './mock/generate'

describe('eventSourceLabel', () => {
  test('the three link_change writers are distinguishable and carry different precisions', () => {
    const sampler = eventSourceLabel('link-sampler')
    const diff = eventSourceLabel('vantage-diff')
    const poller = eventSourceLabel('router-poller')

    expect(new Set([sampler.label, diff.label, poller.label]).size).toBe(3)
    // The precision is the reason the column exists: ~1 s against a 30 s cycle against a poll
    // interval. Identical text on any two of them would present three distances as one.
    expect(new Set([sampler.precision, diff.precision, poller.precision]).size).toBe(3)
    expect(sampler.precision).toContain('1 s')
    expect(diff.precision).toContain('30 s')
  })

  test('a missing source is unlabelled, never attributed to the likeliest writer', () => {
    const none = eventSourceLabel(null)
    expect(none.label).toBe('not recorded')
    expect(none.label).not.toBe(eventSourceLabel('vantage-diff').label)
    expect(none.precision).toContain('unknown')
  })

  test('a source this build does not know renders as itself', () => {
    const future = eventSourceLabel('wifi-sampler')
    expect(future.label).toBe('wifi-sampler')
  })
})

describe('summariseEventDetail', () => {
  test('a vantage diff renders each field before → after', () => {
    const summary = summariseEventDetail({
      source: 'vantage-diff',
      changed: { linkMbit: { before: 1000, after: 100 }, pathIf: { before: 'en0', after: 'en1' } },
    })
    expect(summary).toBe('linkMbit 1000 → 100 · pathIf en0 → en1')
    // `source` has its own column; repeating it in the summary is noise.
    expect(summary).not.toContain('vantage-diff')
  })

  test('an unknown shape shows its own keys rather than being dropped', () => {
    expect(summariseEventDetail({ source: 'link-sampler', state: 'down', iface: 'en0' })).toBe(
      'state down · iface en0',
    )
    expect(summariseEventDetail({ somethingNew: 42, nested: { a: 1 } })).toBe(
      'somethingNew 42 · nested {"a":1}',
    )
  })

  test('a null field prints null rather than disappearing into an empty string', () => {
    expect(summariseEventDetail({ previousShowtimeStartS: null })).toBe('previousShowtimeStartS null')
  })

  test('a non-object detail is not silently swallowed', () => {
    expect(summariseEventDetail('cable pulled')).toBe('cable pulled')
    expect(summariseEventDetail(undefined)).toBe('')
  })
})

describe('timelineEmptyState', () => {
  test('with nothing watching it says so, and never says there were no events', () => {
    const state = timelineEmptyState(null)
    expect(state.title).toBe('Link sampling is not running')
    expect(state.description).toContain('nothing was looking')
    expect(`${state.title} ${state.description}`.toLowerCase()).not.toContain('no events')
  })

  test('with sampling running it dates the coverage instead of claiming stability', () => {
    const since = Date.UTC(2026, 6, 30, 8, 0, 0)
    const state = timelineEmptyState(since)
    expect(state.title).toBe('No transitions recorded')
    expect(state.description).toContain('resolution')
    // "The link was stable" is the phrasing DESIGN.md forbids for this state.
    expect(state.description.toLowerCase()).not.toContain('stable')
  })
})

describe('the mock timeline', () => {
  test('a window ending before the sampler started reports no coverage at all', () => {
    const to = Date.now() - 13 * 3_600_000
    const { events, linkSamplingSince } = generateEvents(to - 3_600_000, to)
    expect(events).toEqual([])
    expect(linkSamplingSince).toBeNull()
    expect(timelineEmptyState(linkSamplingSince).title).toBe('Link sampling is not running')
  })

  test('a recent window carries both writers, newest first', () => {
    const now = Date.now()
    const { events, linkSamplingSince } = generateEvents(now - 11 * 3_600_000, now)
    expect(linkSamplingSince).not.toBeNull()
    const sources = new Set(events.map((e) => e.source))
    expect(sources.has('link-sampler')).toBe(true)
    expect(sources.has('router-poller')).toBe(true)
    expect(events.map((e) => e.ts)).toEqual([...events.map((e) => e.ts)].sort((a, b) => b - a))
  })
})

describe('summariseEventDetail — router disagreements', () => {
  test('renders the two sides as a sentence, not as JSON', () => {
    // The shape the router poller really writes, taken from event id 15 on 2026-08-01: the moment
    // the router already saw 1000 Mbit on its port while the host was still negotiated at 100.
    const detail = {
      source: 'router-poller',
      reason: 'vantage_disagreement',
      hostCycleTs: 1785567178926,
      disagreements: [{ field: 'link_speed', host: '100 Mbit', router: '1000 Mbit on LAN1' }],
    }
    const out = summariseEventDetail(detail)
    expect(out).toContain('link_speed: host 100 Mbit vs router 1000 Mbit on LAN1')
    // The regression: no JSON punctuation may survive into the cell.
    expect(out).not.toContain('[{')
    expect(out).not.toContain('"field"')
  })
})

import { describe, expect, test } from 'bun:test'
import { dashboard } from './dashboard-store'

/**
 * `validateSearch` is the whole of the store's contract with the router, and it is the half that
 * used to be a `ZodError` waiting to happen — so it is what the test pins.
 *
 * A range field owns THREE params (`range` + `from` + `to`), so every return carries all three;
 * `from`/`to` stay `undefined` because the field declares no `custom: true` and nothing here writes
 * a custom window. TanStack drops an `undefined` search value rather than putting `?from=` on the
 * URL, so a deep link's shape is unchanged from the single-param store this replaced.
 *
 * `compact` is deliberately absent: it is `url: false`, and `validateSearch` is the URL lane by
 * definition.
 */
describe('dashboard.validateSearch', () => {
  test('takes a valid range straight out of the URL', () => {
    expect(dashboard.validateSearch({ range: '7d' })).toEqual({
      range: '7d',
      from: undefined,
      to: undefined,
      minDuration: 0,
    })
  })

  test('falls back instead of throwing on a range the URL invented', () => {
    // The behaviour the store bought over `z.enum(RANGE_OPTIONS).default('24h')`, which only
    // defaults an ABSENT key — a present-but-invalid one threw out of `validateSearch`, so a
    // hand-edited or stale URL took the whole dashboard down rather than showing the default window.
    for (const raw of [{ range: 'nonsense' }, { range: 42 }, {}]) {
      expect(dashboard.validateSearch(raw).range).toBe('24h')
    }
  })

  test('clamps and rejects a hand-edited minDuration rather than coercing it', () => {
    expect(dashboard.validateSearch({ range: '24h', minDuration: '300' }).minDuration).toBe(300)
    // Negative clamps to `min`; a non-integer and a non-numeric string are unusable and fall back.
    expect(dashboard.validateSearch({ range: '24h', minDuration: '-60' }).minDuration).toBe(0)
    expect(dashboard.validateSearch({ range: '24h', minDuration: '1.5' }).minDuration).toBe(0)
    expect(dashboard.validateSearch({ range: '24h', minDuration: 'soon' }).minDuration).toBe(0)
  })
})

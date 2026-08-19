import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./latency-band-chart.tsx', import.meta.url), 'utf8')

/** Comments stripped, so the docblocks that NAME the old bug do not themselves satisfy the check. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * A tooltip header that names a different day than the axis under it.
 *
 * `TooltipHeader` formatted its `date` by regexing `YYYY-MM-DD` out of the domain key and building
 * a LOCAL `Date` from those three numbers. The bucketed charts key on `densifyBuckets`' UTC ISO
 * start, so for every bucket from 22:00 local to midnight the header named the previous calendar
 * day while `formatX`, the badge and every sibling on the page named the current one. Measured
 * under `TZ=Europe/Berlin`: bucket `2026-08-01T23:00:00.000Z` drew an axis tick of `02.08 01:00`
 * and a header of `Sat Aug 1 2026`.
 *
 * For one release the fix was to key the domain in local time with the offset written out, which
 * worked and cost the chart a key its siblings did not share. `tooltip.formatHeader` (basalt-ui
 * 1.17.0) put the formatting back where formatting belongs, and the key went back to being one
 * instant with one identity.
 *
 * A render test cannot see this — the tooltip mounts only under a live cursor, and
 * `renderToStaticMarkup` never produces one. What has to hold is structural, so that is what this
 * asserts: the header formats from the INSTANT, and the key is the one the strips resolve against.
 */
describe('the latency band tooltip header and its axis cannot name different days', () => {
  test('the header formats from the bucket instant, never from the domain key', () => {
    expect(code).toContain('formatHeader: (_key, p) => fmtTooltipDate(new Date(p.bucketStart))')
  })

  test('the domain key is densifyBuckets own ISO start, shared verbatim with the strips', () => {
    expect(code).toContain('key: slot.key,')
    // The local-ISO workaround this replaced. Re-keying the domain to make a formatter come out
    // right is the regression: it desynchronises this chart's broadcast key from every sibling's.
    expect(code).not.toContain('localOffsetIso')
  })

  test('the badge still carries the clock the header format drops', () => {
    expect(code).toContain('label: (p) => ({ text: fmtClock(p.bucketStart)')
  })
})

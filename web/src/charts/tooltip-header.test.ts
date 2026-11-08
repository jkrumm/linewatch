import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'

const CHARTS_DIR = new URL('./', import.meta.url)

/** Comments stripped, so the docblocks that NAME the old bug do not themselves satisfy the check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** Every chart module that sets `tooltip.formatHeader`, comments stripped. Discovered, not listed,
 * so a new chart that sets one is pinned the day it lands. */
const charts = readdirSync(CHARTS_DIR)
  .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
  .map((name) => ({
    name,
    code: stripComments(readFileSync(new URL(name, CHARTS_DIR), 'utf8')),
  }))
  .filter(({ code }) => code.includes('formatHeader'))

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
describe('every tooltip header and its axis cannot name different days', () => {
  test('the discovery found the charts that set a header', () => {
    expect(charts.length).toBeGreaterThanOrEqual(6)
  })

  for (const { name, code } of charts) {
    test(`${name}: the header formats from the bucket instant or a run header, never from the x value`, () => {
      const value = /formatHeader:\s*([^\n]+)/.exec(code)?.[1] ?? ''
      // `runHeader` formats a run's own timestamp; the inline form takes the x value as its first
      // parameter and must ignore it (`_x`), formatting the datum's instant instead.
      if (/^runHeader\b/.test(value)) return
      const arrow = /^\(\s*(\w+)[^)]*\)\s*=>\s*(.+?),?\s*$/.exec(value)
      expect(arrow).not.toBeNull()
      const [, xParam = '', body = ''] = arrow ?? []
      expect(xParam.startsWith('_')).toBe(true)
      expect(body).toMatch(/fmtDateTime\(\w+\.bucketStart\)/)
    })

    test(`${name}: no local-ISO string key re-keys the domain to make a formatter come out right`, () => {
      expect(code).not.toContain('localOffsetIso')
      expect(code).not.toContain('key: slot.key')
    })
  }

  test('the latency band keys x on the bucket instant as a Date, shared with the strips', () => {
    const band = charts.find(({ name }) => name === 'latency-band-chart.tsx')
    expect(band?.code).toMatch(/=\s*\(\w+: Point\): Date =>\s*new Date\(\w+\.bucketStart\)/)
  })
})

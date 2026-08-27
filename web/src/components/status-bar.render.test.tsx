import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { StatusBar } from './status-bar'

const NOW = 1_000_000

const EMPTY_WINDOW = {
  downtime: { seconds: 0, openCount: 0 },
  points: [],
  tests: [],
}

const KPI_PROPS = {
  current: EMPTY_WINDOW,
  previous: null,
  range: '24h' as const,
  windowSeconds: 86_400,
  pending: { downtime: false, series: false, tests: false },
}

/**
 * `status={null}` used to be reachable through `ongoingOutages={status?.ongoingOutages ?? []}` /
 * `lastSamples={status?.lastSamples ?? []}` at the call site — an unresolved `statusQuery`
 * coalesced straight into `NotReportingLine`'s "No data yet — collector has never reported", a
 * claim about a DEAD collector, over a query nobody had answered. `PageHeader`'s `live` prop
 * already renders a bare dash for the identical case; this pins that the bar does too.
 */
describe('StatusBar status pending', () => {
  test('renders a dash, not the dead-collector claim, while status is unresolved', () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <StatusBar status={null} now={NOW} {...KPI_PROPS} />
      </MantineProvider>,
    )
    expect(html).not.toContain('No data yet')
    expect(html).not.toContain('collector has never reported')
  })

  test('a resolved status with genuinely no samples still renders the dead-collector claim', () => {
    // The case `status: null` must be told apart from: the query answered, and the collector really
    // has never reported anything. That is still a true claim and must still render.
    const html = renderToStaticMarkup(
      <MantineProvider>
        <StatusBar status={{ ongoingOutages: [], lastSamples: [] }} now={NOW} {...KPI_PROPS} />
      </MantineProvider>,
    )
    expect(html).toContain('No data yet')
    expect(html).toContain('collector has never reported')
  })
})

/**
 * The threshold rail was the one thing the fold cost: `StatCard.tone` draws it from inside the
 * card, and this bar cannot use `StatCard` (see the module docblock). `StatCard`'s rail was itself
 * the fix for a hand-rolled one that was colour-only, so the accessible half is the part that must
 * not regress — a rail nothing announces is the exact defect that fix removed.
 */
describe('StatusBar threshold rail', () => {
  test('a tinted cell announces its threshold in words, not only in colour', () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <StatusBar
          status={{ ongoingOutages: [], lastSamples: [] }}
          now={NOW}
          {...KPI_PROPS}
          current={{ ...EMPTY_WINDOW, downtime: { seconds: 7200, openCount: 1 } }}
        />
      </MantineProvider>,
    )
    expect(html).toContain('Past the severe threshold')
  })

  test('an untinted bar announces no threshold at all — absence is not a verdict', () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <StatusBar status={{ ongoingOutages: [], lastSamples: [] }} now={NOW} {...KPI_PROPS} />
      </MantineProvider>,
    )
    expect(html).not.toContain('threshold')
  })
})

/**
 * Law C8 — every card or table title is a `WidgetHeader` — reached this bar in basalt-ui 1.26.0:
 * each cell's label was an uppercase micro `Text`, i.e. a string with no structure at all, and is
 * now a `WidgetHeader tier="widget"` `<h3>`.
 *
 * The assertion is per LABEL rather than a count of `<h3>`s, deliberately: the bar renders its cell
 * list twice (a `SimpleGrid` below `xl`, a divided `Group` above it), so a count pins the responsive
 * layout rather than the heading contract, and would break on a purely visual change.
 */
describe('StatusBar cell labels are headings', () => {
  const html = renderToStaticMarkup(
    <MantineProvider>
      <StatusBar status={{ ongoingOutages: [], lastSamples: [] }} now={NOW} {...KPI_PROPS} />
    </MantineProvider>,
  )

  for (const label of ['Status', 'Latest cycle', 'Downtime', 'Ping · internet', 'Download']) {
    test(`"${label}" is marked up as a heading, not a bare string`, () => {
      expect(html).toMatch(new RegExp(`<h3[^>]*>(?:<[^>]+>)*${escapeRe(label)}`))
    })
  }
})

/** `Ping · internet` carries no regex metacharacter today; escaping keeps that from mattering. */
function escapeRe(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

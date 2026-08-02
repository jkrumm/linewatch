import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { NowStrip } from './now-strip'

const NOW = 1_000_000

/**
 * `status={null}` used to be reachable through `ongoingOutages={status?.ongoingOutages ?? []}` /
 * `lastSamples={status?.lastSamples ?? []}` at the call site — an unresolved `statusQuery`
 * coalesced straight into `NotReportingLine`'s "No data yet — collector has never reported", a
 * claim about a DEAD collector, over a query nobody had answered. `PageHeader`'s `live` prop
 * already renders a bare dash for the identical case; this pins that `NowStrip` now does too.
 */
describe('NowStrip status pending', () => {
  test('renders a dash, not the dead-collector claim, while status is unresolved', () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <NowStrip status={null} now={NOW} />
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
        <NowStrip status={{ ongoingOutages: [], lastSamples: [] }} now={NOW} />
      </MantineProvider>,
    )
    expect(html).toContain('No data yet')
    expect(html).toContain('collector has never reported')
  })
})

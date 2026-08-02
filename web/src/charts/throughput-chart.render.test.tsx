import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThroughputChart } from './throughput-chart'

const WINDOW = { from: 0, to: 3_600_000, bucketSeconds: 300 } as const

/**
 * `buckets={throughput?.buckets ?? []}` fed to this chart ungated, before `isPending` existed,
 * densified to an all-null window and painted a fully-hatched "measured, and nothing was there"
 * band on every cold load and range change — `throughputQuery` is not in the route loader, so this
 * was reachable, not a one-frame flicker. `isPending` is the fix; these pin the two things that
 * must be true of it: the pending state renders instead of a chart body, and it never renders
 * alongside one, whatever `buckets` holds.
 */
describe('ThroughputChart isPending', () => {
  test('renders the pending caption, not a chart, while pending — even with buckets already in hand', () => {
    const html = renderToStaticMarkup(
      <ThroughputChart
        buckets={[{ bucket: 0, inBytes: 6_000_000, outBytes: 600_000, spanMs: 60_000, intervals: 2, skipped: 0 }]}
        {...WINDOW}
        isPending
      />,
    )
    expect(html).toContain('Waiting for this window')
    // `MirroredBars`' own accessible label — proof the chart body did not mount underneath the
    // pending caption, which is the exact "renders both, one on top of the other" failure mode a
    // boolean gate that forgot its `else` branch would produce.
    expect(html).not.toContain('Data carried per bucket')
  })

  test('does not render the pending caption once the query has resolved', () => {
    const html = renderToStaticMarkup(<ThroughputChart buckets={[]} {...WINDOW} isPending={false} />)
    expect(html).not.toContain('Waiting for this window')
  })

  test('an omitted isPending defaults to the resolved (non-pending) path', () => {
    const html = renderToStaticMarkup(<ThroughputChart buckets={[]} {...WINDOW} />)
    expect(html).not.toContain('Waiting for this window')
  })
})

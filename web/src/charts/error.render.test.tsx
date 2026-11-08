import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AvailabilityHeatmap } from './availability-heatmap'
import { AvailabilityStrip } from './availability-strip'
import { ThroughputChart } from './throughput-chart'

const BUCKETED = { from: 0, to: 3_600_000, bucketSeconds: 300 } as const
const FAILED = new Error('upstream exploded')

/**
 * A failed query is a fourth state next to loading, empty and drawn. `data === undefined` cannot
 * tell it from loading, so a failure used to render the pending skeleton forever; and `?? []` fed
 * to a chart turned it into "nothing was measured". Each of these must say it failed.
 */
describe('chart error state', () => {
  test('AvailabilityStrip names the failure instead of the pending caption or an empty strip', () => {
    const html = renderToStaticMarkup(
      <AvailabilityStrip target="cloudflare" buckets={[]} {...BUCKETED} error={FAILED} />,
    )
    expect(html).toContain('Could not load')
    expect(html).toContain('upstream exploded')
    expect(html).not.toContain('Loading')
  })

  test('AvailabilityHeatmap shows the failure, not an all-absent grid', () => {
    const html = renderToStaticMarkup(
      <AvailabilityHeatmap buckets={[]} from={0} to={30 * 86_400_000} error={FAILED} />,
    )
    expect(html).toContain('Could not load')
    expect(html).not.toContain('expected cycles')
  })

  test('ThroughputChart shows the failure, not a zero-volume window', () => {
    const html = renderToStaticMarkup(<ThroughputChart buckets={[]} {...BUCKETED} error={FAILED} />)
    expect(html).toContain('Could not load')
  })

  test('pending still wins over error while a retry is in flight', () => {
    const html = renderToStaticMarkup(
      <AvailabilityStrip target="cloudflare" buckets={[]} {...BUCKETED} isPending error={FAILED} />,
    )
    expect(html).toContain('Loading')
  })
})

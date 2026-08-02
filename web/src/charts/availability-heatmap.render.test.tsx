import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AvailabilityHeatmap } from './availability-heatmap'

const DAY_MS = 86_400_000
const WINDOW = { from: 0, to: 30 * DAY_MS } as const

/**
 * The heatmap's own version of `throughput-chart.render.test.tsx`'s bug: `heatmapData?.buckets ??
 * []` fed to this grid ungated painted every cell hatched-absent and every tooltip "0 of 30
 * expected cycles" on the pattern view's first render — `probeBucketsQuery` for the heatmap's own
 * 30-day span is not in the route loader either. Milder than the throughput case (hatching never
 * claims the line was up), but the same class, and the same `isPending` fix.
 */
describe('AvailabilityHeatmap isPending', () => {
  test('renders the pending caption, not the grid, while pending — even with buckets already in hand', () => {
    const html = renderToStaticMarkup(
      <AvailabilityHeatmap
        buckets={[
          {
            bucket: 0,
            target: 'cloudflare',
            medianMs: 12,
            p5Ms: 10,
            p95Ms: 14,
            minMs: 9,
            maxMs: 15,
            maxLossPct: 0,
            lossPct: 0,
            downCycles: 0,
            count: 30,
          },
        ]}
        {...WINDOW}
        isPending
      />,
    )
    expect(html).toContain('Waiting for this window')
    // `CategoryGrid`'s own tooltip claim for an absent cell — proof the hatched-absent grid did not
    // also mount underneath the pending caption.
    expect(html).not.toContain('expected cycles')
  })

  test('does not render the pending caption once the query has resolved', () => {
    const html = renderToStaticMarkup(<AvailabilityHeatmap buckets={[]} {...WINDOW} isPending={false} />)
    expect(html).not.toContain('Waiting for this window')
  })

  test('an omitted isPending defaults to the resolved (non-pending) path', () => {
    const html = renderToStaticMarkup(<AvailabilityHeatmap buckets={[]} {...WINDOW} />)
    expect(html).not.toContain('Waiting for this window')
  })
})

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AvailabilityStrip } from './availability-strip'
import { LinkSpeedStrip } from './link-speed-strip'
import { SpeedHeatmap } from './speed-heatmap'
import { SpeedChart } from './speed-chart'
import { BufferbloatChart } from './bufferbloat-chart'
import { LatencyBandChart } from './latency-band-chart'

const WINDOW = { from: 0, to: 3_600_000 } as const
const BUCKETED = { ...WINDOW, bucketSeconds: 300 } as const
const PENDING = 'Loading'

/**
 * The six charts that shipped without a pending guard, and the reason they all needed one at once.
 *
 * Each of them was fed `x ?? []` — an empty array standing in for a query that had not resolved —
 * and each of them turned that into a positive claim about the line rather than an admission that
 * nobody had asked yet. `densifyBuckets` fills the requested window with nulls the moment it is
 * called, so the two strips painted the whole span as measured-and-absent; `SpeedHeatmap` rendered
 * thirty days of "No run · Not measured" cells under a legend reading "No successful run"; the two
 * `MultiLine` charts drew named series with nothing under them; the latency band drew a legend
 * whose entries are an ENCODING for marks that were not on screen.
 *
 * **One shape of assertion now, and the collapse is the point.** Every one of the six used to need
 * an app-side branch to `PendingChart` OUTSIDE its own `ResponsiveChart`, because inside the render
 * prop nothing mounted until a `ResizeObserver` fired — and a pending state no server-rendered
 * guard can observe is one that gets quietly removed. basalt-ui 1.15.0 floors `ChartFrame`'s plot
 * rect at `minWidth` (200px), so the frame renders `ChartPending` whether or not anything has been
 * measured. All six now hand `isPending` to the framework and all six are observable here.
 *
 * What is asserted alongside the caption is what the framework SUPPRESSES: the legend. It renders
 * in SSR either way, so its absence while pending is a real assertion rather than a vacuous one,
 * and it is the load-bearing half on the charts whose legend is an encoding rather than a caption.
 * The accessible label is NOT a useful negative any more — `ChartFrame` carries `ariaLabel` on its
 * outer container and keeps it while pending, deliberately, so a screen reader is told what is
 * loading.
 */

const TEST_RUN = {
  id: 1,
  ts: 1_000,
  backend: 'ookla' as const,
  ok: true,
  downloadMbps: 500,
  uploadMbps: 50,
  pingMs: 5,
  jitterMs: 1,
  latencyDownMs: 20,
  latencyUpMs: 30,
  packetLoss: 0,
  serverName: null,
  serverLocation: null,
  serverId: null,
  isp: null,
  externalIp: null,
  bytesDown: null,
  bytesUp: null,
  resultUrl: null,
  durationS: 10,
  error: null,
}

describe('AvailabilityStrip isPending', () => {
  test('renders the pending caption instead of the strip', () => {
    const html = renderToStaticMarkup(
      <AvailabilityStrip target="cloudflare" buckets={[]} {...BUCKETED} isPending />,
    )
    expect(html).toContain(PENDING)
    // The four fills this strip's legend names. They are the only thing on screen that decodes a
    // hatched column, so a legend over a plot with no columns in it names nothing.
    expect(html).not.toContain('Every cycle down')
    expect(html).not.toContain('Not measured')
  })

  test('does not claim to be pending once resolved', () => {
    const html = renderToStaticMarkup(
      <AvailabilityStrip target="cloudflare" buckets={[]} {...BUCKETED} isPending={false} />,
    )
    expect(html).not.toContain(PENDING)
    expect(html).toContain('Every cycle down')
  })
})

describe('LinkSpeedStrip isPending', () => {
  test('renders the pending caption instead of the strip', () => {
    const html = renderToStaticMarkup(<LinkSpeedStrip vantage={[]} {...BUCKETED} isPending />)
    expect(html).toContain(PENDING)
    expect(html).not.toContain('Negotiated speed')
    // The verdict line above the strip states a conclusion about the window — "No link speed
    // recorded in this window" over an unanswered query is the same fabrication in prose.
    expect(html).not.toContain('buckets reported a speed')
  })

  test('does not claim to be pending once resolved', () => {
    const html = renderToStaticMarkup(<LinkSpeedStrip vantage={[]} {...BUCKETED} isPending={false} />)
    expect(html).not.toContain(PENDING)
    expect(html).toContain('Negotiated speed')
  })
})

describe('SpeedHeatmap isPending', () => {
  test('renders the pending caption, and neither of the two claims the empty grid makes', () => {
    const html = renderToStaticMarkup(<SpeedHeatmap tests={[]} {...WINDOW} isPending />)
    expect(html).toContain(PENDING)
    // The legend caption derived from a `fastest` of null, and the cell tooltip for an hour with
    // no run. Both are findings about the line; neither may render over an unanswered query.
    expect(html).not.toContain('No successful run')
    expect(html).not.toContain('Not measured')
  })

  test('does not claim to be pending once resolved', () => {
    const html = renderToStaticMarkup(<SpeedHeatmap tests={[]} {...WINDOW} isPending={false} />)
    expect(html).not.toContain(PENDING)
  })
})

describe('SpeedChart isPending', () => {
  test('renders the pending caption and drops the ref-line legend', () => {
    const html = renderToStaticMarkup(
      <SpeedChart
        tests={[]}
        refLines={[{ value: 1000, label: 'Host link 1000 Mbit', color: 'var(--vx-warn-ref)' }]}
        isPending
      />,
    )
    expect(html).toContain(PENDING)
    // The ref-line legend is this app's own, not `ChartFrame`'s, so it needs its own suppression —
    // a dashed "Host link 1000 Mbit" caption over a plot with no runs on it names a ceiling for
    // measurements that are not on screen.
    expect(html).not.toContain('Host link 1000 Mbit')
  })

  test('names its ref lines once resolved', () => {
    const html = renderToStaticMarkup(
      <SpeedChart
        tests={[TEST_RUN]}
        refLines={[{ value: 1000, label: 'Host link 1000 Mbit', color: 'var(--vx-warn-ref)' }]}
        isPending={false}
      />,
    )
    expect(html).not.toContain(PENDING)
    expect(html).toContain('Host link 1000 Mbit')
  })
})

describe('BufferbloatChart isPending', () => {
  test('renders the pending caption instead of the chart', () => {
    const html = renderToStaticMarkup(<BufferbloatChart tests={[]} isPending />)
    expect(html).toContain(PENDING)
  })

  test('does not claim to be pending once resolved', () => {
    const html = renderToStaticMarkup(<BufferbloatChart tests={[TEST_RUN]} isPending={false} />)
    expect(html).not.toContain(PENDING)
  })
})

describe('LatencyBandChart isPending', () => {
  /** The legend is the whole point on this one: it is the only place on the page that says what
   * the amber and red dots mean, which makes it an encoding rather than a caption — and an
   * encoding for marks that are not drawn is a legend describing nothing. */
  test('marks itself busy and drops the loss encoding', () => {
    const html = renderToStaticMarkup(
      <LatencyBandChart label="Internet" chartKey="internet" buckets={[]} vantage={[]} {...BUCKETED} isPending />,
    )
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('Loss under 20%')
    expect(html).not.toContain('Cycles fully down')
  })

  test('draws the loss encoding once resolved', () => {
    const html = renderToStaticMarkup(
      <LatencyBandChart
        label="Internet"
        chartKey="internet"
        buckets={[]}
        vantage={[]}
        {...BUCKETED}
        isPending={false}
      />,
    )
    expect(html).not.toContain('aria-busy="true"')
    expect(html).toContain('Loss under 20%')
  })
})

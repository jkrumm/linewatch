import { ChartPending } from 'basalt-ui/charts'

/**
 * basalt-ui's `ChartPending`, for a chart whose width has not been measured yet.
 *
 * The shipped component reserves a numeric footprint because it is normally rendered *inside* an
 * already-measured plot rect — `ChartFrame` measures first and hands it one, and basalt's own
 * `Heatmap` early-returns it from a component that receives `width` as a prop. Neither shape fits
 * most of this directory. These charts own their `ResponsiveChart`, and putting the pending branch
 * inside its render prop makes the pending state render **nothing at all** until a
 * `ResizeObserver` fires — which never happens under `renderToStaticMarkup`, where every
 * pending-state test in this directory observes it. A pending state whose only guard cannot see it
 * is a pending state that gets quietly removed.
 *
 * So the branch sits *outside* the measured container and the enclosing flex row owns the width
 * and the centring. `width={0}` is deliberate rather than a stand-in for an unknown: it makes the
 * inner box contribute no width of its own, so the label centres on the row instead of on a
 * footprint nobody has measured. The row is a bare `<div>` because `charts/` is Mantine-free and
 * `Flex` is unavailable — which as of basalt-ui 1.9.0 needs no `theme-allow`, because
 * `inline-display` and `raw-html-layout` no longer fire on a chart file whose remedy the
 * Mantine-free boundary forbids.
 *
 * **The label is the shipped default, on purpose.** `LatencyBandChart` composes `ChartFrame`
 * directly and hands it `isPending`, so the framework renders that chart's pending box itself and
 * exposes no way to word it. Two charts can be pending at once on a range change — the latency
 * band and the link strip both are — so an app-specific sentence here would put two different
 * loading captions on one screen to no benefit. The honesty this page needs is in the box drawing
 * no axes, no hatching and no marks, which is the framework's job now and not a wording decision.
 */
export function PendingChart({ height }: { height: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', width: '100%', height }}>
      <ChartPending width={0} height={height} />
    </div>
  )
}

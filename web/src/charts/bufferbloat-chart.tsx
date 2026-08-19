import { ChartCard, MultiLine, VX, useChartSize } from 'basalt-ui/charts'
import { useInViewport } from './use-in-viewport'
import type { SpeedTest } from '../lib/types'
import { fmtClock, fmtMs } from '../lib/format'
import { AXIS_LABEL_PX, fitTickCount, runAxisKey, runTickFormat } from '../lib/axis'
import { useCardTitle } from '../lib/compact'

const BUFFERBLOAT_HEIGHT = 260

/** Idle vs loaded latency, per DESIGN.md's "Speed" view ("loaded-vs-idle latency"). The chart
 * plots the three stored measurements and names none of them a verdict: whether the gap between
 * them is a problem, and on which leg, is the verdict layer's sentence to write from the numbers,
 * not a literal authored here. */
export function BufferbloatChart({
  tests,
  isPending,
}: {
  tests: SpeedTest[]
  /** True while the speed-tests query is in flight, handed straight to `MultiLine` — see
   * `speed-chart.tsx`'s docblock for why this stopped being an app-side branch in 1.15.0. An empty
   * run series here draws three named latency lines with nothing under them, which reads as three
   * measurements that came back empty. */
  isPending?: boolean
}) {
  // Oldest first: `GET /api/speedtests` answers newest-first, which is right for a list and
  // backwards for a time axis. Key and label are separate — see `speed-chart.tsx`'s identical pair.
  const ordered = tests.toSorted((a, b) => a.ts - b.ts)
  const points = ordered.map((test) => ({ test, key: runAxisKey(test.ts) }))
  // Measured out here for `xTicks` alone — see `speed-chart.tsx`'s identical wrapper.
  const { ref: sizeRef, width } = useChartSize()
  // Its own wrapper rather than the measuring div: `useChartSize`'s ref is a CALLBACK ref of
  // unpinned identity, and merging two callback refs inline would detach and re-observe on
  // every render. One layout-neutral div is the cheaper answer.
  const { ref: viewRef, inView } = useInViewport<HTMLDivElement>()
  const plotWidth = Math.max(1, width - VX.margin.left - VX.margin.right)

  return (
    <ChartCard
      title={useCardTitle("Latency under load")}
      tooltip="Idle ping is measured at rest; loaded latency is measured while the download or upload saturates the line. One point per run, drawn at equal spacing regardless of the gap between runs — so the shared cursor marks the run nearest the moment you are hovering, not the same horizontal position."
    >
      {/* See `availability-strip.tsx`'s identical wrapper for why this is a floor, not a height. */}
      <div ref={viewRef}>
        <div ref={sizeRef} style={{ minHeight: BUFFERBLOAT_HEIGHT }}>
          <MultiLine
            data={points}
            chartId="speed-loaded-latency"
            ariaLabel="Idle ping against latency measured while the line was saturated, one point per speed-test run"
            isPending={isPending === true}
            // See `speed-chart.tsx`'s identical wrapper for why a tick COUNT has to be derived from a
            // measured width at all.
            xTicks={fitTickCount(
              points.length,
              Math.max(2, Math.floor(plotWidth / AXIS_LABEL_PX)),
              plotWidth,
            )}
            getX={(p) => p.key}
            formatX={runTickFormat}
            // Numbers on this card while the cursor is on a chart above — see
            // `latency-band-chart`'s `onFollow` for why every chart on this page opts in.
            tooltip={{
              onFollow: inView,
              // The run's clock, for the reason `speed-chart` gives.
              label: (p) => ({ text: fmtClock(p.test.ts), color: VX.legendText }),
            }}
            series={[
              {
                key: 'ping',
                label: 'Idle ping',
                color: VX.line,
                mark: 'line',
                getValue: (p) => p.test.pingMs,
              },
              {
                key: 'loadedDown',
                label: 'Loaded (down)',
                color: VX.status.warn,
                mark: 'line',
                dash: 'dashed',
                getValue: (p) => p.test.latencyDownMs,
              },
              {
                key: 'loadedUp',
                label: 'Loaded (up)',
                color: VX.status.bad,
                mark: 'line',
                dash: 'dashed',
                getValue: (p) => p.test.latencyUpMs,
              },
            ]}
            // The unit rides the axis here, unlike `speed-chart` where a subtitle carries it: this is
            // the same `fmtMs` the latency band's own left axis uses, and the two charts read against
            // each other. Margins are measured from the labels actually painted as of 1.15.0, so the
            // clipped-gutter hazard that argument used to carry is gone.
            y={{ domain: 'auto', format: fmtMs }}
            height={BUFFERBLOAT_HEIGHT}
          />
        </div>
      </div>
    </ChartCard>
  )
}

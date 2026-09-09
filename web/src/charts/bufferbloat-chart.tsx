import type { CSSProperties } from 'react'
import { ChartCard, MultiLine, VX } from 'basalt-ui/charts'
import { useInViewport } from './use-in-viewport'
import type { SpeedTest } from '../lib/types'
import { fmtClock, fmtMs } from '../lib/format'
import { axisTickValues, runAxisKey, runTickFormat } from '../lib/axis'
import { dashboard } from '../lib/dashboard-store'
import classes from './bufferbloat-chart.module.css'

/**
 * The one chart on this page tall enough to be worth shrinking on a phone — and the candidate the
 * 1.30.0 upgrade named and could not act on, because `ResponsiveChartHeight` was declared on
 * `ChartFrame` alone and `basalt/hand-rolled-plot` forbids composing that here. basalt-ui 1.30.1
 * widens the kinds, so the intent finally reaches a compliant call site.
 *
 * `base` is 190 and not lower because 190 is this app's floor for the "lines over a window" idiom:
 * `latency-band-chart` draws at it, and `speed-chart`'s docblock records 190 being one step too far
 * for a chart whose traces have to sit clear of horizontal references. Three latency lines with no
 * references have the room 190 leaves.
 *
 * The step is `sm` — 768px of MEASURED container width, not viewport. Every card here is full width
 * inside `__root.tsx`'s 1600 Container, so the two coincide and the short height is reached by real
 * phones and portrait tablets only.
 *
 * Nothing else on the page earns this. The two heatmaps derive their height from their row count,
 * the two strips are already ~90px, and the latency band and throughput bars are the charts
 * `speed-chart`'s docblock names as the ones that must NOT lose height — spikes and gaps are their
 * content. `speed-chart` itself is 220 and already has a shorter variant under `compact`, chosen by
 * the reader rather than by the viewport.
 */
const BUFFERBLOAT_HEIGHT = 260
const BUFFERBLOAT_HEIGHT_PHONE = 190

/** Both heights as a `ResponsiveChartHeight` (basalt-ui 1.30.1) and as the wrapper's floor, from
 * one pair of constants. */
const BUFFERBLOAT_RESPONSIVE_HEIGHT = { base: BUFFERBLOAT_HEIGHT_PHONE, sm: BUFFERBLOAT_HEIGHT }
const FLOOR_VARS = {
  '--linewatch-bufferbloat-floor-phone': `${BUFFERBLOAT_HEIGHT_PHONE}px`,
  '--linewatch-bufferbloat-floor': `${BUFFERBLOAT_HEIGHT}px`,
} as CSSProperties

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
  const { ref: viewRef, inView } = useInViewport<HTMLDivElement>()
  const [compact] = dashboard.field.compact.use()

  return (
    <ChartCard
      // Titled in compact only, where there is no section heading to name the block — see
      // `GuidedChart` for the whole rule.
      title={compact ? 'Latency under load' : undefined}
      info="Idle ping is measured at rest; loaded latency is measured while the download or upload saturates the line. One point per run, drawn at equal spacing regardless of the gap between runs — so the shared cursor marks the run nearest the moment you are hovering, not the same horizontal position."
    >
      {/* See `availability-strip.tsx`'s identical wrapper for why this is a floor, not a height.
          Here it has to STEP with the chart: a floor left at 260 would hold a 260px box around a
          190px plot and make the responsive height inert. */}
      <div ref={viewRef} className={classes.floor} style={FLOOR_VARS}>
        <MultiLine
          data={points}
          chartId="speed-loaded-latency"
          ariaLabel="Idle ping against latency measured while the line was saturated, one point per speed-test run"
          isPending={isPending === true}
          // Tick VALUES, not a count — see `speed-chart.tsx`'s identical prop.
          xTickValues={axisTickValues}
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
          height={BUFFERBLOAT_RESPONSIVE_HEIGHT}
        />
      </div>
    </ChartCard>
  )
}

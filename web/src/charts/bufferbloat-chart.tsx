import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { ChartCard, Lines } from 'basalt-ui/charts'
import { VX } from 'basalt-ui/tokens'
import { useInViewport } from './use-in-viewport'
import type { SpeedTest } from '../lib/types'
import { fmtMs } from '../lib/format'
import { runTickFormat } from '../lib/axis'
import { runHeader, runX, toRuns, type Run } from '../lib/speed-runs'
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
 * The step is `wide` — 800px of MEASURED frame width, not viewport (basalt-ui 1.31.0 hard-removed
 * the `sm` key, which stepped at 768). Every card here is full width inside `__root.tsx`'s 1600
 * Container, so the short height is reached by real phones and portrait tablets only.
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
const BUFFERBLOAT_RESPONSIVE_HEIGHT = { base: BUFFERBLOAT_HEIGHT_PHONE, wide: BUFFERBLOAT_HEIGHT }
const FLOOR_VARS = {
  '--linewatch-bufferbloat-floor-phone': `${BUFFERBLOAT_HEIGHT_PHONE}px`,
  '--linewatch-bufferbloat-floor': `${BUFFERBLOAT_HEIGHT}px`,
} as CSSProperties

const SERIES = [
  { key: 'ping', label: 'Idle ping', color: VX.line, getValue: (r: Run) => r.test.pingMs },
  {
    key: 'loadedDown',
    label: 'Loaded (down)',
    color: VX.status.warn,
    dash: 'dashed' as const,
    getValue: (r: Run) => r.test.latencyDownMs,
  },
  {
    key: 'loadedUp',
    label: 'Loaded (up)',
    color: VX.status.bad,
    dash: 'dashed' as const,
    getValue: (r: Run) => r.test.latencyUpMs,
  },
]

/** Idle vs loaded latency, per DESIGN.md's "Speed" view ("loaded-vs-idle latency"). The chart
 * plots the three stored measurements and names none of them a verdict: whether the gap between
 * them is a problem, and on which leg, is the verdict layer's sentence to write from the numbers,
 * not a literal authored here. */
export function BufferbloatChart({
  tests,
  isPending,
}: {
  tests: SpeedTest[]
  /** True while the speed-tests query is in flight. An empty run series here draws three named
   * latency lines with nothing under them, which reads as three measurements that came back empty;
   * the legend is dropped too (2.x renders it over a plot with no marks). */
  isPending?: boolean
}) {
  const points = useMemo(() => toRuns(tests), [tests])
  const { ref: viewRef, inView } = useInViewport<HTMLDivElement>()
  const [compact] = dashboard.field.compact.use()
  const pending = isPending === true
  const tooltip = useMemo(
    () => ({
      onFollow: inView,
      formatHeader: runHeader,
    }),
    [inView],
  )

  return (
    <ChartCard
      // Titled in compact only, where there is no section heading to name the block — see
      // `GuidedChart` for the whole rule.
      title={compact ? 'Latency under load' : undefined}
      info="Idle ping is measured at rest; loaded latency is measured while the download or upload saturates the line. One point per run, placed at the moment the run happened."
    >
      {/* See `availability-strip.tsx`'s identical wrapper for why this is a floor, not a height.
          Here it has to STEP with the chart: a floor left at 260 would hold a 260px box around a
          190px plot and make the responsive height inert. The outer div is the container the floor
          queries: the frame's own width, so the two step at the same 800px. */}
      <div className={classes.frame}>
        <div ref={viewRef} className={classes.floor} style={FLOOR_VARS}>
          <Lines
            data={points}
            x={runX}
            series={SERIES}
            formatX={runTickFormat}
            // The unit rides the axis here, unlike `speed-chart` where a subtitle carries it: this
            // is the same `fmtMs` the latency band's own left axis uses, and the two read together.
            y={{ domain: 'auto', format: fmtMs }}
            height={BUFFERBLOAT_RESPONSIVE_HEIGHT}
            state={{ pending }}
            ariaLabel="Idle ping against latency measured while the line was saturated, one point per speed-test run"
            legend={pending ? false : undefined}
            tooltip={tooltip}
          />
        </div>
      </div>
    </ChartCard>
  )
}

import { ChartCard, MultiLine, ResponsiveChart, VX } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'
import { fmtMs } from '../lib/format'
import { AXIS_LABEL_PX, fitTickCount, runAxisLabels } from '../lib/axis'
import { PendingChart } from './pending'

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
  /** True while the speed-tests query is in flight. Same guard, same placement and the same reason
   * as `speed-chart.tsx`'s — see its docblock for why the branch is here rather than on
   * `MultiLine`'s own `isPending`. An empty run series here draws three named latency lines with
   * nothing under them, which reads as three measurements that came back empty. */
  isPending?: boolean
}) {
  // The identical fix `speed-chart.tsx` already made and documents in full: `GET /api/speedtests`
  // answers newest-first, backwards for a time axis, and `MultiLine` forwards no `tickFormat` to its
  // x-axis, so an unformatted ISO string reduces to `DD.MM` through basalt's own `fmtAxisDate` — a
  // 24 h window printed `02.08` roughly two dozen times, smeared into one illegible block. This
  // chart never got either fix when `speed-chart.tsx` did.
  const ordered = tests.toSorted((a, b) => a.ts - b.ts)
  const labels = runAxisLabels(ordered.map((t) => t.ts))
  const points = ordered.map((test, i) => ({ test, label: labels[i] ?? '' }))

  return (
    <ChartCard
      title="Latency under load"
      subtitle="Idle ping vs. latency during the run · one point per run — the cursor here doesn't carry to the charts above."
      tooltip="Idle ping is measured at rest; loaded latency is measured while the download or upload saturates the line. One point per run, drawn at equal spacing regardless of the gap between runs."
    >
      {/* See `availability-strip.tsx`'s identical wrapper for why this is a floor, not a height. */}
      <div style={{ minHeight: BUFFERBLOAT_HEIGHT }}>
        {isPending === true ? (
          <PendingChart height={BUFFERBLOAT_HEIGHT} />
        ) : (
          <ResponsiveChart height={BUFFERBLOAT_HEIGHT}>
            {({ width }) => {
              // The *plot* width, not the container's — see `speed-chart.tsx`'s identical wrapper for
              // why `numTicksX` has to be derived from a measured width at all.
              const plotWidth = Math.max(1, width - VX.margin.left - VX.margin.right)
              return (
                <MultiLine
                  data={points}
                  chartId="speed-loaded-latency"
                  ariaLabel="Idle ping against latency measured while the line was saturated, one point per speed-test run"
                  numTicksX={fitTickCount(
                    points.length,
                    Math.max(2, Math.floor(plotWidth / AXIS_LABEL_PX)),
                    plotWidth,
                  )}
                  getX={(p) => p.label}
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
                  yDomain="auto"
                  formatValue={fmtMs}
                  height={BUFFERBLOAT_HEIGHT}
                />
              )
            }}
          </ResponsiveChart>
        )}
      </div>
    </ChartCard>
  )
}

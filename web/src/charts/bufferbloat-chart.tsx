import { ChartCard, MultiLine, VX } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'
import { fmtMs } from '../lib/format'

/** Idle vs loaded latency, per DESIGN.md's "Speed" view ("loaded-vs-idle latency"). The chart
 * plots the three stored measurements and names none of them a verdict: whether the gap between
 * them is a problem, and on which leg, is the verdict layer's sentence to write from the numbers,
 * not a literal authored here. */
export function BufferbloatChart({ tests }: { tests: SpeedTest[] }) {
  return (
    <ChartCard
      title="Latency under load"
      subtitle="Idle ping vs. latency during the run · one point per run"
      tooltip="Idle ping is measured at rest; loaded latency is measured while the download or upload saturates the line. One point per run, drawn at equal spacing regardless of the gap between runs."
    >
      <MultiLine
        data={tests}
        chartId="speed-loaded-latency"
        getX={(t) => new Date(t.ts).toISOString()}
        series={[
          {
            key: 'ping',
            label: 'Idle ping',
            color: VX.line,
            mark: 'line',
            getValue: (t) => t.pingMs,
          },
          {
            key: 'loadedDown',
            label: 'Loaded (down)',
            color: VX.status.warn,
            mark: 'line',
            dash: 'dashed',
            getValue: (t) => t.latencyDownMs,
          },
          {
            key: 'loadedUp',
            label: 'Loaded (up)',
            color: VX.status.bad,
            mark: 'line',
            dash: 'dashed',
            getValue: (t) => t.latencyUpMs,
          },
        ]}
        yDomain="auto"
        formatValue={fmtMs}
        height={260}
      />
    </ChartCard>
  )
}

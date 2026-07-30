import { ChartCard, MultiLine, VX } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'
import { fmtMs } from '../lib/format'

export function BufferbloatChart({ tests }: { tests: SpeedTest[] }) {
  return (
    <ChartCard
      title="Bufferbloat"
      subtitle="Idle ping vs. latency under load"
      tooltip="Idle ping is measured at rest; loaded latency is measured while the download/upload saturates the line. A wide gap between them is bufferbloat."
    >
      <MultiLine
        data={tests}
        chartId="bufferbloat"
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

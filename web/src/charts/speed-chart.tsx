import { ChartCard, MultiLine, VX } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'
import { fmtMbps } from '../lib/format'

export function SpeedChart({ tests }: { tests: SpeedTest[] }) {
  return (
    <ChartCard
      title="Throughput"
      subtitle="Download / upload over time"
      tooltip="Hourly Ookla runs. Download and upload share one axis."
    >
      <MultiLine
        data={tests}
        chartId="speed-throughput"
        getX={(t) => new Date(t.ts).toISOString()}
        series={[
          {
            key: 'download',
            label: 'Download',
            color: VX.line,
            mark: 'line',
            getValue: (t) => t.downloadMbps,
          },
          {
            key: 'upload',
            label: 'Upload',
            color: VX.line2,
            mark: 'line',
            getValue: (t) => t.uploadMbps,
          },
        ]}
        yDomain="auto"
        formatValue={fmtMbps}
        height={260}
      />
    </ChartCard>
  )
}

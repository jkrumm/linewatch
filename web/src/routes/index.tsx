import { createFileRoute } from '@tanstack/react-router'
import { SimpleGrid, Stack } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { StatCard } from 'basalt-ui'
import { ChartCard, LineSparkline, ResponsiveChart, VX } from 'basalt-ui/charts'
import { probeBucketsQuery, statusQuery } from '../lib/queries'
import { StatusBanner } from '../components/status-banner'
import { TargetTile } from '../components/target-tile'
import { TARGETS } from '../lib/types'
import { fmtMbps, fmtMs, fmtRelative } from '../lib/format'

/** 15-minute buckets over 24h ≈ 96 points for the WAN latency sparkline. */
const SPARKLINE_BUCKET_SECONDS = 900

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(statusQuery()),
  component: NowPage,
})

function NowPage() {
  const { data: status } = useQuery(statusQuery())
  const now = Date.now()
  const { data: sparklineBuckets } = useQuery(
    probeBucketsQuery({
      from: now - 24 * 3_600_000,
      to: now,
      target: 'cloudflare',
      bucket: SPARKLINE_BUCKET_SECONDS,
    }),
  )

  if (!status) return null

  const sparkValues = (sparklineBuckets ?? []).flatMap((b) =>
    b.medianMs === null ? [] : [b.medianMs],
  )
  const sampleByTarget = new Map(status.lastSamples.map((sample) => [sample.target, sample]))

  return (
    <Stack gap="lg">
      <StatusBanner ongoingOutages={status.ongoingOutages} />

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
        <StatCard label="Download" value={fmtMbps(status.lastSpeedTest?.downloadMbps ?? null)} />
        <StatCard label="Upload" value={fmtMbps(status.lastSpeedTest?.uploadMbps ?? null)} />
        <StatCard label="Idle ping" value={fmtMs(status.lastSpeedTest?.pingMs ?? null)} />
        <StatCard
          label="Last speed test"
          value={status.lastSpeedTest ? fmtRelative(status.lastSpeedTest.ts, now) : '—'}
        />
      </SimpleGrid>

      <ChartCard
        title="WAN latency"
        subtitle="Cloudflare median, last 24h"
        tooltip="The WAN anchor's median round-trip time over the last 24 hours."
      >
        <ResponsiveChart height={64}>
          {({ width, height }) => (
            <LineSparkline
              data={sparkValues}
              width={width}
              height={height}
              color={VX.line}
              ariaLabel="Cloudflare median latency, last 24 hours"
            />
          )}
        </ResponsiveChart>
      </ChartCard>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        {TARGETS.map((target) => (
          <TargetTile key={target} target={target} sample={sampleByTarget.get(target) ?? null} />
        ))}
      </SimpleGrid>
    </Stack>
  )
}

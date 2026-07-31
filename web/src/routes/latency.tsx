import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { Group, Stack, Title } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { ChartCard, ChartHoverSync } from 'basalt-ui/charts'
import { probeBucketsQuery } from '../lib/queries'
import { RangeSelector } from '../components/range-selector'
import { LatencyBandChart } from '../charts/latency-band-chart'
import { RANGE_OPTIONS, rangeToBucket, rangeToWindow, type RangeOption } from '../lib/range'
import { TARGET_LABEL, TARGETS } from '../lib/types'

const SearchSchema = z.object({
  range: z.enum(RANGE_OPTIONS).default('24h'),
})

type SearchParams = z.infer<typeof SearchSchema>

export const Route = createFileRoute('/latency')({
  validateSearch: (raw: Record<string, unknown>) => SearchSchema.parse(raw),
  loaderDeps: ({ search }: { search: SearchParams }) => ({ range: search.range }),
  loader: ({ context, deps }) => {
    const { from, to } = rangeToWindow(deps.range)
    const bucket = rangeToBucket(deps.range)
    return Promise.all(
      TARGETS.map((target) =>
        context.queryClient.ensureQueryData(probeBucketsQuery({ from, to, target, bucket })),
      ),
    )
  },
  component: LatencyPage,
})

function LatencyPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const { from, to } = rangeToWindow(search.range)
  const bucket = rangeToBucket(search.range)

  return (
    <Stack gap="lg">
      <Group justify="space-between" wrap="wrap">
        <Title order={3}>Latency</Title>
        <RangeSelector
          value={search.range}
          options={RANGE_OPTIONS}
          onChange={(range) => void navigate({ to: '/latency', search: { range } })}
        />
      </Group>

      <ChartHoverSync>
        <Stack gap="md">
          {TARGETS.map((target) => (
            <TargetLatencyPanel key={target} target={target} from={from} to={to} bucket={bucket} />
          ))}
        </Stack>
      </ChartHoverSync>
    </Stack>
  )
}

function TargetLatencyPanel({
  target,
  from,
  to,
  bucket,
}: {
  target: (typeof TARGETS)[number]
  from: number
  to: number
  bucket: ReturnType<typeof rangeToBucket>
}) {
  const { data } = useQuery(probeBucketsQuery({ from, to, target, bucket }))

  return (
    <ChartCard
      title={TARGET_LABEL[target]}
      subtitle="Median RTT · p5–p95 spread · worst ping · loss"
      tooltip="Median round-trip time with the p5–p95 spread shaded behind it, SmokePing-style, and a faint outer line at the slowest single ping in each bucket. Dots mark cycles with packet loss. Hatched columns were not measured at all; a red column is a bucket where cycles got nothing back; the hatched rail along the bottom marks buckets not provably measured over the home line."
    >
      <LatencyBandChart
        target={target}
        buckets={data?.buckets ?? []}
        vantage={data?.vantage ?? []}
        from={from}
        to={to}
        bucketSeconds={bucket}
      />
    </ChartCard>
  )
}

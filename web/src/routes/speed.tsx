import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { Group, SimpleGrid, Stack, Title } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { StatCard } from 'basalt-ui'
import { speedSummaryQuery, speedTestsQuery } from '../lib/queries'
import { RangeSelector } from '../components/range-selector'
import { ServerChangeNote } from '../components/server-change-note'
import { SpeedChart } from '../charts/speed-chart'
import { SpeedHeatmap } from '../charts/speed-heatmap'
import { BufferbloatChart } from '../charts/bufferbloat-chart'
import { rangeToWindow, type RangeOption } from '../lib/range'
import { fmtMbps } from '../lib/format'

const SPEED_RANGE_OPTIONS = ['24h', '7d', '30d', 'all'] as const satisfies readonly RangeOption[]

const SearchSchema = z.object({
  range: z.enum(SPEED_RANGE_OPTIONS).default('7d'),
})

type SearchParams = z.infer<typeof SearchSchema>

function rangeToDays(from: number, to: number): number {
  return Math.max(1, Math.round((to - from) / 86_400_000))
}

export const Route = createFileRoute('/speed')({
  validateSearch: (raw: Record<string, unknown>) => SearchSchema.parse(raw),
  loaderDeps: ({ search }: { search: SearchParams }) => ({ range: search.range }),
  loader: ({ context, deps }) => {
    const { from, to } = rangeToWindow(deps.range)
    return Promise.all([
      context.queryClient.ensureQueryData(speedTestsQuery({ from, to })),
      context.queryClient.ensureQueryData(speedSummaryQuery(rangeToDays(from, to))),
    ])
  },
  component: SpeedPage,
})

function SpeedPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const { from, to } = rangeToWindow(search.range)
  const days = rangeToDays(from, to)

  const { data: tests } = useQuery(speedTestsQuery({ from, to }))
  const { data: summary } = useQuery(speedSummaryQuery(days))

  return (
    <Stack gap="lg">
      <Group justify="space-between" wrap="wrap">
        <Title order={3}>Speed</Title>
        <RangeSelector
          value={search.range}
          options={SPEED_RANGE_OPTIONS}
          onChange={(range) => void navigate({ to: '/speed', search: { range } })}
        />
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
        <StatCard label="Download p50" value={fmtMbps(summary?.download.p50 ?? null)} />
        <StatCard label="Download p95" value={fmtMbps(summary?.download.p95 ?? null)} />
        <StatCard label="Upload p50" value={fmtMbps(summary?.upload.p50 ?? null)} />
        <StatCard label="Upload p95" value={fmtMbps(summary?.upload.p95 ?? null)} />
      </SimpleGrid>

      <SpeedChart tests={tests ?? []} />
      <ServerChangeNote tests={tests ?? []} />
      <SpeedHeatmap tests={tests ?? []} />
      <BufferbloatChart tests={tests ?? []} />
    </Stack>
  )
}

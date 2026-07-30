import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { Card, Group, SegmentedControl, Stack, Text, Title } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { outagesQuery, probeBucketsQuery } from '../lib/queries'
import { RangeSelector } from '../components/range-selector'
import { OutageTable } from '../components/outage-table'
import { AvailabilityHeatmap } from '../charts/availability-heatmap'
import { RANGE_OPTIONS, rangeToWindow, type RangeOption } from '../lib/range'
import { fmtDowntimeMinutes } from '../lib/format'

const UPTIME_RANGE_OPTIONS: readonly RangeOption[] = ['24h', '7d', '30d', 'all']

const MIN_DURATION_OPTIONS = [
  { label: 'Any', value: '0' },
  { label: '≥1m', value: '60' },
  { label: '≥5m', value: '300' },
  { label: '≥10m', value: '600' },
]

const SearchSchema = z.object({
  range: z.enum(RANGE_OPTIONS).default('7d'),
  minDuration: z.coerce.number().int().min(0).default(0),
})

type SearchParams = z.infer<typeof SearchSchema>

const HEATMAP_SPAN_MS = 30 * 86_400_000
const HEATMAP_BUCKET_SECONDS = 3_600

export const Route = createFileRoute('/uptime')({
  validateSearch: (raw: Record<string, unknown>) => SearchSchema.parse(raw),
  loaderDeps: ({ search }: { search: SearchParams }) => ({
    range: search.range,
    minDuration: search.minDuration,
  }),
  loader: ({ context, deps }) => {
    const { from, to } = rangeToWindow(deps.range)
    return Promise.all([
      context.queryClient.ensureQueryData(
        outagesQuery({ from, to, minDuration: deps.minDuration }),
      ),
      context.queryClient.ensureQueryData(
        probeBucketsQuery({
          from: to - HEATMAP_SPAN_MS,
          to,
          target: 'cloudflare',
          bucket: HEATMAP_BUCKET_SECONDS,
        }),
      ),
    ])
  },
  component: UptimePage,
})

function UptimePage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const { from, to } = rangeToWindow(search.range)

  const { data: outages } = useQuery(outagesQuery({ from, to, minDuration: search.minDuration }))
  const { data: heatmapBuckets } = useQuery(
    probeBucketsQuery({
      from: to - HEATMAP_SPAN_MS,
      to,
      target: 'cloudflare',
      bucket: HEATMAP_BUCKET_SECONDS,
    }),
  )

  const totalDowntimeS = (outages ?? []).reduce((sum, outage) => sum + (outage.durationS ?? 0), 0)

  return (
    <Stack gap="lg">
      <Group justify="space-between" wrap="wrap">
        <Title order={3}>Uptime</Title>
        <RangeSelector
          value={search.range}
          options={UPTIME_RANGE_OPTIONS}
          onChange={(range) => void navigate({ to: '/uptime', search: { ...search, range } })}
        />
      </Group>

      <Card withBorder radius="md" padding="lg">
        <Text size="xs" c="dimmed" tt="uppercase">
          Total downtime — {search.range}
        </Text>
        <Text fw={700} fz={32} ff="monospace">
          {fmtDowntimeMinutes(totalDowntimeS)}
        </Text>
        <Text size="sm" c="dimmed">
          Minutes, not a percentage — on a home line the percentage flatters.
        </Text>
      </Card>

      <AvailabilityHeatmap buckets={heatmapBuckets ?? []} />

      <Card withBorder radius="md" padding="lg">
        <Group justify="space-between" mb="md" wrap="wrap">
          <Title order={4}>Outages</Title>
          <SegmentedControl
            value={String(search.minDuration)}
            onChange={(value) =>
              void navigate({ to: '/uptime', search: { ...search, minDuration: Number(value) } })
            }
            data={MIN_DURATION_OPTIONS}
          />
        </Group>
        <OutageTable outages={outages ?? []} />
      </Card>
    </Stack>
  )
}

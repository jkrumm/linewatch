import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { Card, Group, SegmentedControl, Stack, Text, Title } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { outagesQuery, probeBucketsQuery } from '../lib/queries'
import { RangeSelector } from '../components/range-selector'
import { OutageTable } from '../components/outage-table'
import { AVAILABILITY_BUCKET_SECONDS, AvailabilityHeatmap } from '../charts/availability-heatmap'
import { CoverageCallout } from '../components/coverage-callout'
import { RANGE_OPTIONS, rangeToWindow, type RangeOption } from '../lib/range'
import { windowDowntime } from '../lib/downtime'
import { fmtMinutes } from '../lib/format'

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
/** Owned by the chart: one cell is one UTC hour, so the query's bucket size is not the route's to
 * pick. A mismatch would put two readings in one cell and lose one of them silently. */
const HEATMAP_BUCKET_SECONDS = AVAILABILITY_BUCKET_SECONDS

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

  const { data: outageData } = useQuery(outagesQuery({ from, to, minDuration: search.minDuration }))
  const outages = outageData?.outages
  const { data: probeData } = useQuery(
    probeBucketsQuery({
      from: to - HEATMAP_SPAN_MS,
      to,
      target: 'cloudflare',
      bucket: HEATMAP_BUCKET_SECONDS,
    }),
  )

  // Clipped to the window and counting outages that have not ended — see `windowDowntime` for both
  // reasons. `to` is the floored clock the rest of this page is drawn against, so it doubles as
  // "now" for an outage still in progress.
  const downtime = windowDowntime(outages ?? [], { from, to }, to)

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
          {fmtMinutes(downtime.seconds)}
          {/* An open outage is still growing, so the figure is a floor the moment it renders. */}
          {downtime.openCount > 0 && (
            <Text span fz={20} c="red" ff="monospace">
              {' '}
              ({downtime.openCount} still open)
            </Text>
          )}
        </Text>
        <Text size="sm" c="dimmed">
          Minutes, not a percentage — on a home line the percentage flatters. Outages straddling the
          range count only their time inside it.
        </Text>
      </Card>

      <CoverageCallout summary={outageData?.summary ?? null} />

      <AvailabilityHeatmap
        buckets={probeData?.buckets ?? []}
        from={to - HEATMAP_SPAN_MS}
        to={to}
      />

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

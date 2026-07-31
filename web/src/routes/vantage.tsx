import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { Card, Group, Stack, Title } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { ChartCard } from 'basalt-ui/charts'
import { eventsQuery, probeBucketsQuery, routerQuery, statusQuery } from '../lib/queries'
import { RangeSelector } from '../components/range-selector'
import { VantageCard } from '../components/vantage-card'
import { LinkComparison } from '../components/link-comparison'
import { TransitionTimeline } from '../components/transition-timeline'
import { LinkSpeedStrip } from '../charts/link-speed-strip'
import { RANGE_OPTIONS, rangeToBucket, rangeToWindow, type RangeOption } from '../lib/range'

const VANTAGE_RANGE_OPTIONS: readonly RangeOption[] = ['1h', '24h', '7d', '30d']

const SearchSchema = z.object({
  range: z.enum(RANGE_OPTIONS).default('24h'),
})

type SearchParams = z.infer<typeof SearchSchema>

/** The vantage series belongs to the cycle, not the target, so which target is queried does not
 * change it — `GET /api/probes` returns the same `vantage[]` whichever is asked for. Cloudflare is
 * the WAN anchor the rest of the dashboard defaults to. */
const VANTAGE_SERIES_TARGET = 'cloudflare'

export const Route = createFileRoute('/vantage')({
  validateSearch: (raw: Record<string, unknown>) => SearchSchema.parse(raw),
  loaderDeps: ({ search }: { search: SearchParams }) => ({ range: search.range }),
  loader: ({ context, deps }) => {
    const { from, to } = rangeToWindow(deps.range)
    return Promise.all([
      context.queryClient.ensureQueryData(statusQuery()),
      context.queryClient.ensureQueryData(routerQuery()),
      context.queryClient.ensureQueryData(eventsQuery({ from, to })),
      context.queryClient.ensureQueryData(
        probeBucketsQuery({
          from,
          to,
          target: VANTAGE_SERIES_TARGET,
          bucket: rangeToBucket(deps.range),
        }),
      ),
    ])
  },
  component: VantagePage,
})

/**
 * "What am I measuring through, did the path change, and what does the carrier say" — the three
 * questions `probe_cycle`, `event.link_change` and the four `router_*` tables were added to answer
 * and which nothing rendered until now.
 *
 * No sentence on this page is authored by a component. Each block either shows a measured value
 * with its age, or says why it is showing none.
 */
function VantagePage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  // Via rangeToWindow, not a raw clock read: `from`/`to` go straight into the query keys, and an
  // unquantised now mints a new key every render and refetches forever (see `lib/range.ts`). `to`
  // doubles as "now" for every age and staleness verdict on this page.
  const { from, to } = rangeToWindow(search.range)
  const bucketSeconds = rangeToBucket(search.range)

  const { data: status } = useQuery(statusQuery())
  const { data: router } = useQuery(routerQuery())
  const { data: events } = useQuery(eventsQuery({ from, to }))
  const { data: probeData } = useQuery(
    probeBucketsQuery({ from, to, target: VANTAGE_SERIES_TARGET, bucket: bucketSeconds }),
  )

  return (
    <Stack gap="lg">
      <Group justify="space-between" wrap="wrap">
        <Title order={3}>Vantage</Title>
        <RangeSelector
          value={search.range}
          options={VANTAGE_RANGE_OPTIONS}
          onChange={(range) => void navigate({ to: '/vantage', search: { ...search, range } })}
        />
      </Group>

      <VantageCard vantage={status?.vantage ?? null} now={to} />

      <LinkComparison
        router={router ?? null}
        vantage={status?.vantage ?? null}
        speedTest={status?.lastSpeedTest ?? null}
        now={to}
      />

      <ChartCard
        title="Link speed over time"
        subtitle={`Negotiated rate per bucket, ${search.range}`}
        tooltip="One column per bucket over the whole window. Hatched columns were never measured; faint columns were measured by cycles that reported no link speed. A bucket where the NIC renegotiated is marked, not averaged — the mean of 1000 and 100 is a rate the link never ran at."
      >
        <LinkSpeedStrip
          vantage={probeData?.vantage ?? []}
          from={from}
          to={to}
          bucketSeconds={bucketSeconds}
        />
      </ChartCard>

      <Card withBorder radius="md" padding="lg">
        <Stack gap="md">
          <Title order={4}>Transitions</Title>
          {/* `linkSamplingSince` decides which empty state is true, and the two say opposite
              things — so it is passed through even while events exist. */}
          <TransitionTimeline
            events={events?.events ?? []}
            linkSamplingSince={events?.linkSamplingSince ?? null}
          />
        </Stack>
      </Card>
    </Stack>
  )
}

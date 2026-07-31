import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { Group, SimpleGrid, Stack, Title } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { StatCard } from 'basalt-ui'
import { VX } from 'basalt-ui/charts'
import { routerQuery, speedSummaryQuery, speedTestsQuery, statusQuery } from '../lib/queries'
import { RangeSelector } from '../components/range-selector'
import { ServerChangeNote } from '../components/server-change-note'
import { SpeedChart, type SpeedRefLine } from '../charts/speed-chart'
import { SpeedHeatmap } from '../charts/speed-heatmap'
import { BufferbloatChart } from '../charts/bufferbloat-chart'
import { rangeToWindow, type RangeOption } from '../lib/range'
import type { RouterSnapshot, Vantage } from '../lib/types'
import { fmtMbps } from '../lib/format'
import { isStale } from '../lib/freshness'

const SPEED_RANGE_OPTIONS = ['24h', '7d', '30d', 'all'] as const satisfies readonly RangeOption[]

const SearchSchema = z.object({
  range: z.enum(SPEED_RANGE_OPTIONS).default('7d'),
})

type SearchParams = z.infer<typeof SearchSchema>

function rangeToDays(from: number, to: number): number {
  return Math.max(1, Math.round((to - from) / 86_400_000))
}

/**
 * The two ceilings a throughput reading should be read against: the host's negotiated Ethernet link
 * and the carrier's downstream sync rate. Both come from live readings and both are omitted rather
 * than approximated — a missing link speed is not 1000, and a stale sync rate is not the current
 * one. The labels are built from the numbers themselves, so a renegotiation moves the line and its
 * caption together instead of leaving a sentence behind that used to be true.
 *
 * The two reference tokens differ only so the legend can tell one rule from the other; neither
 * colour is a verdict on the value it marks.
 */
function throughputRefLines(
  vantage: Vantage | null | undefined,
  router: RouterSnapshot | undefined,
  now: number,
): SpeedRefLine[] {
  const refs: SpeedRefLine[] = []

  // Staleness-gated exactly like the carrier line below, and for the same reason from the other
  // end: `GET /api/status` returns the newest `probe_cycle` row forever, so a collector that died
  // on Tuesday still answers with Tuesday's link speed. Drawn ungated, that renders a dashed
  // "Host link 1000 Mbit" ceiling across Thursday's speed tests as though it were current — an
  // absent measurement presented as a present one. `isStale` is the same two-cycle rule
  // web/src/lib/vantage.ts applies to this exact reading; this view simply has to apply it too.
  const linkMbit = vantage?.linkMbit
  if (vantage && !isStale(vantage.ts, now) && linkMbit !== null && linkMbit !== undefined) {
    refs.push({
      value: linkMbit,
      label: `Host link ${linkMbit} Mbit`,
      color: VX.warnRef,
    })
  }

  // `stale` is the server's verdict on its own reading (two poll intervals old), and a stale sync
  // rate drawn as a current ceiling is the router-side version of this project's central bug.
  const line = router?.line
  const downSyncKbps = line?.value?.downSyncKbps
  if (line && !line.stale && downSyncKbps !== null && downSyncKbps !== undefined) {
    const mbps = downSyncKbps / 1000
    refs.push({
      value: mbps,
      label: `Carrier sync ${fmtMbps(mbps)}`,
      color: VX.goodRef,
    })
  }

  return refs
}

export const Route = createFileRoute('/speed')({
  validateSearch: (raw: Record<string, unknown>) => SearchSchema.parse(raw),
  loaderDeps: ({ search }: { search: SearchParams }) => ({ range: search.range }),
  loader: ({ context, deps }) => {
    const { from, to } = rangeToWindow(deps.range)
    return Promise.all([
      context.queryClient.ensureQueryData(speedTestsQuery({ from, to })),
      context.queryClient.ensureQueryData(speedSummaryQuery(rangeToDays(from, to))),
      // Both feed the throughput chart's reference lines — the host's negotiated link and the
      // carrier's sync rate.
      context.queryClient.ensureQueryData(statusQuery()),
      context.queryClient.ensureQueryData(routerQuery()),
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
  const { data: status } = useQuery(statusQuery())
  const { data: router } = useQuery(routerQuery())
  // `to` rather than a raw Date.now(): it is the clock already floored to one probe cycle, the same
  // "now" the range queries were keyed on, so the staleness verdict cannot disagree with the data.
  const refLines = throughputRefLines(status?.vantage, router, to)

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

      <SimpleGrid cols={{ base: 2, sm: 5 }} spacing="md">
        <StatCard label="Download p50" value={fmtMbps(summary?.download.p50 ?? null)} />
        <StatCard label="Download p95" value={fmtMbps(summary?.download.p95 ?? null)} />
        <StatCard label="Upload p50" value={fmtMbps(summary?.upload.p50 ?? null)} />
        <StatCard label="Upload p95" value={fmtMbps(summary?.upload.p95 ?? null)} />
        {/* The sample size the four percentiles were computed over. Hourly runs make an 11-run week
            plausible, and p50 93.7 / p95 551.3 side by side then describe two regimes rather than
            one distribution — which is visible only if the reader can see the n. */}
        <StatCard label={`Successful runs · ${days}d`} value={summary ? String(summary.count) : '—'} />
      </SimpleGrid>

      <SpeedChart tests={tests ?? []} refLines={refLines} />
      <ServerChangeNote tests={tests ?? []} />
      <SpeedHeatmap tests={tests ?? []} from={from} to={to} />
      <BufferbloatChart tests={tests ?? []} />
    </Stack>
  )
}

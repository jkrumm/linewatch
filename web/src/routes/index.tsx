import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import {
  Box,
  Card,
  Collapse,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { StatCard } from 'basalt-ui'
import { ChartHoverSync, VX } from 'basalt-ui/charts'
import { Callout } from 'basalt-ui/content'
import type { ReactNode } from 'react'
import {
  eventsQuery,
  outagesQuery,
  probeBucketsQuery,
  routerQuery,
  speedSummaryQuery,
  speedTestsQuery,
  statusQuery,
  throughputQuery,
  verdictsQuery,
} from '../lib/queries'
import { StatusBanner } from '../components/status-banner'
import { VerdictPanel } from '../components/verdict-panel'
import { LiveTile } from '../components/live-tile'
import { KpiRow, type KpiWindow } from '../components/kpi-row'
import { RangeSelector } from '../components/range-selector'
import { OutageTable } from '../components/outage-table'
import { CoverageCallout } from '../components/coverage-callout'
import { ServerChangeNote } from '../components/server-change-note'
import { VantageCard } from '../components/vantage-card'
import { LinkComparison } from '../components/link-comparison'
import { TransitionTimeline } from '../components/transition-timeline'
import { GuidedChart } from '../components/guided-chart'
import { AvailabilityStrip } from '../charts/availability-strip'
import { AVAILABILITY_BUCKET_SECONDS, AvailabilityHeatmap } from '../charts/availability-heatmap'
import { LatencyBandChart } from '../charts/latency-band-chart'
import { LatencyCompareChart } from '../charts/latency-compare-chart'
import { SpeedChart, type SpeedRefLine } from '../charts/speed-chart'
import { SpeedHeatmap } from '../charts/speed-heatmap'
import { BufferbloatChart } from '../charts/bufferbloat-chart'
import { LinkSpeedStrip } from '../charts/link-speed-strip'
import { ThroughputChart } from '../charts/throughput-chart'
import { comparePointsFrom } from '../lib/aggregate'
import { throughputPoints, throughputTotals } from '../lib/throughput'
import { windowDowntime } from '../lib/downtime'
import { liveGateway, liveInternet } from '../lib/live'
import { SECTION_LABEL, sectionAnchor, unmappedVerdictIds } from '../lib/verdict-section'
import { RANGE_LABEL, RANGE_OPTIONS, rangeToBucket, rangeToWindow } from '../lib/range'
import {
  TARGET_LABEL,
  TARGETS,
  type ProbeBucket,
  type RouterSnapshot,
  type TargetName,
  type Vantage,
} from '../lib/types'
import { fmtBytes, fmtMbps, fmtMinutes } from '../lib/format'
import { isStale } from '../lib/freshness'
import {
  AVAILABILITY_COPY,
  LATENCY_BAND_COPY,
  LATENCY_COMPARE_COPY,
  LINK_SPEED_COPY,
  THROUGHPUT_COPY,
} from '../lib/guides'

const MIN_DURATION_OPTIONS = [
  { label: 'Any', value: '0' },
  { label: '≥1m', value: '60' },
  { label: '≥5m', value: '300' },
  { label: '≥10m', value: '600' },
]

/**
 * The heatmap's own span and bucket, independent of the page range.
 *
 * It is a fixed-shape artifact — one cell per UTC hour, one row per day — so a 1 h range would
 * draw a single cell and the `all` range an unreadable wall. It always shows 30 days and its
 * heading says so, rather than silently reinterpreting the range control above it. The bucket size
 * is the chart's own constant: a mismatch would put two readings in one cell and lose one.
 */
const HEATMAP_SPAN_MS = 30 * 86_400_000
const HEATMAP_BUCKET_SECONDS = AVAILABILITY_BUCKET_SECONDS

const SearchSchema = z.object({
  range: z.enum(RANGE_OPTIONS).default('24h'),
  minDuration: z.coerce.number().int().min(0).default(0),
})

type SearchParams = z.infer<typeof SearchSchema>

function rangeToDays(from: number, to: number): number {
  return Math.max(1, Math.round((to - from) / 86_400_000))
}

/**
 * The whole dashboard, on one page, as one scroll.
 *
 * It was five routes, each with its own range control and its own default, so navigating silently
 * re-scoped the data under the reader. Then it was one route with four tabs, which fixed the range
 * but bought a second problem: **three quarters of the page was always hidden**, and hiding things
 * on a monitoring dashboard needs a mechanism to say what is hidden. That mechanism existed — a dot
 * per tab, driven by the verdict layer, with a test proving every rule mapped to a pane — and it
 * was real engineering spent entirely on a self-inflicted wound. Nothing on this page needs to be
 * mutually exclusive with anything else.
 *
 * So the tabs are gone and the panes are sections, stacked, all present. What survives from the dot
 * mechanism is its better half: `lib/verdict-section.ts` still maps every rule id to a section, its
 * completeness test still reads the rule module, and a finding now renders a link to the section
 * holding its numbers instead of a coloured dot on a closed tab.
 *
 * The order is the argument. Is it working right now (banner, then the two live tiles); did any
 * rule find anything (the verdict band, now compact by default); what did the selected window look
 * like, against the window before it (the KPI row); and then, section by section, the evidence.
 *
 * Each section keeps its own exhaustive detail behind its own disclosure rather than a page-wide
 * Chart/Detail switch. The switch was a single control retitling four sections at once, so opening
 * the per-target latency charts also swapped the uptime strip for an outage table — one click, four
 * unrelated consequences.
 */
export const Route = createFileRoute('/')({
  validateSearch: (raw: Record<string, unknown>) => SearchSchema.parse(raw),
  loaderDeps: ({ search }: { search: SearchParams }) => ({
    range: search.range,
    minDuration: search.minDuration,
  }),
  loader: ({ context, deps }) => {
    const { from, to } = rangeToWindow(deps.range)
    const bucket = rangeToBucket(deps.range)
    return Promise.all([
      context.queryClient.ensureQueryData(statusQuery()),
      context.queryClient.ensureQueryData(verdictsQuery({ from, to })),
      context.queryClient.ensureQueryData(outagesQuery({ from, to, minDuration: deps.minDuration })),
      context.queryClient.ensureQueryData(speedSummaryQuery(rangeToDays(from, to))),
      ...TARGETS.map((target) =>
        context.queryClient.ensureQueryData(probeBucketsQuery({ from, to, target, bucket })),
      ),
    ])
  },
  component: DashboardPage,
})

function DashboardPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  // Via `rangeToWindow`, never a raw clock read: `from`/`to` go straight into the query keys, and
  // an unquantised now mints a new key every render and refetches forever (see `lib/range.ts`).
  // `to` doubles as "now" for every age and staleness verdict on this page.
  const { from, to } = rangeToWindow(search.range)
  const bucket = rangeToBucket(search.range)
  const days = rangeToDays(from, to)

  const { data: status } = useQuery(statusQuery())
  const { data: verdicts } = useQuery(verdictsQuery({ from, to }))
  const { data: outageData } = useQuery(outagesQuery({ from, to, minDuration: search.minDuration }))
  const { data: tests } = useQuery(speedTestsQuery({ from, to }))
  const { data: summary } = useQuery(speedSummaryQuery(days))
  const { data: router } = useQuery(routerQuery())
  const { data: events } = useQuery(eventsQuery({ from, to }))
  const { data: throughput } = useQuery(throughputQuery({ from, to, bucket }))
  const { data: heatmapData } = useQuery(
    probeBucketsQuery({
      from: to - HEATMAP_SPAN_MS,
      to,
      target: 'cloudflare',
      bucket: HEATMAP_BUCKET_SECONDS,
    }),
  )

  // The window of equal length immediately before this one, so every headline number can be read
  // against what it was. "12 minutes of downtime" is not information until it sits beside last
  // week's figure; that was the single most-asked question this page could not answer.
  //
  // Same bucket size on both sides on purpose: the worst-stretch figure is a maximum over
  // fixed-length stretches, and comparing a 5-minute worst against a 4-hour one is not a delta.
  const prevFrom = from - (to - from)
  const { data: prevOutageData } = useQuery(outagesQuery({ from: prevFrom, to: from }))
  const { data: prevTests } = useQuery(speedTestsQuery({ from: prevFrom, to: from }))

  const targetResults = useQueries({
    queries: TARGETS.map((target) => probeBucketsQuery({ from, to, target, bucket })),
  })
  const prevTargetResults = useQueries({
    queries: TARGETS.map((target) => probeBucketsQuery({ from: prevFrom, to: from, target, bucket })),
  })

  const bucketsByTarget = new Map<TargetName, readonly ProbeBucket[]>(
    TARGETS.map((target, i) => [target, targetResults[i]?.data?.buckets ?? []]),
  )
  // The vantage series belongs to the cycle, not the target — `GET /api/probes` returns the same
  // `vantage[]` whichever target is asked for — so any response carries it. Cloudflare is the WAN
  // anchor the rest of the dashboard defaults to.
  const vantageSeries = targetResults[TARGETS.indexOf('cloudflare')]?.data?.vantage ?? []

  const points = comparePointsFrom(bucketsByTarget, { from, to, bucketSeconds: bucket })
  // Folded onto the window's own axis first, so the totals count the same buckets the chart draws
  // — including the ones that reported nothing. A total summed straight from the response would
  // silently omit the unmeasured slots and then present the result as the window's volume.
  const volume = throughputTotals(
    throughputPoints(throughput?.buckets ?? [], { from, to, bucketSeconds: bucket }),
  )
  const downtime = windowDowntime(outageData?.outages ?? [], { from, to }, to)
  const unmapped = unmappedVerdictIds(verdicts ?? [])

  /**
   * The preceding window, or `null` until every part of it has arrived.
   *
   * All-or-nothing rather than per-card: a half-loaded previous window would render some badges and
   * not others, and a *missing* badge already means something specific on this row — that the two
   * windows are not comparable (see `compareWindows`). Loading must not be able to counterfeit that.
   */
  const previous: KpiWindow | null =
    prevOutageData !== undefined && prevTests !== undefined && prevTargetResults.every((r) => r.data !== undefined)
      ? {
          downtime: windowDowntime(prevOutageData.outages, { from: prevFrom, to: from }, to),
          points: comparePointsFrom(
            new Map<TargetName, readonly ProbeBucket[]>(
              TARGETS.map((target, i) => [target, prevTargetResults[i]?.data?.buckets ?? []]),
            ),
            { from: prevFrom, to: from, bucketSeconds: bucket },
          ),
          tests: prevTests,
        }
      : null

  const lastSamples = status?.lastSamples ?? []

  // `resetScroll: false` is not a nicety. Both controls on this page — the range and the outage
  // duration filter — are router navigations, and the router's default is to scroll to the top on
  // each one. Filtering the outage table halfway down the page would throw the reader back to the
  // header. The controls change what is displayed, not where you are in the page.
  const setSearch = (patch: Partial<SearchParams>) =>
    void navigate({ to: '/', search: { ...search, ...patch }, resetScroll: false })

  return (
    <Stack gap="lg">
      <Group justify="space-between" wrap="wrap">
        <Title order={3}>Home line</Title>
        <RangeSelector value={search.range} options={RANGE_OPTIONS} onChange={(range) => setSearch({ range })} />
      </Group>

      <StatusBanner ongoingOutages={status?.ongoingOutages ?? []} lastSamples={lastSamples} now={to} />

      {/* Two tiles, not four. Cloudflare, Google and Quad9 answer one question — "can this machine
          reach the internet" — and answering it three times in near-identical numbers invites the
          reader to hunt for a difference that is almost never meaningful. The router is the one
          split that is: latency to the gateway is on your side of the line, latency to an anchor is
          past it. Each anchor's own trace is still drawn in full, under Latency → per target. */}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <LiveTile kind="router" reading={liveGateway(lastSamples)} now={to} />
        <LiveTile kind="internet" reading={liveInternet(lastSamples)} now={to} />
      </SimpleGrid>

      {/* Rendered only once the query resolves — `undefined` is "not fetched yet", and passing it
          as an empty array would draw the "no verdicts" state over a window nobody has evaluated. */}
      {verdicts !== undefined && <VerdictPanel verdicts={verdicts} />}

      {/* A rule that points the reader at no section is a defect in this page, not a finding about
          the line, so it is reported here rather than inside the band. */}
      {unmapped.length > 0 && (
        <Callout kind="warn" title="A verdict fired that no section claims">
          {unmapped.join(', ')} — the conclusion is above, but nothing below is marked as holding its
          evidence. Add it to <code>VERDICT_SECTION</code> in <code>web/src/lib/verdict-section.ts</code>.
        </Callout>
      )}

      <KpiRow
        current={{ downtime, points, tests: tests ?? [] }}
        previous={previous}
        // The bucket the range route actually used, so the worst-stretch card names its own
        // duration. Without it that card silently compares a 5-minute worst against a 4-hour one
        // across ranges and reads as a bug.
        bucketSeconds={bucket}
        rangeLabel={RANGE_LABEL[search.range]}
      />

      {/* One hover provider around the whole chart region, not one per section. Every chart kind in
          `basalt-ui/charts` calls `useHoverSync`, and outside a provider each one warns and loses
          its shared cursor — which the stacked latency charts need most, since comparing them is
          the only reason they are stacked. */}
      <ChartHoverSync>
        <Stack gap="lg">
          <Section
            id="uptime"
            subtitle="When the line was reachable, and for how long it was not."
            more={
              <Stack gap="lg">
                <CoverageCallout summary={outageData?.summary ?? null} />
                {/* Fixed 30-day span whatever the page range — see `HEATMAP_SPAN_MS`. Said out
                    loud, because everything else on this page is scoped to the range control at the
                    top and a block that quietly is not would be read as though it were. */}
                <Stack gap={4}>
                  <Text size="xs" c="dimmed">
                    Always the last 30 days by UTC hour — the one block on this page the range
                    selector does not scope, because its shape is a fixed hour × day grid.
                  </Text>
                  <AvailabilityHeatmap buckets={heatmapData?.buckets ?? []} from={to - HEATMAP_SPAN_MS} to={to} />
                </Stack>
              </Stack>
            }
            moreLabel="30-day heatmap and coverage"
          >
            {/* The title names the anchor. Titled bare "WAN availability" it claimed the whole WAN
                while the chart's own accessible label said "Cloudflare availability" — one anchor,
                described two ways on one card. */}
            <GuidedChart title="Reachability · Cloudflare" copy={AVAILABILITY_COPY}>
              <AvailabilityStrip
                target="cloudflare"
                buckets={[...(bucketsByTarget.get('cloudflare') ?? [])]}
                from={from}
                to={to}
                bucketSeconds={bucket}
              />
            </GuidedChart>

            <Card withBorder radius="md" padding="lg">
              <Text size="xs" c="dimmed" tt="uppercase">
                Total downtime — last {RANGE_LABEL[search.range]}
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
                Minutes, not a percentage — on a home line the percentage flatters. Outages
                straddling the range count only their time inside it.
              </Text>
            </Card>

            <Card withBorder radius="md" padding="lg">
              <Group justify="space-between" mb="md" wrap="wrap">
                <Title order={5}>Outages</Title>
                <SegmentedControl
                  size="xs"
                  value={String(search.minDuration)}
                  onChange={(value) => setSearch({ minDuration: Number(value) })}
                  data={MIN_DURATION_OPTIONS}
                />
              </Group>
              <OutageTable outages={outageData?.outages ?? []} />
            </Card>
          </Section>

          <Section
            id="latency"
            subtitle="Whether slowness is on your side of the router or past it."
            moreLabel={`each target separately (${TARGETS.length})`}
            more={
              // The exhaustive view: every target, in full, with its band and its loss dots. Kept
              // whole rather than summarised — the compare chart answers a different question and
              // does not replace this one. The hover provider is mounted once around the whole
              // chart region above, so these already share a cursor without their own wrapper.
              <Stack gap="md">
                {TARGETS.map((name) => (
                  <GuidedChart key={name} title={TARGET_LABEL[name]} copy={LATENCY_BAND_COPY}>
                    <LatencyBandChart
                      target={name}
                      buckets={[...(bucketsByTarget.get(name) ?? [])]}
                      vantage={vantageSeries}
                      from={from}
                      to={to}
                      bucketSeconds={bucket}
                    />
                  </GuidedChart>
                ))}
              </Stack>
            }
          >
            <GuidedChart title="Router vs internet" copy={LATENCY_COMPARE_COPY}>
              <LatencyCompareChart points={points} />
            </GuidedChart>
          </Section>

          <Section
            id="speed"
            subtitle="What the line carried when it was asked to carry as much as it could."
            moreLabel="by hour of day, and latency under load"
            more={
              <Stack gap="lg">
                <SpeedHeatmap tests={tests ?? []} from={from} to={to} />
                <BufferbloatChart tests={tests ?? []} />
              </Stack>
            }
          >
            <SpeedChart tests={tests ?? []} refLines={throughputRefLines(status?.vantage, router, to)} />
            <ServerChangeNote tests={tests ?? []} />
            <SimpleGrid cols={{ base: 2, sm: 5 }} spacing="md">
              <StatCard label="Download p50" value={fmtMbps(summary?.download.p50 ?? null)} />
              <StatCard label="Download p95" value={fmtMbps(summary?.download.p95 ?? null)} />
              <StatCard label="Upload p50" value={fmtMbps(summary?.upload.p50 ?? null)} />
              <StatCard label="Upload p95" value={fmtMbps(summary?.upload.p95 ?? null)} />
              {/* The sample size the four percentiles were computed over, and the window — which is
                  whole days, not the page range, because `GET /api/speedtests/summary` only takes
                  days. Said here rather than assumed, so a 1 h range does not read as though these
                  five described an hour. */}
              <StatCard
                label={`Successful runs · ${days}d`}
                value={summary ? String(summary.count) : '—'}
              />
            </SimpleGrid>
          </Section>

          <Section
            id="throughput"
            subtitle="How much the line actually carried — a different question from how much it could."
          >
            <GuidedChart title="Data carried" copy={THROUGHPUT_COPY}>
              <ThroughputChart
                buckets={throughput?.buckets ?? []}
                from={from}
                to={to}
                bucketSeconds={bucket}
              />
            </GuidedChart>
            <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="md">
              <StatCard label={`Downloaded · ${RANGE_LABEL[search.range]}`} value={fmtBytes(volume.downBytes)} />
              <StatCard label={`Uploaded · ${RANGE_LABEL[search.range]}`} value={fmtBytes(volume.upBytes)} />
              {/* Coverage, not a fourth volume. These totals sum only the intervals the server could
                  place in time, so a window with refusals or gaps reports a floor — and a floor
                  presented as a total is the failure this whole dashboard is built around. */}
              <StatCard
                label="Buckets measured"
                value={`${volume.measuredBuckets} / ${volume.measuredBuckets + volume.unmeasuredBuckets}`}
              />
            </SimpleGrid>
            {(volume.unmeasuredBuckets > 0 || volume.skippedBuckets > 0) && (
              <Text size="xs" c="dimmed">
                These totals are a floor.{' '}
                {volume.unmeasuredBuckets > 0 &&
                  `${volume.unmeasuredBuckets} bucket${volume.unmeasuredBuckets === 1 ? '' : 's'} went unmeasured. `}
                {volume.skippedBuckets > 0 &&
                  `${volume.skippedBuckets} bucket${volume.skippedBuckets === 1 ? '' : 's'} contain traffic the server could not place in time — a reboot resets the counters, and an interface change starts new ones. `}
                Bytes moved that are not counted here; there is no way to recover where they went.
              </Text>
            )}
          </Section>

          <Section
            id="path"
            subtitle="What the measurements went out over — the interface, the link, the carrier."
            moreLabel="vantage, carrier comparison and transitions"
            more={
              <Stack gap="lg">
                <VantageCard vantage={status?.vantage ?? null} now={to} />
                <LinkComparison
                  router={router ?? null}
                  vantage={status?.vantage ?? null}
                  speedTest={status?.lastSpeedTest ?? null}
                  now={to}
                />
                <Card withBorder radius="md" padding="lg">
                  <Stack gap="md">
                    <Title order={5}>Transitions</Title>
                    {/* `linkSamplingSince` decides which empty state is true, and the two say
                        opposite things — so it is passed through even while events exist. */}
                    <TransitionTimeline
                      events={events?.events ?? []}
                      linkSamplingSince={events?.linkSamplingSince ?? null}
                    />
                  </Stack>
                </Card>
              </Stack>
            }
          >
            <GuidedChart title={`Link speed over time · ${RANGE_LABEL[search.range]}`} copy={LINK_SPEED_COPY}>
              <LinkSpeedStrip vantage={vantageSeries} from={from} to={to} bucketSeconds={bucket} />
            </GuidedChart>
          </Section>
        </Stack>
      </ChartHoverSync>
    </Stack>
  )
}

/**
 * One stacked section: a heading, a one-line statement of the question it answers, its primary
 * evidence, and its exhaustive evidence behind a named disclosure.
 *
 * The title comes from `SECTION_LABEL` and the DOM id from `sectionAnchor`, both keyed off the same
 * `SectionKey` the verdict map uses — so a finding's "see the Uptime section" link and the heading
 * it scrolls to cannot drift apart.
 *
 * `moreLabel` names what is inside rather than saying "Details". The old page-wide Chart/Detail
 * switch gave the reader no way to know what a click would produce; a toggle that says
 * "each target separately (4)" does, and it costs nothing.
 */
function Section({
  id,
  subtitle,
  children,
  more,
  moreLabel,
}: {
  id: Parameters<typeof sectionAnchor>[0]
  subtitle: string
  children: ReactNode
  more?: ReactNode
  moreLabel?: string
}) {
  const [opened, { toggle }] = useDisclosure(false)
  const Chevron = opened ? IconChevronDown : IconChevronRight

  return (
    // `scrollMarginTop` so an anchor jump does not land the heading flush against the top edge of
    // the viewport, where it reads as the top of the page rather than as a section within it.
    <Box component="section" id={sectionAnchor(id)} style={{ scrollMarginTop: 16 }}>
      <Stack gap="md">
        <Box>
          <Title order={4}>{SECTION_LABEL[id]}</Title>
          <Text size="sm" c="dimmed">
            {subtitle}
          </Text>
        </Box>
        {children}
        {more !== undefined && (
          <Stack gap="xs">
            <UnstyledButton onClick={toggle} aria-expanded={opened}>
              <Group gap={6} wrap="nowrap">
                <Chevron size={14} color={VX.faint} aria-hidden="true" />
                <Text size="xs" c="dimmed">
                  {opened ? 'Hide' : 'Show'} {moreLabel}
                </Text>
              </Group>
            </UnstyledButton>
            <Collapse expanded={opened}>{more}</Collapse>
          </Stack>
        )}
      </Stack>
    </Box>
  )
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
  // `web/src/lib/vantage.ts` applies to this exact reading.
  const linkMbit = vantage?.linkMbit
  if (vantage && !isStale(vantage.ts, now) && linkMbit !== null && linkMbit !== undefined) {
    refs.push({ value: linkMbit, label: `Host link ${linkMbit} Mbit`, color: VX.warnRef })
  }

  // `stale` is the server's verdict on its own reading (two poll intervals old), and a stale sync
  // rate drawn as a current ceiling is the router-side version of this project's central bug.
  const line = router?.line
  const downSyncKbps = line?.value?.downSyncKbps
  if (line && !line.stale && downSyncKbps !== null && downSyncKbps !== undefined) {
    const mbps = downSyncKbps / 1000
    refs.push({ value: mbps, label: `Carrier sync ${fmtMbps(mbps)}`, color: VX.goodRef })
  }

  return refs
}

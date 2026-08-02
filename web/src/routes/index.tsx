import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { Card, Group, SegmentedControl, Stack, Text } from '@mantine/core'
import { useQueries, useQuery } from '@tanstack/react-query'
import { ChartHoverSync, TooltipRow, VX } from 'basalt-ui/charts'
import { Callout } from 'basalt-ui/content'
import {
  eventsQuery,
  outagesQuery,
  probeBucketsQuery,
  routerQuery,
  speedTestsQuery,
  statusQuery,
  throughputQuery,
  verdictsQuery,
} from '../lib/queries'
import { NowStrip } from '../components/now-strip'
import { VerdictPanel } from '../components/verdict-panel'
import { KpiRow, type KpiWindow } from '../components/kpi-row'
import { PageHeader } from '../components/page-header'
import { Section } from '../components/section'
import { StatStrip, type Stat } from '../components/stat-strip'
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
import { SpeedChart, type SpeedRefLine } from '../charts/speed-chart'
import { SpeedHeatmap } from '../charts/speed-heatmap'
import { BufferbloatChart } from '../charts/bufferbloat-chart'
import { LinkSpeedStrip } from '../charts/link-speed-strip'
import { ThroughputChart } from '../charts/throughput-chart'
import { WAN_TARGETS, comparePointsFrom, foldInternetBuckets, median } from '../lib/aggregate'
import type { InternetBucket } from '../lib/aggregate'
import { throughputPoints, throughputTotals } from '../lib/throughput'
import { windowDowntime } from '../lib/downtime'
import { downtimeTint, worstBucketLoss, worstLossTint } from '../lib/kpi'
import { coverageKind, fmtCoveragePct } from '../lib/coverage'
import { speedWindowStats } from '../lib/speed-stats'
import { unmappedVerdictIds } from '../lib/verdict-section'
import { RANGE_LABEL, RANGE_OPTIONS, rangeToBucket, rangeToWindow } from '../lib/range'
import {
  TARGET_LABEL,
  TARGETS,
  type ProbeBucket,
  type RouterSnapshot,
  type TargetName,
  type Vantage,
} from '../lib/types'
import { fmtBytes, fmtMbps, fmtMinutes, fmtMs, fmtPct, fmtRelative } from '../lib/format'
import { isStale } from '../lib/freshness'
import { homeLineChip } from '../lib/vantage'
import {
  AVAILABILITY_COPY,
  INTERNET_LATENCY_COPY,
  LATENCY_BAND_COPY,
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
 * draw a single cell and the `all` range an unreadable wall. It always shows 30 days and its own
 * caption says so, rather than silently reinterpreting the range control at the top. The bucket
 * size is the chart's own constant: a mismatch would put two readings in one cell and lose one.
 */
const HEATMAP_SPAN_MS = 30 * 86_400_000
const HEATMAP_BUCKET_SECONDS = AVAILABILITY_BUCKET_SECONDS

const SearchSchema = z.object({
  range: z.enum(RANGE_OPTIONS).default('24h'),
  minDuration: z.coerce.number().int().min(0).default(0),
})

type SearchParams = z.infer<typeof SearchSchema>

/**
 * The whole dashboard, on one page, as one scroll — and now at a height a reader will actually
 * reach the bottom of.
 *
 * It was five routes, each with its own range control and its own default, so navigating silently
 * re-scoped the data. Then it was one route with four tabs, which fixed the range but hid three
 * quarters of the page. Then it was one route with five stacked sections, each with a disclosure
 * appending a second screenful below the first — honest, complete, and eight screens tall.
 *
 * Three changes make it one to two screens without removing a fact:
 *
 * 1. **The chrome is gone.** No sidebar for a router with one route (see `__root.tsx`); the theme
 *    toggle moved beside the range control, and the header states once, permanently, that the
 *    range governs the page.
 * 2. **The opening three cards are one strip.** `NowStrip` carries every branch the status banner
 *    and the two live tiles carried, in a third of the height.
 * 3. **Each section's disclosure became a view switch.** A named `SegmentedControl` per section
 *    instead of a chevron that says "Details" — same evidence, constant height, and the reader can
 *    see what is in each cut without opening it. See `components/section.tsx`.
 *
 * Two things are deliberately *unchanged* by all of it. Every conclusion the rule engine reaches
 * still renders in the verdict band, unconditionally, above every section — a finding is never
 * behind a view switch. And every figure on the page is now taken over the window the range control
 * selects, including the speed percentiles, which used to come from a whole-days server route: the
 * only exception left is the 30-day heatmap, whose shape is a fixed hour × day grid and which says
 * so on itself.
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
      context.queryClient.ensureQueryData(speedTestsQuery({ from, to })),
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

  const { data: status } = useQuery(statusQuery())
  const { data: verdicts } = useQuery(verdictsQuery({ from, to }))
  const { data: outageData } = useQuery(outagesQuery({ from, to, minDuration: search.minDuration }))
  const { data: tests } = useQuery(speedTestsQuery({ from, to }))
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
  const internetBuckets = foldInternetBuckets(bucketsByTarget)
  // Keyed by bucket start so the folded chart's tooltip can recover the two fields `ProbeBucket`
  // has no room for. A lookup rather than a cast on the row the chart hands back: a miss draws no
  // supplementary rows, where a cast would assert facts about a bucket that is not a fold.
  const internetByBucket = new Map(internetBuckets.map((b) => [b.bucket, b]))
  // Folded onto the window's own axis first, so the totals count the same buckets the chart draws
  // — including the ones that reported nothing. A total summed straight from the response would
  // silently omit the unmeasured slots and then present the result as the window's volume.
  const volume = throughputTotals(
    throughputPoints(throughput?.buckets ?? [], { from, to, bucketSeconds: bucket }),
  )
  const downtime = windowDowntime(outageData?.outages ?? [], { from, to }, to)
  const speed = speedWindowStats(tests ?? [])
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

  // `resetScroll: false` is not a nicety. Both controls that live in the URL — the range and the
  // outage duration filter — are router navigations, and the router's default is to scroll to the
  // top on each one. Filtering the outage table halfway down the page would throw the reader back
  // to the header. The controls change what is displayed, not where you are in the page.
  const setSearch = (patch: Partial<SearchParams>) =>
    void navigate({ to: '/', search: { ...search, ...patch }, resetScroll: false })

  const rangeLabel = RANGE_LABEL[search.range]

  return (
    <Stack gap="lg">
      <PageHeader
        range={search.range}
        onRangeChange={(range) => setSearch({ range })}
        version={__APP_VERSION__}
      />

      <NowStrip
        ongoingOutages={status?.ongoingOutages ?? []}
        lastSamples={status?.lastSamples ?? []}
        now={to}
      />

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
        rangeLabel={rangeLabel}
      />

      {/* One hover provider around the whole chart region, not one per section. Every chart kind in
          `basalt-ui/charts` calls `useHoverSync`, and outside a provider each one warns and loses
          its shared cursor — which the latency views need most, since comparing anchors is the only
          reason they are drawn together. */}
      <ChartHoverSync>
        <Stack gap="xl">
          <Section
            id="uptime"
            subtitle="When the line was reachable, and for how long it was not."
            meta={
              <StatStrip
                stats={[
                  {
                    label: 'Downtime',
                    value: fmtMinutes(downtime.seconds),
                    tone: downtimeTint(downtime),
                    hint:
                      downtime.openCount > 0
                        ? `${downtime.openCount} outage${downtime.openCount === 1 ? ' is' : 's are'} still open, so this is a floor — it is already out of date as you read it. Outages straddling the window count only their time inside it.`
                        : 'Minutes, not a percentage — on a home line the percentage flatters. Outages straddling the window count only their time inside it.',
                  },
                  {
                    label: 'Outages',
                    value: String(outageData?.outages.length ?? 0),
                    hint:
                      search.minDuration > 0
                        ? `Only outages of at least ${fmtMinutes(search.minDuration)}. Shorter ones are recorded and are excluded from this count by the filter in the Outages view.`
                        : 'Every recorded outage in the window, single-cycle blips included.',
                  },
                  {
                    label: 'Coverage',
                    value: fmtCoveragePct(outageData?.summary?.coveragePct ?? null),
                    // `bad` is the coverage envelope's own third state; the strip has only two
                    // tints, and its `warn` is the one a reader must not read past.
                    tone:
                      outageData?.summary === undefined || outageData.summary === null
                        ? undefined
                        : coverageKind(outageData.summary) === 'info'
                          ? undefined
                          : coverageKind(outageData.summary) === 'bad'
                            ? 'bad'
                            : 'warn',
                    hint: 'The share of the window the collector actually measured. Every figure in this section is only as true as this number — a window measured for a tenth of itself reports almost no downtime.',
                  },
                ]}
              />
            }
            views={[
              {
                key: 'timeline',
                label: 'Timeline',
                render: () => (
                  <Stack gap="md">
                    {/* The title names the anchor. Titled bare "WAN availability" it claimed the
                        whole WAN while the chart's own accessible label said "Cloudflare
                        availability" — one anchor, described two ways on one card. */}
                    <GuidedChart title="Reachability · Cloudflare" copy={AVAILABILITY_COPY}>
                      <AvailabilityStrip
                        target="cloudflare"
                        buckets={[...(bucketsByTarget.get('cloudflare') ?? [])]}
                        from={from}
                        to={to}
                        bucketSeconds={bucket}
                      />
                    </GuidedChart>
                    <CoverageCallout summary={outageData?.summary ?? null} />
                  </Stack>
                ),
              },
              {
                key: 'outages',
                label: `Outages (${outageData?.outages.length ?? 0})`,
                render: () => (
                  <Card py="xs" px="sm">
                    <Group justify="space-between" mb="md" wrap="wrap">
                      <Text size="sm" c="dimmed">
                        Every recorded outage in the window. Single-cycle blips are recorded honestly
                        and filtered here, not discarded on write.
                      </Text>
                      <SegmentedControl
                        size="xs"
                        value={String(search.minDuration)}
                        onChange={(value) => setSearch({ minDuration: Number(value) })}
                        data={MIN_DURATION_OPTIONS}
                        aria-label="Minimum outage duration"
                      />
                    </Group>
                    <OutageTable outages={outageData?.outages ?? []} />
                  </Card>
                ),
              },
              {
                key: 'pattern',
                label: '30-day pattern',
                render: () => (
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed">
                      Always the last 30 days by UTC hour — the one block on this page the range
                      selector does not scope, because its shape is a fixed hour × day grid.
                    </Text>
                    <AvailabilityHeatmap
                      buckets={heatmapData?.buckets ?? []}
                      from={to - HEATMAP_SPAN_MS}
                      to={to}
                    />
                  </Stack>
                ),
              },
            ]}
          />

          <Section
            id="latency"
            subtitle="How far the internet is, and whether slowness is on your side of the router or past it."
            meta={
              <StatStrip
                stats={[
                  { label: 'Internet', value: fmtMs(median(points.map((p) => p.wanMs)).value) },
                  { label: 'Router', value: fmtMs(median(points.map((p) => p.gatewayMs)).value) },
                  {
                    label: 'Worst loss',
                    value: fmtPct(worstBucketLoss(points)),
                    tone: worstLossTint(worstBucketLoss(points)),
                    hint: 'The worst single bucket in the window, across the gateway and all three anchors — not the window average, which a short total outage barely moves.',
                  },
                ]}
              />
            }
            views={[
              {
                key: 'internet',
                label: 'Internet & router',
                render: () => (
                  // The three anchors folded into one band, with the router's median over it.
                  // Three near-identical stacked bands made the reader compare curves by eye to
                  // answer a question none of them asks alone; the fold answers it, and the
                  // per-anchor view below still holds every anchor in full. See
                  // `foldInternetBuckets` for what each statistic folds by and why.
                  <GuidedChart title="Internet latency · median of 3 anchors" copy={INTERNET_LATENCY_COPY}>
                    <LatencyBandChart
                      label="Internet"
                      chartKey="internet"
                      buckets={internetBuckets}
                      vantage={vantageSeries}
                      from={from}
                      to={to}
                      bucketSeconds={bucket}
                      overlay={{ label: 'Router', buckets: bucketsByTarget.get('gateway') ?? [] }}
                      renderExtraTooltipRows={(b) => {
                        const fold = internetByBucket.get(b.bucket)
                        return fold === undefined ? null : <InternetFoldRows fold={fold} />
                      }}
                    />
                  </GuidedChart>
                ),
              },
              {
                key: 'per-anchor',
                label: `Per target (${TARGETS.length})`,
                render: () => (
                  // The exhaustive view: every target, in full, with its band and its loss dots.
                  // Kept whole rather than summarised — the fold above answers a different question
                  // and does not replace this one. The hover provider is mounted once around the
                  // whole chart region, so these already share a cursor without their own wrapper.
                  <Stack gap="md">
                    {TARGETS.map((name) => (
                      <GuidedChart key={name} title={TARGET_LABEL[name]} copy={LATENCY_BAND_COPY}>
                        <LatencyBandChart
                          label={TARGET_LABEL[name]}
                          chartKey={name}
                          buckets={[...(bucketsByTarget.get(name) ?? [])]}
                          vantage={vantageSeries}
                          from={from}
                          to={to}
                          bucketSeconds={bucket}
                        />
                      </GuidedChart>
                    ))}
                  </Stack>
                ),
              },
            ]}
          />

          <Section
            id="speed"
            subtitle="What the line carried when it was asked to carry as much as it could."
            meta={
              <StatStrip
                stats={[
                  ...speedStats('Download', speed.download),
                  ...speedStats('Upload', speed.upload),
                  {
                    label: 'Runs',
                    value: speed.failed > 0 ? `${speed.runs} + ${speed.failed} failed` : String(speed.runs),
                    hint: `Successful runs in the last ${rangeLabel}, which is what the percentiles are taken over. A typical taken over 3 runs and one taken over 300 are different claims.`,
                  },
                ]}
              />
            }
            views={[
              {
                key: 'runs',
                label: 'Every run',
                render: () => (
                  <Stack gap="md">
                    <SpeedChart tests={tests ?? []} refLines={throughputRefLines(status?.vantage, router, to)} />
                    <ServerChangeNote tests={tests ?? []} />
                  </Stack>
                ),
              },
              {
                key: 'by-hour',
                label: 'By hour of day',
                render: () => <SpeedHeatmap tests={tests ?? []} from={from} to={to} />,
              },
              {
                key: 'under-load',
                label: 'Latency under load',
                render: () => <BufferbloatChart tests={tests ?? []} />,
              },
            ]}
          />

          <Section
            id="throughput"
            subtitle="How much the line actually carried — a different question from how much it could."
            meta={
              <StatStrip
                stats={[
                  { label: 'Downloaded', value: fmtBytes(volume.downBytes), ...volumeCaveat(volume) },
                  { label: 'Uploaded', value: fmtBytes(volume.upBytes), ...volumeCaveat(volume) },
                  {
                    // Coverage, not a third volume. These totals sum only the intervals the server
                    // could place in time, so a window with refusals or gaps reports a floor — and a
                    // floor presented as a total is the failure this dashboard is built around.
                    label: 'Buckets measured',
                    value: `${volume.measuredBuckets} / ${volume.measuredBuckets + volume.unmeasuredBuckets}`,
                    tone: volume.unmeasuredBuckets > 0 ? 'warn' : undefined,
                    hint: 'Intervals whose bytes the server could place in time, out of the window’s buckets. Anything unmeasured is traffic that moved and was not counted.',
                  },
                ]}
              />
            }
            views={[
              {
                key: 'volume',
                label: 'Volume',
                render: () => (
                  <GuidedChart title="Data carried" copy={THROUGHPUT_COPY}>
                    <ThroughputChart
                      buckets={throughput?.buckets ?? []}
                      from={from}
                      to={to}
                      bucketSeconds={bucket}
                    />
                  </GuidedChart>
                ),
              },
            ]}
          />

          <Section
            id="path"
            subtitle="What the measurements went out over — the interface, the link, the carrier."
            meta={<StatStrip stats={pathStats(status?.vantage ?? null, to)} />}
            views={[
              {
                key: 'link',
                label: 'Link speed',
                render: () => (
                  <GuidedChart title={`Link speed over time · ${rangeLabel}`} copy={LINK_SPEED_COPY}>
                    <LinkSpeedStrip vantage={vantageSeries} from={from} to={to} bucketSeconds={bucket} />
                  </GuidedChart>
                ),
              },
              {
                key: 'vantage',
                label: 'Vantage & carrier',
                render: () => (
                  <Stack gap="md">
                    <VantageCard vantage={status?.vantage ?? null} now={to} />
                    <LinkComparison
                      router={router ?? null}
                      vantage={status?.vantage ?? null}
                      speedTest={status?.lastSpeedTest ?? null}
                      now={to}
                    />
                  </Stack>
                ),
              },
              {
                key: 'transitions',
                label: 'Transitions',
                render: () => (
                  <Card py="xs" px="sm">
                    {/* `linkSamplingSince` decides which empty state is true, and the two say
                        opposite things — so it is passed through even while events exist. */}
                    <TransitionTimeline
                      events={events?.events ?? []}
                      linkSamplingSince={events?.linkSamplingSince ?? null}
                    />
                  </Card>
                ),
              },
            ]}
          />
        </Stack>
      </ChartHoverSync>
    </Stack>
  )
}

/**
 * The two things the folded internet band cannot say for itself, said on its own tooltip.
 *
 * The band draws a `ProbeBucket`, which has no field for how many anchors it was folded from or
 * for the outlier the fold's median deliberately ignores. Both are needed to read it correctly:
 * a bucket where two anchors went missing plots as an ordinary reading, and an internet-wide 0%
 * loss beside one dead anchor is two facts rather than one. `foldInternetBuckets` carries both;
 * this is where they surface.
 *
 * The basis row is drawn always, not only when it is less than three — a reader who only sees the
 * caveat when something is wrong has to know the caveat exists to trust its absence.
 */
function InternetFoldRows({ fold }: { fold: InternetBucket }) {
  return (
    <>
      <TooltipRow
        color={VX.neutral}
        label="Folded from"
        value={`${fold.anchors} of ${WAN_TARGETS.length} anchors`}
        shape="bar"
      />
      {/* Only when it disagrees with the internet-wide figure above it. Equal values would draw
          the same number twice under two labels, which reads as a distinction that isn't there. */}
      {fold.worstAnchorLossPct > fold.lossPct && (
        <TooltipRow
          color={VX.status.warn}
          label="Worst single anchor"
          value={fmtPct(fold.worstAnchorLossPct)}
          shape="dot"
        />
      )}
    </>
  )
}

/**
 * What the newest cycle went out over, as three figures.
 *
 * **A stale vantage reports nothing rather than something old.** `GET /api/status` returns the
 * newest `probe_cycle` row forever, so a collector that died on Tuesday still answers with
 * Tuesday's interface and link speed — and a strip under a heading reading "what the measurements
 * went out over" states the present tense. The whole strip goes to `—` with one hint saying why,
 * which is the same two-cycle rule `throughputRefLines` applies before drawing its host-link
 * ceiling and the same rule `web/src/lib/vantage.ts` applies to this reading.
 *
 * `linkMaxMbit` rides on the link figure's hint rather than taking a slot of its own: on its own it
 * is meaningless, and against `linkMbit` it is the one thing that separates a cable fault from a
 * 100 Mbit adapter. Never defaulted to 1000 — that default fabricates a cable fault out of a NIC
 * that never had one.
 */
function pathStats(vantage: Vantage | null, now: number): Stat[] {
  if (vantage === null || isStale(vantage.ts, now)) {
    const hint =
      vantage === null
        ? 'No cycle has reported what it measured through.'
        : `The newest vantage is from ${fmtRelative(vantage.ts, now)} — more than two probe cycles old, so it describes some earlier moment rather than this one.`
    return [
      { label: 'Interface', value: '—', hint },
      { label: 'Link', value: '—', hint },
      { label: 'Path', value: '—', hint },
    ]
  }

  const chip = homeLineChip(vantage.onHomeLine)
  const negotiated = vantage.linkMbit === null ? '—' : `${vantage.linkMbit} Mbit`
  const ceiling = vantage.linkMaxMbit

  return [
    {
      label: 'Interface',
      value: vantage.pathIf ?? '—',
      hint: vantage.pathClass === null ? undefined : `Path class: ${vantage.pathClass}.`,
    },
    {
      label: 'Link',
      value: negotiated,
      // Only when the NIC negotiated below what it supports. Equal values are the ordinary case and
      // saying so on every load is noise; a gap is the whole reason the ceiling is stored.
      tone: ceiling !== null && vantage.linkMbit !== null && vantage.linkMbit < ceiling ? 'warn' : undefined,
      hint:
        ceiling === null
          ? 'The negotiated Ethernet rate. The NIC’s supported ceiling was not reported, so there is nothing to read this against.'
          : `The negotiated Ethernet rate, against a NIC that supports ${ceiling} Mbit. Below that ceiling means a cable or a switch port, not an adapter that never went faster.`,
    },
    { label: 'Path', value: chip.label, tone: chip.state === 'other-path' ? 'warn' : undefined, hint: chip.description },
  ]
}

/**
 * One direction's typical and near-ceiling throughput as two entries on the section's strip.
 *
 * `p50` and `p95` travel together because either alone misleads in a direction the other corrects:
 * a p50 on its own hides that the line is capable of much more when it is not contended, and a p95
 * on its own is the best few minutes of the window presented as what you get.
 */
function speedStats(direction: string, stat: { p50: number | null; p95: number | null }): Stat[] {
  return [
    {
      id: `${direction}-p50`,
      label: `${direction} p50`,
      value: fmtMbps(stat.p50),
      hint: `The typical run. Half of this window’s successful ${direction.toLowerCase()} runs were slower than this and half faster.`,
    },
    {
      // Bare `p95`, read against the `p50` beside it — but its own `id`, because the Upload pair
      // draws the identical label and two children sharing a React key means one is dropped.
      id: `${direction}-p95`,
      label: 'p95',
      value: fmtMbps(stat.p95),
      hint: `Near the ceiling: only 5% of this window’s ${direction.toLowerCase()} runs beat it. Read it as what the line can do, not as what it does.`,
    },
  ]
}

/**
 * The caveat both volume figures carry when the window has holes in it, and nothing at all when it
 * does not.
 *
 * On both figures rather than in one note below them: the totals are what a reader quotes, and a
 * qualification that lives somewhere other than the number it qualifies is a qualification that
 * travels separately from it.
 */
function volumeCaveat(volume: {
  unmeasuredBuckets: number
  skippedBuckets: number
}): { tone?: 'warn'; hint?: string } {
  if (volume.unmeasuredBuckets === 0 && volume.skippedBuckets === 0) return {}

  const reasons: string[] = []
  if (volume.unmeasuredBuckets > 0) {
    reasons.push(
      `${volume.unmeasuredBuckets} bucket${volume.unmeasuredBuckets === 1 ? '' : 's'} went unmeasured`,
    )
  }
  if (volume.skippedBuckets > 0) {
    reasons.push(
      `${volume.skippedBuckets} bucket${volume.skippedBuckets === 1 ? '' : 's'} contain traffic the server could not place in time — a reboot resets the counters, and an interface change starts new ones`,
    )
  }

  return {
    tone: 'warn',
    hint: `This is a floor, not a total: ${reasons.join('; ')}. Bytes moved that are not counted here, and there is no way to recover where they went.`,
  }
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

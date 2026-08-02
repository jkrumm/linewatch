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
  quantiseWindow,
  routerQuery,
  speedTestsQuery,
  statusQuery,
  throughputQuery,
  verdictsQuery,
} from '../lib/queries'
import { StatusBar, type KpiWindow } from '../components/status-bar'
import { useCompactMode } from '../lib/compact'
import { VerdictPanel } from '../components/verdict-panel'
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
import { downtimeTint, measuredFraction, type ThresholdTint, worstBucketLoss, worstLossTint } from '../lib/kpi'
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
import { isStale, latestSampleTs } from '../lib/freshness'
import { liveInternet } from '../lib/live'
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
 * It is a fixed-shape artifact — one cell per hour, one row per day — so a 1 h range would
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
 * 2. **The opening seven cards are one bar.** `StatusBar` carries every branch the status banner,
 *    the two live tiles and the four KPI cards carried, in one row of cells.
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
    const bucket = rangeToBucket(deps.range)
    // The same quantisation the component applies, so the loader warms the keys the component asks
    // for. At a 30 s quantum this agreed on a coin flip; at the bucket-sized one a disagreement
    // costs one refetch every few minutes instead of a fully-empty first paint on every range change.
    const { from, to } = quantiseWindow(rangeToWindow(deps.range), bucket)
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
  const [compact] = useCompactMode()
  const search = Route.useSearch()
  const navigate = useNavigate()

  /**
   * Two clocks, and conflating them is what made this page jump every thirty seconds.
   *
   * `nowTick` is the 30 s probe-cycle clock. It is what every AGE and every staleness verdict on
   * this page is measured against, because `isStale` (lib/freshness.ts) draws its line at two probe
   * cycles and a clock coarser than that would compute a negative age — presenting a dead
   * collector's last reading as current, which is the one failure this dashboard exists to notice.
   *
   * `from`/`to` are the WINDOW, floored to the server's own bucket size (capped at five minutes) by
   * `quantiseWindow`. They go verbatim into eleven query keys, and at the 30 s quantum they advanced
   * on essentially every status refetch — so the whole windowed half of the page emptied and
   * refilled over eleven staggered re-renders, under a sticky header. See `quantiseWindow`.
   *
   * The consequence to hold on to: **`to` is no longer "now"**. It is the end of the window being
   * drawn, and it can be up to five minutes behind wall-clock. Anything answering "how old is this"
   * takes `nowTick`. Anything answering "over what stretch" takes `from`/`to`.
   */
  const bucket = rangeToBucket(search.range)
  const nowTick = rangeToWindow(search.range).to
  const { from, to } = quantiseWindow(rangeToWindow(search.range), bucket)
  // The span `downtimeTint` and `StatusBar` bands its thresholds against — computed once here so the
  // KPI card's tint and the Uptime section's own downtime tint can never disagree about the window.
  const windowSeconds = (to - from) / 1000

  const { data: status } = useQuery(statusQuery())
  const { data: verdicts } = useQuery(verdictsQuery({ from, to }))
  const { data: outageData } = useQuery(outagesQuery({ from, to, minDuration: search.minDuration }))
  // Both the latency band's outage overlay AND the headline `downtime` figure below read this
  // UNFILTERED list. `search.minDuration` is a filter on the outage TABLE and the Outages COUNT
  // only — a reader who sets "≥10m" is narrowing a list, not asserting that shorter outages did
  // not happen. `downtime` used to be computed from the FILTERED `outageData` query: on a window
  // with eight 2-minute drops, setting "Ignore under 10m" zeroed the Downtime card, cleared its
  // tint, AND compared that filtered zero against `prevOutageData` below (always unfiltered) on
  // the window-over-window badge — reporting a fabricated improvement off a table filter. When
  // the filter is at its default this is the identical query key as `outageData` and costs nothing.
  const { data: allOutageData } = useQuery(outagesQuery({ from, to }))
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
  const downtime = windowDowntime(allOutageData?.outages ?? [], { from, to }, nowTick)
  const speed = speedWindowStats(tests ?? [])
  const unmapped = unmappedVerdictIds(verdicts ?? [])

  // The pieces each section needs before it can state a figure, so a rotated key renders a reserved
  // "—" rather than a computed one. `throughput?.buckets ?? []` densifies to all-null, which
  // `throughputTotals` reports as `measuredBuckets: 0` — so for a couple hundred milliseconds this
  // page asserted the window was entirely unmeasured, tinted warn, with a hint explaining why. That
  // is the exact fabrication class the rest of this repo is built to refuse; it must not be
  // reachable from a loading state either.
  const outagesPending = outageData === undefined
  // The FILTERED query's own pending state — gates the Outages count/table only. `downtime` and
  // both its tints now read the UNFILTERED `allOutageData` (see that query's own comment), so they
  // gate on this instead, not `outagesPending`.
  const allOutagesPending = allOutageData === undefined
  const throughputPending = throughput === undefined
  const heatmapPending = heatmapData === undefined
  const testsPending = tests === undefined
  const eventsPending = events === undefined
  const seriesPending = targetResults.some((r) => r.data === undefined)
  // The share of the window `points` actually measured — the same signal `downtimeTint` needs to
  // decide whether a defined zero earns `'good'` or is just an unwatched window. Computed once here
  // so the KPI card and the Uptime section's own Downtime stat can never disagree about it.
  const coverage = measuredFraction(points)
  const downtimeTone = allOutageData === undefined ? undefined : downtimeTint(downtime, windowSeconds, coverage)

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
          downtime: windowDowntime(prevOutageData.outages, { from: prevFrom, to: from }, nowTick),
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
    // `sm` between sections in compact, `lg` otherwise. With the heading rows gone the `lg` gap is
    // the only thing left separating one section's charts from the next's, and at that size it
    // reads as dead space rather than as a boundary — the card edges already do the separating.
    <Stack gap={compact ? 'sm' : 'lg'}>
      <PageHeader
        range={search.range}
        onRangeChange={(range) => setSearch({ range })}
        version={__APP_VERSION__}
        live={
          status === undefined
            ? null
            : {
                internetMs: liveInternet(status.lastSamples).medMs,
                latestTs: latestSampleTs(status.lastSamples),
                openOutages: status.ongoingOutages.length,
                now: nowTick,
              }
        }
      />

      <StatusBar
        status={status === undefined ? null : status}
        now={nowTick}
        current={{ downtime, points, tests: tests ?? [] }}
        previous={previous}
        // The bucket the range route actually used, so the worst-stretch cell names its own
        // duration. Without it that cell silently compares a 5-minute worst against a 4-hour one
        // across ranges and reads as a bug.
        bucketSeconds={bucket}
        range={search.range}
        windowSeconds={windowSeconds}
        pending={{ downtime: allOutagesPending, series: seriesPending, tests: testsPending }}
      />

      {/* Renders unconditionally now — see `VerdictPanel`'s own docblock for the third,
          "not asked yet" state. Unmounting it while `verdicts` was `undefined` dragged every
          section under it up and back down on each query-key rotation and reset every open
          `VerdictRow`/`RoutineGroups` disclosure along the way. */}
      <VerdictPanel verdicts={verdicts} />

      {/* A rule that points the reader at no section is a defect in this page, not a finding about
          the line, so it is reported here rather than inside the band. Gated on `verdicts !==
          undefined` for the same reason the band above is not: a rotated key must never flicker
          this Callout on and off. */}
      {verdicts !== undefined && unmapped.length > 0 && (
        <Callout kind="warn" title="A verdict fired that no section claims">
          {unmapped.join(', ')} — the conclusion is above, but nothing below is marked as holding its
          evidence. Add it to <code>VERDICT_SECTION</code> in <code>web/src/lib/verdict-section.ts</code>.
        </Callout>
      )}


      {/* One hover provider around the whole chart region, not one per section. Every chart kind in
          `basalt-ui/charts` calls `useHoverSync`, and outside a provider each one warns and loses
          its shared cursor — which the latency views need most, since comparing anchors is the only
          reason they are drawn together. */}
      <ChartHoverSync>
        <Stack gap="xl">
          <Section
            id="uptime"
            meta={
              <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
                <StatStrip
                  stats={[
                    {
                      label: 'Downtime',
                      // Gated on `allOutageData`, not `outageData` — this figure reads the
                      // UNFILTERED outage list (see that query's own comment above); the FILTERED
                      // query's arrival says nothing about whether this value is ready.
                      value: allOutageData === undefined ? null : fmtMinutes(downtime.seconds),
                      tone: stripTone(downtimeTone),
                      hint:
                        allOutageData === undefined
                          ? undefined
                          : downtime.openCount > 0
                            ? `${downtime.openCount} outage${downtime.openCount === 1 ? ' is' : 's are'} still open — this is a floor, already out of date. Outages straddling the window count only their time inside it.`
                            : 'Minutes, not a percentage — a home line’s percentage flatters. Outages straddling the window count only their time inside it.',
                    },
                    {
                      label: 'Outages',
                      value: outageData === undefined ? null : String(outageData.outages.length),
                      hint:
                        outageData === undefined
                          ? undefined
                          : search.minDuration > 0
                            ? `Only outages of at least ${fmtMinutes(search.minDuration)}. Shorter ones are recorded, just excluded here by the filter beside this strip.`
                            : 'Every recorded outage in the window, single-cycle blips included.',
                    },
                    {
                      label: 'Coverage',
                      value: outageData === undefined ? null : fmtCoveragePct(outageData.summary?.coveragePct ?? null),
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
                      hint: 'The share of the window the collector actually measured. Every figure here is only as true as this number — a window measured a tenth of itself reports almost no downtime.',
                    },
                  ]}
                />
                <MinDurationFilter
                  value={search.minDuration}
                  onChange={(minDuration) => setSearch({ minDuration })}
                />
              </Group>
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
                        isPending={seriesPending}
                      />
                    </GuidedChart>
                    <CoverageCallout summary={outageData === undefined ? 'pending' : (outageData.summary ?? null)} />
                  </Stack>
                ),
              },
              {
                key: 'outages',
                // Static label. The count is on the strip above; interpolated into the tab it
                // changed the control's intrinsic width on every data arrival, and Mantine animates
                // the active indicator's transform — so the switch resized and slid on its own,
                // several times a minute.
                label: 'Outages',
                render: () => (
                  <Card py="xs" px="sm">
                    <Text size="sm" c="dimmed" mb="md">
                      Every recorded outage in the window. Single-cycle blips are recorded, not
                      discarded — only filtered here.
                    </Text>
                    <OutageTable outages={outageData?.outages ?? []} isPending={outagesPending} />
                  </Card>
                ),
              },
              {
                key: 'pattern',
                label: '30-day pattern',
                render: () => (
                  // No hover provider — this used to be wrapped on the theory that `AvailabilityHeatmap`
                  // could broadcast a key the latency band's shared cursor would collide with (see the
                  // 'Every run' view under the Speed section for that actual collision). It draws
                  // `CategoryGrid` on bare `useChartTooltip`, columns are fixed `HOUR_LABELS`
                  // ('00'..'23'), never `runAxisLabels` — there is no shared key here to protect, and
                  // the wrapper was a no-op.
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed">
                      Always the last 30 days, by hour of your own day. The range selector doesn’t scope this
                      block — its shape is a fixed hour × day grid.
                    </Text>
                    <AvailabilityHeatmap
                      buckets={heatmapData?.buckets ?? []}
                      from={to - HEATMAP_SPAN_MS}
                      to={to}
                      isPending={heatmapPending}
                    />
                  </Stack>
                ),
              },
            ]}
          />

          <Section
            id="latency"
            meta={
              <StatStrip
                stats={[
                  {
                    label: 'Internet',
                    value: seriesPending ? null : fmtMs(median(points.map((p) => p.wanMs)).value),
                  },
                  {
                    label: 'Router',
                    value: seriesPending ? null : fmtMs(median(points.map((p) => p.gatewayMs)).value),
                  },
                  {
                    label: 'Worst loss',
                    value: seriesPending ? null : fmtPct(worstBucketLoss(points)),
                    tone: seriesPending ? undefined : stripTone(worstLossTint(worstBucketLoss(points))),
                    hint: seriesPending
                      ? undefined
                      : 'The worst single bucket in the window, across the gateway and all three anchors — not the average, which a short outage barely moves.',
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
                      isPending={seriesPending}
                      overlay={{ label: 'Router', buckets: bucketsByTarget.get('gateway') ?? [] }}
                      renderExtraTooltipRows={(b) => {
                        const fold = internetByBucket.get(b.bucket)
                        return fold === undefined ? null : <InternetFoldRows fold={fold} />
                      }}
                      // Scoped here, not in the chart: an Outage row with scope 'gateway' drawn
                      // across the internet band would assert something the row does not say, and
                      // the chart cannot tell which band it is drawing.
                      outages={allOutageData?.outages.filter((o) => o.scope === 'wan')}
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
                          isPending={seriesPending}
                          outages={allOutageData?.outages.filter((o) =>
                            name === 'gateway' ? o.scope === 'gateway' : o.scope === 'wan',
                          )}
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
            meta={
              <StatStrip
                stats={[
                  ...speedStats('Download', speed.download, testsPending),
                  ...speedStats('Upload', speed.upload, testsPending),
                  {
                    label: 'Runs',
                    value: testsPending
                      ? null
                      : speed.failed > 0
                        ? `${speed.runs} + ${speed.failed} failed`
                        : String(speed.runs),
                    hint: testsPending
                      ? undefined
                      : `Successful runs in the last ${rangeLabel} — what the percentiles are taken over. A typical over 3 runs and one over 300 are different claims.`,
                  },
                ]}
              />
            }
            views={[
              {
                key: 'runs',
                label: 'Every run',
                render: () => (
                  // Its own provider, and the reason is now the design rather than a key collision.
                  // This chart's x-axis is runs, not clock time (`SpeedChart`'s own subtitle says
                  // so), so a cursor shared with the time-series charts above would line up two
                  // axes that do not correspond — `BufferbloatChart`'s subtitle promises the
                  // opposite in as many words.
                  //
                  // It used to be a collision as well, and that half is gone: `runAxisLabels` emits
                  // the same `DD.MM HH:MM` string space `bucketAxisLabel` produced, so a run landing
                  // on a bucket start (14:05, 14:10) broadcast a key the latency band owned while a
                  // run at 14:07 broadcast nothing — a cursor appearing on some runs and not others,
                  // with no rule a reader could infer. The bucketed charts key on the bucket's ISO
                  // start now (basalt-ui 1.9.0's `tickFormat` freed the label from being the domain
                  // value), so the two key spaces can no longer intersect. The isolation stays
                  // because the axes still mean different things.
                  //
                  // Applies to the two chart bodies on `MultiLine`, whose label IS the domain, the
                  // hover key and the tooltip header at once — this one and `BufferbloatChart`
                  // below (`grep -rn runAxisLabels src/charts/`). The 30-day pattern view and the
                  // by-hour heatmap draw fixed `HOUR_LABELS` on bare `useChartTooltip`, so they
                  // never join a provider at all.
                  <ChartHoverSync>
                    <Stack gap="md">
                      <SpeedChart
                        tests={tests ?? []}
                        refLines={throughputRefLines(status?.vantage, router, nowTick)}
                        isPending={testsPending}
                      />
                      <ServerChangeNote tests={tests ?? []} isPending={testsPending} />
                    </Stack>
                  </ChartHoverSync>
                ),
              },
              {
                key: 'by-hour',
                label: 'By hour of day',
                render: () => (
                  <SpeedHeatmap tests={tests ?? []} from={from} to={to} isPending={testsPending} />
                ),
              },
              {
                key: 'under-load',
                label: 'Latency under load',
                render: () => (
                  // Same isolation as the 'Every run' view above — see that comment.
                  <ChartHoverSync>
                    <BufferbloatChart tests={tests ?? []} isPending={testsPending} />
                  </ChartHoverSync>
                ),
              },
            ]}
          />

          <Section
            id="throughput"
            meta={
              <StatStrip
                stats={[
                  {
                    label: 'Downloaded',
                    value: throughputPending ? null : fmtBytes(volume.downBytes),
                    ...(throughputPending ? {} : volumeCaveat(volume)),
                  },
                  {
                    label: 'Uploaded',
                    value: throughputPending ? null : fmtBytes(volume.upBytes),
                    ...(throughputPending ? {} : volumeCaveat(volume)),
                  },
                  {
                    // Coverage, not a third volume. These totals sum only the intervals the server
                    // could place in time, so a window with refusals or gaps reports a floor — and a
                    // floor presented as a total is the failure this dashboard is built around.
                    label: 'Buckets measured',
                    value: throughputPending
                      ? null
                      : `${volume.measuredBuckets} / ${volume.measuredBuckets + volume.unmeasuredBuckets}`,
                    tone: throughputPending ? undefined : volume.unmeasuredBuckets > 0 ? 'warn' : undefined,
                    hint: throughputPending
                      ? undefined
                      : 'Intervals whose bytes the server could place in time, out of the window’s buckets. Unmeasured traffic moved but wasn’t counted.',
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
                      isPending={throughputPending}
                    />
                  </GuidedChart>
                ),
              },
            ]}
          />

          {/* Dropped whole in compact — the one section whose content is reference rather than a
              reading, which is also why it is the only `collapsible` one. A verdict that points
              here leaves compact first, so the anchor still lands (see `EvidenceLink`). */}
          {compact ? null : (
          <Section
            id="path"
            meta={<StatStrip stats={pathStats(status?.vantage, nowTick)} />}
            // The one folded section on the page, and the only one whose evidence is mostly
            // reference: an interface name, a media type and a gateway that have not changed since
            // the machine was plugged in, under three view tabs. Its headline figures stay drawn
            // above the fold, and a verdict linking here opens it — see `Section`'s hash listener.
            collapsible
            defaultOpen={false}
            views={[
              {
                key: 'vantage',
                label: 'This machine',
                render: () => (
                  <Stack gap="md">
                    <VantageCard vantage={status?.vantage} now={nowTick} />
                    <LinkComparison
                      router={router}
                      vantage={status?.vantage}
                      speedTest={status?.lastSpeedTest}
                      now={nowTick}
                    />
                  </Stack>
                ),
              },
              {
                key: 'link',
                label: 'Link speed over time',
                render: () => (
                  // No range suffix — the sticky header's range control is the single statement of
                  // the window (see `PageHeader`'s tooltip). This was the last chart title that
                  // still interpolated it in, reading "Link speed over time · 24h" directly under a
                  // view tab that already says "Link speed over time".
                  <GuidedChart title="Link speed over time" copy={LINK_SPEED_COPY}>
                    <LinkSpeedStrip
                      vantage={vantageSeries}
                      from={from}
                      to={to}
                      bucketSeconds={bucket}
                      isPending={seriesPending}
                    />
                  </GuidedChart>
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
                      isPending={eventsPending}
                    />
                  </Card>
                ),
              },
            ]}
          />
          )}
        </Stack>
      </ChartHoverSync>
    </Stack>
  )
}

/**
 * Clamp a `ThresholdTint` to what `Stat.tone` (`stat-strip.tsx`) can actually carry.
 *
 * `Stat.tone` ships `'warn' | 'bad'` only — `'good'` is spent on `StatCard.tone`
 * (`status-bar.tsx`'s Downtime cell) and nowhere else; a green rail on the KPI cell is a positive
 * assertion this repo can defend (see `downtimeTint`'s docblock), and inventing a second, untested
 * place for that same judgment to render would be how the two drift apart. `worstLossTint` and
 * `downtimeTint` both return the wider `ThresholdTint` now that basalt-ui 1.8.0 added `'good'` to
 * the union — `worstLossTint` never actually returns it (loss has no measured "clean" floor to
 * assert), but the type is shared, so every `StatStrip` call site needs the same clamp regardless.
 */
function stripTone(tint: ThresholdTint): 'warn' | 'bad' | undefined {
  return tint === 'good' ? undefined : tint
}

/**
 * The outage-duration filter, out of the view body and onto the section's own header row.
 *
 * It lived inside the Outages view — behind a view switch, next to a paragraph, with an `aria-label`
 * and no visible one — so it was a URL parameter with no discoverable control. Here it is visible
 * whichever Uptime view is drawn, and it sits beside the "Outages" count it scopes, which is the
 * only place its effect is legible. It stays in the URL and still navigates with `resetScroll:
 * false`, so filtering from halfway down the page does not throw the reader back to the header.
 *
 * The label is visible text, not an `aria-label`. "Ignore under" is what makes it a control a
 * reader can find rather than a row of unexplained durations.
 */
function MinDurationFilter({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <Group gap={6} wrap="nowrap" w={{ base: '100%', sm: 'auto' }}>
      <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
        Ignore under
      </Text>
      <SegmentedControl
        size="xs"
        fullWidth
        value={String(value)}
        onChange={(next) => onChange(Number(next))}
        data={MIN_DURATION_OPTIONS}
        aria-label="Minimum outage duration"
        style={{ flex: 1 }}
      />
    </Group>
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
 *
 * **Pending is a third state, not a name for "no cycle ever reported one".** `status === undefined`
 * used to coalesce into `vantage === null` at the call site (`status?.vantage ?? null`), so this
 * strip rendered "No cycle has reported what it measured through" — a negative claim about the
 * collector — over a query nobody had answered yet. `vantage === undefined` now renders `value:
 * null` on all three entries instead: the same reserved-dash idiom every other pending figure on
 * this page uses, which drops the hint rather than asserting one (`StatValue` in `stat-strip.tsx`).
 */
function pathStats(vantage: Vantage | null | undefined, now: number): Stat[] {
  if (vantage === undefined) {
    return [
      { label: 'Interface', value: null },
      { label: 'Link', value: null },
      { label: 'Path', value: null },
    ]
  }

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
 * on its own is the best few minutes of the window presented as what you get. `group: direction` is
 * what actually keeps them together on screen: `p95`'s label is deliberately bare, read against the
 * `Download p50`/`Upload p50` beside it, and on a narrow viewport `StatStrip`'s wrapping `Group`
 * was free to put the two on different lines — a `p95` on the page belonging to nothing. Both
 * entries share one `group` value so `groupRuns` (`stat-strip.tsx`) keeps them one wrapping unit.
 *
 * `pending`, when true, reserves both entries at `null` — a rotated query key must render "—",
 * never a stale figure left over from the previous window.
 */
function speedStats(
  direction: string,
  stat: { p50: number | null; p95: number | null },
  pending: boolean,
): Stat[] {
  return [
    {
      id: `${direction}-p50`,
      group: direction,
      label: `${direction} p50`,
      value: pending ? null : fmtMbps(stat.p50),
      hint: pending
        ? undefined
        : `The typical run — half of this window’s successful ${direction.toLowerCase()} runs were slower, half faster.`,
    },
    {
      // Bare `p95`, read against the `p50` beside it — but its own `id`, because the Upload pair
      // draws the identical label and two children sharing a React key means one is dropped.
      id: `${direction}-p95`,
      group: direction,
      label: 'p95',
      value: pending ? null : fmtMbps(stat.p95),
      hint: pending
        ? undefined
        : `Near the ceiling: only 5% of this window’s ${direction.toLowerCase()} runs beat it — what the line can do, not what it does.`,
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
    hint: `This is a floor, not a total: ${reasons.join('; ')}. Bytes moved but not counted here can’t be recovered.`,
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

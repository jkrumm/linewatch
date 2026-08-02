import { Box, Card, Center, Divider, Group, SimpleGrid, Stack, Text, ThemeIcon, Tooltip, VisuallyHidden } from '@mantine/core'
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconPlugConnectedX,
  IconRouter,
  IconWorld,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { DeltaBadge } from 'basalt-ui'
import { BarSparkline, LineSparkline, ResponsiveChart, VX } from 'basalt-ui/charts'
import type { LiveReading } from '../lib/live'
import { liveGateway, liveInternet } from '../lib/live'
import type { OngoingOutage, ProbeBucketSeconds, SpeedTest, StatusSample } from '../lib/types'
import { isStale, latestSampleTs } from '../lib/freshness'
import type { LatencyComparePoint } from '../lib/aggregate'
import type { WindowDowntime } from '../lib/downtime'
import type { RangeOption } from '../lib/range'
import {
  bucketLabel,
  compareWindows,
  denseSparkline,
  downtimeTint,
  measuredFraction,
  poolTo,
  windowDownloadMedian,
  windowWanMedian,
  worstBucketLoss,
  worstLossTint,
  type Comparison,
  type ThresholdTint,
} from '../lib/kpi'
import { fmtDateTime, fmtDuration, fmtMbps, fmtMinutes, fmtMs, fmtPct, fmtRelative } from '../lib/format'

const SCOPE_LABEL: Record<OngoingOutage['scope'], string> = {
  wan: 'WAN outage',
  gateway: 'Gateway outage',
}

/** Sparkline height — width is measured per cell by `ResponsiveChart`, never a fixed constant
 * (a fixed 260px overflowed the 390px mobile viewport by 74px, clipping mid-curve). */
const SPARK_H = 44

/** Matches `StatCard`'s own rail, which this bar had to stop using — see the module docblock. */
const TONE_RAIL_WIDTH = 3

/** Verbatim from basalt-ui's `StatCard`, so the two say the same thing to a screen reader. */
const TONE_LABEL: Record<'good' | 'warn' | 'bad', string> = {
  good: 'Within the good threshold',
  warn: 'Past the warning threshold',
  bad: 'Past the severe threshold',
}

/**
 * How the preceding window is named on a comparison badge.
 *
 * "vs prev" was jargon for a chip the whole row hangs on, and "prev" is not a word. The first fix
 * spelled the period out in full — "vs last 24 hours" — which read fine alone but grew the badge to
 * ~168px, squeezing the label beside it. The second fix kept the width down with calendar nouns —
 * "yesterday", "last week" — and that one is short enough but wrong: `prevFrom = from - (to - from)`
 * (`routes/index.tsx`) makes the comparison window a ROLLING span ending exactly where the current
 * one starts, e.g. `[now-48h, now-24h)` for the 24h range, which is not "yesterday" (a calendar day)
 * and collides with what "last 24 hours" already means — the current window itself, which the range
 * control beside this bar already names.
 *
 * "X before" states the true relationship without borrowing a calendar word: the span is the same
 * length as the current window and it ends exactly where the current one begins.
 */
const RANGE_PERIOD_LABEL: Record<RangeOption, string> = {
  '1h': '1h before',
  '24h': '24h before',
  '7d': '7d before',
  '30d': '30d before',
  all: '365d before',
}

/**
 * Everything the four headline numbers are computed from, for one window.
 *
 * The same shape is passed twice — this window and the one immediately before it — so both sides of
 * every comparison are computed by the same code from the same kind of input. A delta between two
 * numbers derived differently is not a delta.
 */
export interface KpiWindow {
  downtime: WindowDowntime
  points: LatencyComparePoint[]
  tests: SpeedTest[]
}

/**
 * The page's opening bar: what the line is doing right now, and the four headline numbers over the
 * selected window, in one row of cells.
 *
 * **This is `NowStrip` and `KpiRow` folded into one surface**, and the fold is the whole point. The
 * strip carried three items (verdict, readings, age) distributed by `justify="space-between"`; on a
 * wide monitor that is ~400px of nothing between each, so the row read as three unrelated fragments
 * rather than one bar. The four KPI cards then repeated the same shape 118px lower with a different
 * card edge. One row of six cells is the same information with no dead space and no second idiom.
 *
 * **Every cell has one shape: a micro-caps `CellLabel` over its content.** The labels share a
 * baseline, which is what lets the verdict cell keep a caption-free headline and still line up with
 * the readings, the values and the sparklines however many lines the verdict happens to need — one,
 * or one plus a row per open outage.
 *
 * **The four KPI cells are hand-rolled rather than `StatCard`s, and that is a deliberate deviation
 * from this repo's own "reach for the shipped prop" rule.** `StatCard` puts its label and its
 * `menu` slot in one `wrap="nowrap"` Group; that header already squeezed at 328px of card content
 * (see git history — "DOWNLOAD · TYPICAL OF 12 RUNS" wrapped across five lines at two-up), and a
 * sixth of a 1512px bar is ~230px. The card cannot render its own header at bar density, so the
 * comparison moved onto its own line under the value. What that costs is `StatCard.tone` — the rail
 * this app used to hand-roll, deleted precisely because the hand-rolled one was colour-only. So the
 * substance of that fix is reproduced here rather than dropped: `Cell` renders the same 3px
 * `VX.status[tone]` rail AND the same `VisuallyHidden` threshold sentence, copied verbatim from
 * `StatCard` so the two never diverge in what they announce. The rule the deviation does not break
 * is the one that matters: there is still exactly ONE card idiom on this page, because this is one
 * card.
 *
 * **Two explicit layouts, not one wrapping row.** Six cells need ~1400px to sit side by side, so the
 * single-row `Group` (with the vertical hairlines that make it read as a bar) is `visibleFrom="xl"`
 * only. Below that the same six cells go into a `SimpleGrid` and the hairlines come off — a divider
 * between grid cells that wrap is a rule to nowhere. A single `wrap="wrap"` row was tried first and
 * rejected for the reason it was rejected on the strip: *which* cells share a line moves with the
 * verdict's own width (one line vs two, with vs without an open outage), so cells drift between
 * renders for a reason that has nothing to do with the data.
 *
 * **The verdict column preserves the rule that green requires evidence, not the absence of an outage
 * row.** The outage state machine only advances when a cycle is *ingested* (`src/routes/probes.ts`),
 * so a dead collector opens no outage row and `ongoingOutages` stays empty forever — reading that as
 * "up" is the container-ICMP failure mode CLAUDE.md forbids, reproduced at the UI layer. So
 * `reporting` (a non-stale newest sample) gates green, a stalled collector still gets its own yellow
 * line, and — because "the line was down when we last heard" and "we stopped hearing" are two facts,
 * not two options — a stalled collector alongside an open outage renders BOTH lines.
 *
 * **The readings preserve the per-target staleness treatment**: beyond two probe cycles (`isStale`)
 * the ping and loss go neutral and struck through, because a stale sample is history, not evidence
 * the target is up or down. A reading states its own age only when it has gone stale on its own.
 * There is no longer a bar-level "measured just now" — the sticky header states it, and stating it
 * twice on one screen was the emptiest cell in the row.
 */
export function StatusBar({
  status,
  now,
  current,
  previous,
  bucketSeconds = 300,
  range,
  windowSeconds,
  pending,
}: {
  /**
   * `null` only while `GET /api/status` has genuinely not resolved.
   *
   * `ongoingOutages={status?.ongoingOutages ?? []}` used to coalesce "not asked yet" into "asked,
   * and got nothing" — and an empty `ongoingOutages` with no samples makes `reporting` false, which
   * rendered "No data yet — collector has never reported": a verdict about a DEAD collector, drawn
   * over a query nobody had answered.
   *
   * GUARD CONSISTENTLY, on purpose. `statusQuery` IS in the route loader, so `null` should be
   * unreachable in practice — but that guarantee is a property of the route config, not of this
   * component, and a future edit can silently remove it with no signal here. The failure mode of
   * being wrong is asserting the collector is dead; the failure mode of guarding anyway is one
   * branch that never fires.
   */
  status: { ongoingOutages: OngoingOutage[]; lastSamples: StatusSample[] } | null
  /** The dashboard's floored clock (`rangeToWindow`'s `to`). */
  now: number
  current: KpiWindow
  /** The window of equal length immediately before `current`, or `null` while it is still loading. */
  previous: KpiWindow | null
  /**
   * The server-side bucket size the range route actually used (`rangeToBucket` in `lib/range.ts`),
   * so the worst-bucket cell can name its own duration instead of reading as one fixed, comparable
   * figure across every range — a 24h window's 5-min worst and a 30-day window's 4-hour worst are
   * different measurements of different-length buckets, and unlabelled that reads as a bug.
   */
  bucketSeconds?: ProbeBucketSeconds
  /** The selected range, so the comparison badges can name the period — see `RANGE_PERIOD_LABEL`. */
  range: RangeOption
  /** `(to - from) / 1000` — the span `downtimeTint` bands its threshold against. */
  windowSeconds: number
  /**
   * Per-source pending flags, not one OR'd boolean. A single `isPending` used to gate only the
   * sparklines — every cell's VALUE still rendered from `current`, which defaults to empty/zeroed
   * data while its own query is in flight, so Downtime read "0 min" over a window nobody had
   * fetched yet, one render before the verdict beside it correctly showed "—" for the same figure.
   */
  pending: {
    /** Gates the Downtime cell. Source: the UNFILTERED outage query (`allOutageData` in
     * `routes/index.tsx`) — `search.minDuration` scopes the Outages count/table only. */
    downtime: boolean
    /** Gates the Worst-bucket-loss and Ping cells, which both derive from `current.points`. */
    series: boolean
    /** Gates the Download cell, which derives from `current.tests`. */
    tests: boolean
  }
}) {
  const statusPending = status === null
  const ongoingOutages = status?.ongoingOutages ?? []
  const lastSamples = status?.lastSamples ?? []
  const latestTs = latestSampleTs(lastSamples)
  const reporting = latestTs !== null && !isStale(latestTs, now)

  const wanMedianMs = windowWanMedian(current.points)
  const worstLoss = worstBucketLoss(current.points)
  const downloadMbps = windowDownloadMedian(current.tests)

  const coverage = measuredFraction(current.points)
  const previousCoverage = previous === null ? 0 : measuredFraction(previous.points)
  const compare = (opts: {
    current: number | null
    previous: number | null
    direction: 'up-is-good' | 'up-is-bad'
    format: (magnitude: number) => string
  }) => compareWindows({ ...opts, currentCoverage: coverage, previousCoverage })

  const downtimeDelta = compare({
    current: current.downtime.seconds,
    previous: previous?.downtime.seconds ?? null,
    direction: 'up-is-bad',
    format: fmtMinutes,
  })
  const lossDelta = compare({
    current: worstLoss,
    previous: previous === null ? null : worstBucketLoss(previous.points),
    direction: 'up-is-bad',
    format: (v) => fmtPct(v),
  })
  const pingDelta = compare({
    current: wanMedianMs,
    previous: previous === null ? null : windowWanMedian(previous.points),
    direction: 'up-is-bad',
    format: (v) => fmtMs(v),
  })
  const downloadDelta = compare({
    current: downloadMbps,
    previous: previous === null ? null : windowDownloadMedian(previous.tests),
    direction: 'up-is-good',
    format: (v) => fmtMbps(v),
  })

  const lossSeries = denseSparkline(
    current.points.map((p) => (p.gatewayMs === null && p.wanAnchors === 0 ? null : p.worstLossPct)),
  )
  const rttSeries = denseSparkline(current.points.map((p) => p.wanMs))
  // Successful runs only, the same basis `windowDownloadMedian` uses — a failed run has no
  // throughput to plot and plotting it as a gap would say the opposite of what the number above it
  // was taken over.
  const downloadSeries = denseSparkline(current.tests.map((t) => t.downloadMbps).filter((v) => v !== null))

  /**
   * All-or-nothing across the three plottable cells. Each can independently lose its series to a
   * hole (see `denseSparkline` for why a holed series must be withheld rather than dropped or
   * zero-filled) — but two cells drawing a line next to one drawing dead space reads as two broken
   * cells, not two honestly-withheld ones. Downtime is not part of the gate — it never has a series
   * to withhold (`NoSeriesSlot`) — but it keys off `allSeries` to decide whether to show its
   * stand-in, which is what keeps the row even in both states.
   */
  const allSeries =
    lossSeries !== null && rttSeries !== null && downloadSeries !== null
      ? { loss: lossSeries, rtt: rttSeries, download: downloadSeries }
      : null

  const plottablePending = pending.series || pending.tests
  const period = `vs ${RANGE_PERIOD_LABEL[range]}`

  const spark = (node: (size: { width: number; height: number }) => ReactNode) => {
    if (plottablePending) return <Box mih={SPARK_H} />
    if (allSeries === null) return null
    return (
      <Box mih={SPARK_H}>
        <ResponsiveChart height={SPARK_H}>{node}</ResponsiveChart>
      </Box>
    )
  }

  /**
   * Per-cell width weights, not six equal sixths.
   *
   * The cells hold different amounts: one short verdict line, two reading clusters, and four
   * value + comparison-badge stacks whose badges are the widest thing in the bar. Download's is
   * the longest of the four ("+457.3 Mbps vs 24h before"), and at an even sixth it ellipsised to
   * "…vs 24h befo" — a comparison whose period is cut off states a delta against nothing.
   */
  const cells: { key: string; flex: number; node: ReactNode }[] = [
    {
      key: 'status',
      flex: 0.75,
      node: (
        <Cell label="Status">
          <Verdict
            ongoingOutages={ongoingOutages}
            reporting={reporting}
            latestTs={latestTs}
            now={now}
            pending={statusPending}
          />
        </Cell>
      ),
    },
    {
      key: 'latest-cycle',
      flex: 1.2,
      node: (
        // Said once for the whole bar rather than once per reading, but still said — drop it and
        // "0.0% loss" here reads as contradicting "40.0% lost" three cells to the right. They are
        // different measurements and this caption is what keeps them apart.
        <Cell label="Latest cycle">
          <Group gap="lg" wrap="nowrap" align="flex-start">
            <Reading kind="router" reading={liveGateway(lastSamples)} now={now} />
            <Reading kind="internet" reading={liveInternet(lastSamples)} now={now} />
          </Group>
        </Cell>
      ),
    },
    {
      key: 'downtime',
      flex: 1,
      node: (
        <Cell
          railGutter
          label={
            pending.downtime || current.downtime.openCount === 0
              ? 'Downtime'
              : `Downtime · ${current.downtime.openCount} still open`
          }
          tone={pending.downtime ? undefined : downtimeTint(current.downtime, windowSeconds, coverage)}
        >
          <KpiValue>{pending.downtime ? '—' : fmtMinutes(current.downtime.seconds)}</KpiValue>
          <ComparisonBadge comparison={previous === null ? null : downtimeDelta} period={period} />
          {plottablePending ? <Box mih={SPARK_H} /> : allSeries === null ? null : <NoSeriesSlot />}
        </Cell>
      ),
    },
    {
      key: 'worst',
      flex: 1,
      node: (
        // "Worst 5 minutes", not "worst 5-min bucket loss": the bucket is how the figure is
        // computed, not what it says. What it says is that there was a five-minute stretch in which
        // this share of pings never came back.
        <Cell railGutter label={`Worst ${bucketLabel(bucketSeconds)}`} tone={pending.series ? undefined : worstLossTint(worstLoss)}>
          <KpiValue>{pending.series || worstLoss === null ? '—' : `${fmtPct(worstLoss)} lost`}</KpiValue>
          <ComparisonBadge comparison={previous === null ? null : lossDelta} period={period} />
          {spark(({ width, height }) => {
            // Downsampled to the width it is actually drawn at. `BarSparkline` computes
            // `barWidth = max(step - 1, 1)`, so 288 buckets in 173px is a 1px bar on a 0.60px
            // pitch — bars overlapping by 40%, and a single 100%-loss bucket invisible inside a
            // uniform grey block. MAX for loss, because the number above it is a maximum over
            // buckets and a sparkline that averaged the spike away would contradict it.
            const cap = Math.max(8, Math.floor(width / 3))
            return (
              <BarSparkline
                data={poolTo(allSeries?.loss ?? [], cap, 'max')}
                width={width}
                height={height}
                ariaLabel="Worst packet loss per bucket"
              />
            )
          })}
        </Cell>
      ),
    },
    {
      key: 'ping',
      flex: 1,
      node: (
        <Cell railGutter label="Ping · internet">
          <KpiValue>{pending.series ? '—' : fmtMs(wanMedianMs)}</KpiValue>
          <ComparisonBadge comparison={previous === null ? null : pingDelta} period={period} />
          {spark(({ width, height }) => {
            // MEDIAN, not max: this is a typical-case reading, and a max would draw an envelope
            // rather than a trend.
            const cap = Math.max(8, Math.floor(width / 3))
            return (
              <LineSparkline
                data={poolTo(allSeries?.rtt ?? [], cap, 'median')}
                width={width}
                height={height}
                ariaLabel="Median round-trip time to the internet per bucket"
              />
            )
          })}
        </Cell>
      ),
    },
    {
      key: 'download',
      flex: 1.25,
      node: (
        <Cell railGutter label="Download">
          <KpiValue>{pending.tests ? '—' : fmtMbps(downloadMbps)}</KpiValue>
          <ComparisonBadge comparison={previous === null ? null : downloadDelta} period={period} />
          {spark(({ width, height }) => {
            const cap = Math.max(8, Math.floor(width / 3))
            return (
              <LineSparkline
                data={poolTo(allSeries?.download ?? [], cap, 'median')}
                width={width}
                height={height}
                color={VX.line}
                ariaLabel="Download throughput per run"
              />
            )
          })}
        </Cell>
      ),
    },
  ]

  return (
    <Card py="xs" px="sm">
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md" verticalSpacing="sm" hiddenFrom="xl">
        {cells.map((c) => (
          <Box key={c.key}>{c.node}</Box>
        ))}
      </SimpleGrid>

      <Group align="stretch" wrap="nowrap" gap="sm" visibleFrom="xl">
        {cells.map((c, i) => (
          <Group key={c.key} align="stretch" wrap="nowrap" gap="sm" flex={c.flex} miw={0}>
            {i > 0 && <Divider orientation="vertical" />}
            <Box flex={1} miw={0}>
              {c.node}
            </Box>
          </Group>
        ))}
      </Group>

      {!plottablePending && allSeries === null && (
        <Text size="xs" c="dimmed" mt="xs">
          Trend lines withheld — this window has an unmeasured gap. The totals are still exact over
          what was measured.
        </Text>
      )}
    </Card>
  )
}

/**
 * One segment of the bar: a micro-caps label over its content, optionally with a threshold rail.
 *
 * The rail and its `VisuallyHidden` sentence are lifted verbatim from basalt-ui's `StatCard` — see
 * the module docblock for why this bar cannot use the card itself, and why reproducing the
 * accessible half of `tone` was the non-negotiable part of that trade. `undefined` draws no mark at
 * all: absence is neither a good reading nor a bad one, and the tint functions return `undefined`
 * for a null reading precisely so this cannot happen by omission.
 */
function Cell({
  label,
  tone,
  railGutter,
  children,
}: {
  label: string
  tone?: ThresholdTint
  /** Reserve the rail's gutter whether or not this render has a tone. The four KPI cells all set
   * it, because `tone` is data-dependent: pad only when tinted and a cell's label steps 7px left
   * the moment its threshold clears, which reads as a layout bug rather than as a verdict. */
  railGutter?: boolean
  children: ReactNode
}) {
  return (
    <Stack gap={4} miw={0} pos="relative" pl={railGutter ? 'sm' : undefined} h="100%">
      {tone !== undefined && (
        <>
          <VisuallyHidden>{TONE_LABEL[tone]}</VisuallyHidden>
          <Box
            aria-hidden="true"
            style={{
              position: 'absolute',
              insetBlock: 0,
              insetInlineStart: 0,
              width: TONE_RAIL_WIDTH,
              background: VX.status[tone],
            }}
          />
        </>
      )}
      <Text fz={VX.text.micro} c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.06em' }}>
        {label}
      </Text>
      {children}
    </Stack>
  )
}

/** The bar's headline figures — the largest type in it. Everything around them is a caption, a
 * comparison or a trend shape. */
function KpiValue({ children }: { children: ReactNode }) {
  return (
    <Text fz="xl" fw={600} ff="monospace" style={{ whiteSpace: 'nowrap' }}>
      {children}
    </Text>
  )
}

/**
 * The window-over-window badge, or nothing at all.
 *
 * `withGlyph={false}` is the load-bearing prop. `DeltaBadge` derives both its colour and its ▲/▼
 * from the sign of `value`, and `Comparison.tone` is signed by *goodness* rather than by arithmetic
 * — so on downtime, loss and ping the glyph would point down while the label beside it reads
 * `+8 min`. The colour is the judgment and the label is the measurement; an arrow that means neither
 * one unambiguously is worse than no arrow.
 */
function ComparisonBadge({ comparison, period }: { comparison: Comparison | null; period: string }) {
  if (comparison === null) return <Box mih={22} />
  return <DeltaBadge value={comparison.tone} format={() => comparison.label} withGlyph={false} period={period} />
}

/**
 * Downtime's honest stand-in for a sparkline it structurally cannot draw.
 *
 * Three ways to keep the row uniform were on the table. (a) give Downtime a real series: rejected —
 * no per-bucket downtime array exists in any range response this component receives, and standing
 * in with down-cycles or loss would be plotting a different measurement under the downtime label,
 * exactly the fabrication this repo's honesty rule forbids. (b) never draw a sparkline on any cell:
 * rejected — it throws away a working trend visual in the common healthy case. (c, chosen) let the
 * three plottable cells draw when they can, and give Downtime an explicit, same-height empty slot.
 */
function NoSeriesSlot() {
  return (
    <Center h={SPARK_H}>
      <Text size="xs" c="dimmed" ta="center">
        No per-bucket series
      </Text>
    </Center>
  )
}

/** One verdict line per fact that's true — never a single line picked among several true facts. */
function Verdict({
  ongoingOutages,
  reporting,
  latestTs,
  now,
  pending,
}: {
  ongoingOutages: OngoingOutage[]
  reporting: boolean
  latestTs: number | null
  now: number
  /** True while `status` is `null` — see that prop's docblock for why this must short-circuit
   * before `reporting`, not be folded into it. */
  pending: boolean
}) {
  // A dash, same as `PageHeader`'s `LiveChip` renders for the identical unresolved query — not
  // `NotReportingLine`, which is a claim about a collector that has answered and gone quiet.
  if (pending) {
    return (
      <Text size="sm" c="dimmed" ff="monospace">
        —
      </Text>
    )
  }

  if (reporting && ongoingOutages.length === 0) {
    return (
      <Group gap="sm" wrap="nowrap">
        <ThemeIcon size={28} radius="md" color="green" variant="light">
          <IconCircleCheck size={16} />
        </ThemeIcon>
        <Text fw={600} size="sm">
          All systems up
        </Text>
      </Group>
    )
  }

  return (
    <Stack gap={4}>
      {!reporting && <NotReportingLine latestTs={latestTs} now={now} />}
      {ongoingOutages.map((outage) => (
        <OutageLine key={outage.id} outage={outage} now={now} />
      ))}
    </Stack>
  )
}

/** Neither green nor red: nothing is known about the line, which is its own state — yellow because
 * a stalled collector is evidence the question is currently unanswerable, not evidence of an
 * outage. The visible line already states the conclusion; the tooltip only adds the timestamp and
 * the reason outage detection can't fill the gap on its own. `touch: true` because Mantine's
 * default is touch-off — a phone has no hover, and the reason is otherwise unreachable there. */
function NotReportingLine({ latestTs, now }: { latestTs: number | null; now: number }) {
  const short =
    latestTs === null
      ? 'No data yet — collector has never reported'
      : `No data for ${fmtMinutes((now - latestTs) / 1000)} — collector not reporting`
  const detail =
    latestTs === null
      ? 'Nothing has been measured, which is not the same as nothing being wrong.'
      : `Last sample ${fmtDateTime(latestTs)}. Outages are only detected when a cycle arrives, so the line's state is unknown — not up.`

  return (
    <Tooltip label={detail} multiline w={280} events={{ hover: true, focus: true, touch: true }}>
      <Group gap="sm" wrap="nowrap" tabIndex={0} style={{ width: 'fit-content' }}>
        <ThemeIcon size={28} radius="md" color="yellow" variant="light">
          <IconPlugConnectedX size={16} />
        </ThemeIcon>
        {/* `VX.status.warn`, not `c="yellow.7"`: a pinned shade index is one fixed swatch in both
            colour schemes, so a step legible on the dark page is the one that fails contrast on the
            light one. The status token is emitted per scheme. */}
        <Text fw={600} size="sm" c={VX.status.warn}>
          {short}
        </Text>
      </Group>
    </Tooltip>
  )
}

/** One row per concurrent outage — a gateway outage and a WAN outage can be open at once, so this
 * is called once per `ongoingOutages` entry rather than assuming at most one. */
function OutageLine({ outage, now }: { outage: OngoingOutage; now: number }) {
  const short = `${SCOPE_LABEL[outage.scope]} · ${fmtDuration((now - outage.startedAt) / 1000)} so far`

  return (
    <Tooltip label={`Started ${fmtDateTime(outage.startedAt)}`} events={{ hover: true, focus: true, touch: true }}>
      <Group gap="sm" wrap="nowrap" tabIndex={0} style={{ width: 'fit-content' }}>
        <ThemeIcon size={28} radius="md" color="red" variant="light">
          <IconAlertTriangle size={16} />
        </ThemeIcon>
        <Text fw={600} size="sm" c="red">
          {short}
        </Text>
      </Group>
    </Tooltip>
  )
}

/** One live reading, router or internet, at bar density. */
function Reading({ kind, reading, now }: { kind: 'router' | 'internet'; reading: LiveReading; now: number }) {
  const stale = reading.ts !== null && isStale(reading.ts, now)
  const nothing = reading.ts === null
  const down = !stale && !nothing && reading.upCount === 0
  const partial = !stale && !nothing && reading.upCount > 0 && reading.upCount < reading.total
  const degraded = !stale && !nothing && !down && (partial || (reading.worstLossPct ?? 0) > 0)
  const tone = stale || nothing ? 'gray' : down ? 'red' : degraded ? 'yellow' : 'green'

  const Icon = kind === 'router' ? IconRouter : IconWorld
  const title = kind === 'router' ? 'Router' : 'Internet'

  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <ThemeIcon size={24} radius="md" color={tone} variant="light">
        <Icon size={14} />
      </ThemeIcon>
      <Stack gap={0}>
        <Text fw={600} size="xs">
          {title}
        </Text>
        {/* Loss UNDER the reading, not beside it, and `nowrap` on each figure rather than only on
            a Group. Two readings share one bar cell, and side by side they overflowed it on the
            ranges where the KPI cells are widest — the `miw={0}` that lets a cell shrink lets its
            content spill over the hairline rather than clip. Stacked, each reading is as wide as
            its widest single figure, and the extra line is free: the bar's height is set by the
            KPI cells' label + value + badge, which is already three rows. `wrap="nowrap"` on a
            Group would not have helped either way — it stops CHILDREN being placed on a new line,
            not a child's own text from breaking, which is how "0.8 ms" once split from its unit. */}
        <Text
          fw={600}
          fz="lg"
          ff="monospace"
          c={stale ? 'dimmed' : undefined}
          td={stale ? 'line-through' : undefined}
          style={{ whiteSpace: 'nowrap' }}
        >
          {fmtMs(reading.medMs)}
        </Text>
        <Text
          size="xs"
          ff="monospace"
          c={stale ? 'dimmed' : degraded || down ? 'red' : 'dimmed'}
          td={stale ? 'line-through' : undefined}
          style={{ whiteSpace: 'nowrap' }}
        >
          {fmtPct(reading.worstLossPct)} loss
        </Text>
        {/* A partial answer is its own state and gets its own mark — folding "1 of 3 answering"
            into the loss figure would put an internet outage and a single dead anchor on the same
            scale. */}
        {partial && (
          <Text fz={VX.text.micro} c="yellow">
            {reading.upCount} of {reading.total} answering
          </Text>
        )}
        {/* This reading's own age appears only when it has gone stale on its own — the common case
            where both readings share a probe cycle is covered by the header's own freshness chip. */}
        {(stale || nothing) && (
          <Text size="xs" c="dimmed" fw={600}>
            {reading.ts === null ? 'no data' : `Last seen ${fmtRelative(reading.ts, now)}`}
          </Text>
        )}
      </Stack>
    </Group>
  )
}

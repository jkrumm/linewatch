import { Box, Center, SimpleGrid, Text } from '@mantine/core'
import { DeltaBadge, StatCard } from 'basalt-ui'
import { BarSparkline, LineSparkline, ResponsiveChart, VX } from 'basalt-ui/charts'
import type { LatencyComparePoint } from '../lib/aggregate'
import type { WindowDowntime } from '../lib/downtime'
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
} from '../lib/kpi'
import { fmtMbps, fmtMinutes, fmtMs, fmtPct } from '../lib/format'
import type { ProbeBucketSeconds, SpeedTest } from '../lib/types'
import type { RangeOption } from '../lib/range'

/** Sparkline height — width is measured per card by `ResponsiveChart`, never a fixed constant
 * (a fixed 260px overflowed the 390px mobile viewport by 74px, clipping mid-curve). */
const SPARK_H = 44

/**
 * Everything the four headline numbers are computed from, for one window.
 *
 * The same shape is passed twice — this window and the one immediately before it — so both sides
 * of every comparison are computed by the same code from the same kind of input. A delta between
 * two numbers derived differently is not a delta.
 */
export interface KpiWindow {
  downtime: WindowDowntime
  points: LatencyComparePoint[]
  tests: SpeedTest[]
}

/**
 * How the preceding window is named on a comparison badge.
 *
 * "vs prev" was jargon for a chip the whole row hangs on, and "prev" is not a word. The first fix
 * spelled the period out in full — "vs last 24 hours" — which read fine alone but, at 768px
 * (`cols=2`, ~328px of card content), grew the badge to ~168px inside a `Group
 * justify="space-between" wrap="nowrap"` header row: Mantine's `Badge` label is nowrap + ellipsis,
 * so the badge itself never truncated, but it squeezed the wrapping card label ("DOWNLOAD · TYPICAL
 * OF 12 RUNS") down to a sliver and that one wrapped across five lines instead. The second fix kept
 * the width down with calendar nouns — "yesterday", "last week" — and that one is short enough but
 * wrong: `prevFrom = from - (to - from)` (`routes/index.tsx`) makes the comparison window a ROLLING
 * span ending exactly where the current one starts, e.g. `[now-48h, now-24h)` for the 24h range,
 * which is not "yesterday" (a calendar day) and collides with what "last 24 hours" already means —
 * the current window itself, which the range control beside this badge already names.
 *
 * "X before" states the true relationship without borrowing a calendar word: the span is the same
 * length as the current window and it ends exactly where the current one begins, which is what
 * "before" says and "yesterday"/"last week" do not. It is also short — shorter than the spelled-out
 * form that broke the header row above — so both constraints (a rolling window's actual shape, and
 * the badge's width) are met by the same three-or-so characters this map already had room for.
 */
const RANGE_PERIOD_LABEL: Record<RangeOption, string> = {
  '1h': '1h before',
  '24h': '24h before',
  '7d': '7d before',
  '30d': '30d before',
  all: '365d before',
}

/**
 * The four numbers the dashboard opens with, each against the preceding window of the same length.
 *
 * Chosen so each is exactly computable from what the range routes return, which ruled out the
 * obvious "packet loss over the window" — see `worstBucketLoss` for why that one cannot be
 * combined across buckets without an assumption this layer has no way to check.
 *
 * **Every label is written for someone who did not build the bucketing.** The previous set was not:
 * "Worst 5-min bucket loss" names an implementation detail of the SQL aggregation, and "WAN median
 * RTT" is three pieces of jargon for "ping". The numbers are identical; only the words changed, and
 * the units the reader actually needs — which window, and how it compares — moved out of a docblock
 * and onto the screen. The window itself is no longer restated in a caption above the row: the range
 * control lives in the sticky header now, visible from anywhere on the page, and the comparison
 * period moved onto each badge (`RANGE_PERIOD_LABEL`) — "vs 24h before" beats a sentence above the
 * row that the reader has to carry down to it.
 *
 * Every card is an aggregate over the *measured* part of the window. That caveat is not repeated
 * on four cards; it is stated once, in words, by the coverage verdict in the band above, which is
 * the only place that can say how much of the window was measured. The **comparisons** carry it
 * differently: they are withheld outright below `COMPARABLE_COVERAGE`, because a delta against an
 * unmeasured window is not a smaller truth, it is a wrong one.
 *
 * **Two cards carry a `tone`, and only two.** Downtime (`downtimeTint`) and worst-bucket loss
 * (`worstLossTint`) have thresholds this codebase can defend; Ping and Download do not, so they
 * stay neutral. `undefined` — nothing wrong, or nothing measured — draws no mark at all: absence is
 * neither a good reading nor a bad one, and the tint functions return `undefined` for a null
 * reading precisely so this cannot happen by omission. Downtime's threshold bands rather than fires
 * on any accrued second — see `downtimeTint`.
 *
 * **Only Downtime can go green, and only behind a coverage gate.** basalt-ui 1.8.0 added `'good'`
 * to `StatCardTone`, and a green rail is a POSITIVE ASSERTION — "this was measured and it earned a
 * clean verdict" — not the absence of a complaint. `worstLossTint` therefore still never returns it
 * (a null worst-loss already means "nothing measured", so there is nothing to assert), and
 * `downtimeTint` returns it only when `coverage` clears `COMPARABLE_COVERAGE`: a window nobody
 * watched yields the same `{ seconds: 0, openCount: 0 }` a genuinely clean one does, and painting
 * that green would be this project's founding failure mode wearing a badge. Both tone props also
 * pass `undefined` outright while their own source is `pending`, so a card cannot go green off
 * zeroed placeholder data one render before its query lands.
 *
 * That rail used to be a hand-rolled `ThresholdRail` here — a `Box` absolutely positioning a 3px
 * bar over the card's leading edge, written because `StatCard.value` is typed `string` and the
 * number itself could not be recoloured from outside. It was a second card idiom in this app,
 * drawn by this app's code, and it was colour-only: nothing about the threshold reached a screen
 * reader. `StatCard.tone` draws the same rail from inside the card and adds a `VisuallyHidden`
 * label naming the threshold. The wrapper is gone.
 */
export function KpiRow({
  current,
  previous,
  bucketSeconds = 300,
  range,
  windowSeconds,
  pending,
}: {
  current: KpiWindow
  /** The window of equal length immediately before `current`, or `null` while it is still loading. */
  previous: KpiWindow | null
  /**
   * The server-side bucket size the range route actually used (`rangeToBucket` in `lib/range.ts`),
   * so the worst-bucket card can name its own duration instead of reading as one fixed, comparable
   * figure across every range — a 24h window's 5-min worst and a 30-day window's 4-hour worst are
   * different measurements of different-length buckets, and unlabelled that reads as a bug.
   * Defaults to `rangeToBucket('24h')` (300s), the page's default range.
   */
  bucketSeconds?: ProbeBucketSeconds
  /** The selected range, so the comparison badges can name the period they're measured against —
   * see `RANGE_PERIOD_LABEL`. Replaces a bare `rangeLabel: string`: the period vocabulary now lives
   * with the row that renders it, not with the caller. */
  range: RangeOption
  /** `(to - from) / 1000` — the span `downtimeTint` bands its threshold against. */
  windowSeconds: number
  /**
   * Per-source pending flags, not one OR'd boolean. A single `isPending` used to gate only the
   * sparklines and the "Trend lines withheld" caption — every card's VALUE still rendered from
   * `current`, which defaults to empty/zeroed data while its own query is in flight, so Downtime
   * read "0 min" and Download's label read "typical of 0 runs" over a window nobody had fetched
   * yet — one render before the strip beside it correctly showed "—" for the same figure. Each
   * card's value/label/tone now withholds on its own source (`downtime`, `series`, `tests`); the
   * sparkline area still reserves and releases together (`plottablePending` below), unchanged — a
   * resolved Loss card drawing its curve next to a Download card still drawing dead space reads as
   * one broken card, not two honestly-withheld ones.
   */
  pending: {
    /** Gates the Downtime card. Source: the UNFILTERED outage query (`allOutageData` in
     * `routes/index.tsx`) — `search.minDuration` scopes the Outages count/table only, never this
     * figure. */
    downtime: boolean
    /** Gates the Worst-bucket-loss and Ping cards, which both derive from `current.points`. */
    series: boolean
    /** Gates the Download card, which derives from `current.tests`. */
    tests: boolean
  }
}) {
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

  const lossSeries = denseSparkline(current.points.map((p) => (p.gatewayMs === null && p.wanAnchors === 0 ? null : p.worstLossPct)))
  const rttSeries = denseSparkline(current.points.map((p) => p.wanMs))
  // Successful runs only, the same basis `windowDownloadMedian` uses — a failed run has no
  // throughput to plot and plotting it as a gap would say the opposite of what the number above it
  // was taken over.
  const downloadSeries = denseSparkline(current.tests.map((t) => t.downloadMbps).filter((v) => v !== null))

  /**
   * All-or-nothing across the three plottable cards. Each can independently lose its series to a
   * hole (see `denseSparkline`'s docblock for why a holed series must be withheld rather than
   * dropped or zero-filled) — but two cards drawing a line next to one that draws dead space reads
   * as two broken cards, not two honestly-withheld ones. So these three draw a sparkline together
   * or not at all, decided once, up front.
   *
   * Downtime is not part of this gate — it never has a series to withhold in the first place (see
   * `NoSeriesSlot`'s docblock below) — but it does key off `allSeries` to decide whether to show its
   * own stand-in, which is what keeps all four cards the same height in both states.
   */
  const allSeries =
    lossSeries !== null && rttSeries !== null && downloadSeries !== null
      ? { loss: lossSeries, rtt: rttSeries, download: downloadSeries }
      : null

  // The sparkline area still gates as one unit across all four cards, unlike the values below —
  // see `pending`'s own docblock for why that split is deliberate, not an oversight.
  const plottablePending = pending.series || pending.tests

  const period = `vs ${RANGE_PERIOD_LABEL[range]}`

  return (
    <>
      {/* One column below `sm`. At two-up on a 390px viewport each card holds ~147px of content
          against a 24px mono hero — about ten characters — and "100.0% lost" is eleven, so
          `StatCard`'s `overflow: hidden` cut the one reading the Worst-bucket card exists to report.
          The label suffers the same squeeze: "DOWNLOAD · TYPICAL OF 12 RUNS" shares a nowrap `Group`
          with the badge and wrapped to five lines at two-up. */}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        {/* Downtime never draws a real sparkline — see `NoSeriesSlot` — but still needs a slot of
            the same height whenever its neighbours draw theirs, or the row goes uneven exactly when
            it looks most finished. */}
        <StatCard
          tone={pending.downtime ? undefined : downtimeTint(current.downtime, windowSeconds, coverage)}
          label={
            pending.downtime
              ? 'Downtime'
              : current.downtime.openCount > 0
                ? `Downtime · ${current.downtime.openCount} still open`
                : 'Downtime'
          }
          value={pending.downtime ? '—' : fmtMinutes(current.downtime.seconds)}
          menu={previous === null ? <Box mih={22} /> : <ComparisonBadge comparison={downtimeDelta} period={period} />}
          sparkline={plottablePending ? <Box mih={SPARK_H} /> : allSeries === null ? undefined : <NoSeriesSlot />}
        />
        <StatCard
          tone={pending.series ? undefined : worstLossTint(worstLoss)}
          // "Worst 5 minutes", not "worst 5-min bucket loss": the bucket is how the figure is
          // computed, not what it says. What it says is that there was a five-minute stretch in
          // which this share of pings never came back — so the share is the value and the stretch
          // is the label, and neither needs the word "bucket" to land.
          label={`Worst ${bucketLabel(bucketSeconds)}`}
          value={pending.series ? '—' : worstLoss === null ? '—' : `${fmtPct(worstLoss)} lost`}
          menu={previous === null ? <Box mih={22} /> : <ComparisonBadge comparison={lossDelta} period={period} />}
          sparkline={
            plottablePending ? (
              <Box mih={SPARK_H} />
            ) : allSeries === null ? undefined : (
              <Box mih={SPARK_H}>
                <ResponsiveChart height={SPARK_H}>
                  {({ width, height }) => {
                    // Downsampled to the width it is actually drawn at. `BarSparkline` computes
                    // `barWidth = max(step - 1, 1)`, so 288 buckets in 173px is a 1px bar on a
                    // 0.60px pitch — bars overlapping by 40%, and a single 100%-loss bucket
                    // invisible inside a uniform grey block. MAX for loss, because the number above
                    // this card is a maximum over buckets and a sparkline that averaged the spike
                    // away would contradict it.
                    const cap = Math.max(8, Math.floor(width / 3))
                    return (
                      <BarSparkline
                        data={poolTo(allSeries.loss, cap, 'max')}
                        width={width}
                        height={height}
                        ariaLabel="Worst packet loss per bucket"
                      />
                    )
                  }}
                </ResponsiveChart>
              </Box>
            )
          }
        />
        <StatCard
          label="Ping · internet"
          value={pending.series ? '—' : fmtMs(wanMedianMs)}
          menu={previous === null ? <Box mih={22} /> : <ComparisonBadge comparison={pingDelta} period={period} />}
          sparkline={
            plottablePending ? (
              <Box mih={SPARK_H} />
            ) : allSeries === null ? undefined : (
              <Box mih={SPARK_H}>
                <ResponsiveChart height={SPARK_H}>
                  {({ width, height }) => {
                    // MEDIAN, not max: this is a typical-case reading, and a max would draw an
                    // envelope rather than a trend.
                    const cap = Math.max(8, Math.floor(width / 3))
                    return (
                      <LineSparkline
                        data={poolTo(allSeries.rtt, cap, 'median')}
                        width={width}
                        height={height}
                        ariaLabel="Median round-trip time to the internet per bucket"
                      />
                    )
                  }}
                </ResponsiveChart>
              </Box>
            )
          }
        />
        <StatCard
          // The run count rides on the label: a typical taken over 3 runs and one taken over 300
          // are different claims, and this is the only card whose sample size the reader cannot
          // infer from the range. Withheld while pending — "typical of 0 runs" once genuinely read
          // as a real answer over a window whose speed tests hadn't arrived yet.
          label={pending.tests ? 'Download' : `Download · typical of ${current.tests.length} run${current.tests.length === 1 ? '' : 's'}`}
          value={pending.tests ? '—' : fmtMbps(downloadMbps)}
          menu={previous === null ? <Box mih={22} /> : <ComparisonBadge comparison={downloadDelta} period={period} />}
          sparkline={
            plottablePending ? (
              <Box mih={SPARK_H} />
            ) : allSeries === null ? undefined : (
              <Box mih={SPARK_H}>
                <ResponsiveChart height={SPARK_H}>
                  {({ width, height }) => {
                    const cap = Math.max(8, Math.floor(width / 3))
                    return (
                      <LineSparkline
                        data={poolTo(allSeries.download, cap, 'median')}
                        width={width}
                        height={height}
                        color={VX.line}
                        ariaLabel="Download throughput per run"
                      />
                    )
                  }}
                </ResponsiveChart>
              </Box>
            )
          }
        />
      </SimpleGrid>
      {!plottablePending && allSeries === null && (
        <Text size="xs" c="dimmed" mt={4}>
          Trend lines withheld — this window has an unmeasured gap, so the shapes above would misstate it. The totals are
          still exact over what was measured.
        </Text>
      )}
    </>
  )
}

/**
 * The window-over-window badge, or nothing at all.
 *
 * `withGlyph={false}` is the load-bearing prop. `DeltaBadge` derives both its colour and its ▲/▼
 * from the sign of `value`, and `Comparison.tone` is signed by *goodness* rather than by
 * arithmetic — so on downtime, loss and ping the glyph would point down while the label beside it
 * reads `+8 min`. The colour is the judgment and the label is the measurement; an arrow that means
 * neither one unambiguously is worse than no arrow.
 *
 * It rides `StatCard`'s `menu` slot (the card's consumer-owned header-right corner) because the
 * card's own `delta` prop takes a bare number and renders the glyph this deliberately suppresses.
 */
function ComparisonBadge({ comparison, period }: { comparison: Comparison | null; period: string }) {
  if (comparison === null) return null
  return <DeltaBadge value={comparison.tone} format={() => comparison.label} withGlyph={false} period={period} />
}

/**
 * Downtime's honest stand-in for a sparkline it structurally cannot draw.
 *
 * Three ways to keep the row uniform were on the table. (a) give Downtime a real series: rejected —
 * no per-bucket downtime array exists in any range response this component receives, and standing
 * in with down-cycles or loss would be plotting a different measurement under the downtime label,
 * exactly the fabrication this repo's honesty rule forbids. (b) never draw a sparkline on any card,
 * including the three that have real ones: rejected — it throws away a working trend visual in the
 * common healthy case to avoid a five-word caption. (c, chosen) let the three plottable cards draw
 * when they can, and give Downtime an explicit, same-height empty slot instead of no slot at all.
 *
 * This is why `allSeries` (not a standalone check) gates it: the empty slot should appear exactly
 * when the *other* three are about to draw theirs, which is the only state where a bare Downtime
 * card would otherwise look broken rather than expected. When `allSeries` is null every card is
 * plain (no sparkline prop passed at all) and the row is already uniform at the base 118px height,
 * so no slot is needed then. While `plottablePending`, all four cards render the same reserved
 * `Box` instead — this component draws only in the settled, holed case.
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

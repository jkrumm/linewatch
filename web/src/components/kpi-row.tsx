import { Center, SimpleGrid, Text } from '@mantine/core'
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
  windowDownloadMedian,
  windowWanMedian,
  worstBucketLoss,
  worstLossTint,
  type Comparison,
} from '../lib/kpi'
import { fmtMbps, fmtMinutes, fmtMs, fmtPct } from '../lib/format'
import type { ProbeBucketSeconds, SpeedTest } from '../lib/types'

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
 * and onto the screen.
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
 * reading precisely so this cannot happen by omission.
 *
 * That rail used to be a hand-rolled `ThresholdRail` here — a `Box` absolutely positioning a 3px
 * bar over the card's leading edge, written because `StatCard.value` is typed `string` and the
 * number itself could not be recoloured from outside. It was a second card idiom in this app,
 * drawn by this app's code, and it was colour-only: nothing about the threshold reached a screen
 * reader. basalt-ui 1.7.0 ships `StatCard.tone`, which draws the same rail from inside the card and
 * adds a `VisuallyHidden` label naming the threshold. The wrapper is gone.
 */
export function KpiRow({
  current,
  previous,
  bucketSeconds = 300,
  rangeLabel,
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
  /** How the selected range is written on the range control, so the caption names the same thing. */
  rangeLabel: string
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

  return (
    <>
      {/* The window, and what the badges are measured against, said once for the row rather than
          four times on four labels. "Downtime: 12 min" is not a fact until you know over what. */}
      <Text size="xs" c="dimmed" mb="xs">
        Last {rangeLabel}, each figure against the {rangeLabel} before it
      </Text>
      <SimpleGrid cols={{ base: 2, lg: 4 }} spacing="md">
        {/* Downtime never draws a real sparkline — see `NoSeriesSlot` — but still needs a slot of
            the same height whenever its neighbours draw theirs, or the row goes uneven exactly when
            it looks most finished. */}
        <StatCard
          tone={downtimeTint(current.downtime)}
          label={current.downtime.openCount > 0 ? `Downtime · ${current.downtime.openCount} still open` : 'Downtime'}
          value={fmtMinutes(current.downtime.seconds)}
          menu={<ComparisonBadge comparison={downtimeDelta} />}
          sparkline={allSeries === null ? undefined : <NoSeriesSlot />}
        />
        <StatCard
          tone={worstLossTint(worstLoss)}
          // "Worst 5 minutes", not "worst 5-min bucket loss": the bucket is how the figure is
          // computed, not what it says. What it says is that there was a five-minute stretch in
          // which this share of pings never came back — so the share is the value and the stretch
          // is the label, and neither needs the word "bucket" to land.
          label={`Worst ${bucketLabel(bucketSeconds)}`}
          value={worstLoss === null ? '—' : `${fmtPct(worstLoss)} lost`}
          menu={<ComparisonBadge comparison={lossDelta} />}
          sparkline={
            allSeries === null ? undefined : (
              <ResponsiveChart height={SPARK_H}>
                {({ width, height }) => (
                  <BarSparkline data={allSeries.loss} width={width} height={height} ariaLabel="Worst packet loss per bucket" />
                )}
              </ResponsiveChart>
            )
          }
        />
        <StatCard
          label="Ping · internet"
          value={fmtMs(wanMedianMs)}
          menu={<ComparisonBadge comparison={pingDelta} />}
          sparkline={
            allSeries === null ? undefined : (
              <ResponsiveChart height={SPARK_H}>
                {({ width, height }) => (
                  <LineSparkline data={allSeries.rtt} width={width} height={height} ariaLabel="Median round-trip time to the internet per bucket" />
                )}
              </ResponsiveChart>
            )
          }
        />
        <StatCard
          // The run count rides on the label: a typical taken over 3 runs and one taken over 300
          // are different claims, and this is the only card whose sample size the reader cannot
          // infer from the range.
          label={`Download · typical of ${current.tests.length} run${current.tests.length === 1 ? '' : 's'}`}
          value={fmtMbps(downloadMbps)}
          menu={<ComparisonBadge comparison={downloadDelta} />}
          sparkline={
            allSeries === null ? undefined : (
              <ResponsiveChart height={SPARK_H}>
                {({ width, height }) => (
                  <LineSparkline data={allSeries.download} width={width} height={height} color={VX.line} ariaLabel="Download throughput per run" />
                )}
              </ResponsiveChart>
            )
          }
        />
      </SimpleGrid>
      {allSeries === null && (
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
function ComparisonBadge({ comparison }: { comparison: Comparison | null }) {
  if (comparison === null) return null
  return <DeltaBadge value={comparison.tone} format={() => comparison.label} withGlyph={false} period="vs prev" />
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
 * so no slot is needed then.
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

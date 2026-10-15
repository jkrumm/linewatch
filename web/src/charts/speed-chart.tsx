import { ChartCard, Lines } from 'basalt-ui/charts'
import { VX } from 'basalt-ui/tokens'
import { useMemo } from 'react'
import { useInViewport } from './use-in-viewport'
import { slotExtent } from '../lib/densify'
import type { ProbeBucketSeconds, SpeedTest } from '../lib/types'
import { fmtMbps } from '../lib/format'
import { runTickFormat } from '../lib/axis'
import { runHeader, runX, toRuns, type Run } from '../lib/speed-runs'
import { dashboard } from '../lib/dashboard-store'

/**
 * 220, not 190: two traces plus two horizontal references need room to sit apart, and at 190 the
 * download line and the carrier-sync reference nearly touch on this line. It is the FRAME height —
 * the legend sits outside it.
 */
const SPEED_HEIGHT = 220

/**
 * Compact draws this one chart shorter, and only this one: two near-flat traces plus two
 * references, where the reading is *where they sit* against the references, not the wiggle. The
 * latency band and the throughput bars are the opposite — spikes and gaps are the whole content.
 */
const SPEED_HEIGHT_COMPACT = 160

/**
 * A horizontal reference at a rate the line is measured against — the host's negotiated link speed,
 * the carrier's sync rate.
 *
 * `label` is supplied by the caller and must be derived from the live reading it marks. This
 * component authors no sentence about what a reference means, because any such sentence names a
 * link speed that stops being true the moment the NIC renegotiates — which on this host
 * demonstrably happens. A caller with a null or stale input passes no ref line at all rather than
 * a stale one.
 */
export type SpeedRefLine = {
  value: number
  label: string
  color: string
}

/** Accent blue against `VX.line2`, the MID grey — one pair for these two concepts wherever they are
 * drawn, here and in the throughput bars. Not `VX.line`, the brightest grey available, which makes
 * the secondary series louder than the accent. */
const SERIES = [
  {
    key: 'download',
    label: 'Download',
    color: VX.accent,
    getValue: (r: Run) => r.test.downloadMbps,
    formatValue: fmtMbps,
  },
  {
    key: 'upload',
    label: 'Upload',
    color: VX.line2,
    getValue: (r: Run) => r.test.uploadMbps,
    formatValue: fmtMbps,
  },
]

/**
 * Every speed-test run in the window, download against upload.
 *
 * **Titled for its own section, which is the rule now: a chart's title is its section's word.**
 * "Speed" here, "Throughput" a screen down, "Ping" and "Connection health" above. That is not
 * redundancy with the heading — in compact the heading is gone and this title is the only label the
 * card has, so it has to carry the section's meaning on its own.
 *
 * The hazard the old title ("Speed test runs") was avoiding is still avoided, and it is worth
 * restating because the fix looks superficially like the bug: this chart was once called
 * "Throughput", the name of a DIFFERENT section measuring a different thing — what the line
 * actually carried, from the interface counters, rather than what it managed when asked to
 * saturate. One word for two measurements a screen apart is the confusion the Speed/Throughput
 * split exists to prevent. Each chart now takes its OWN section's word, so no word is used twice.
 */
export function SpeedChart({
  tests,
  from,
  to,
  bucketSeconds,
  refLines = [],
  isPending,
}: {
  tests: SpeedTest[]
  /** The window and bucket size the bucketed charts above draw: the x domain is theirs, so one
   * instant is one pixel column under the shared cursor. */
  from: number
  to: number
  bucketSeconds: ProbeBucketSeconds
  refLines?: SpeedRefLine[]
  /**
   * True while the speed-tests query is in flight. `tests ?? []` drew an axis with no points on it,
   * which on a run series is the claim "no speed test ran in this window", not "nobody has asked
   * yet". Handed to `state`, which also conceals the legend (reference labels included) while
   * pending: a dashed "Host link 1000 Mbit" caption would name a ceiling for measurements that are
   * not on screen.
   */
  isPending?: boolean
}) {
  const points = useMemo(() => toRuns(tests), [tests])
  const xDomain = useMemo(() => slotExtent({ from, to, bucketSeconds }), [from, to, bucketSeconds])
  const [compact] = dashboard.field.compact.use()
  const { ref: viewRef, inView } = useInViewport<HTMLDivElement>()
  const pending = isPending === true
  // The reference labels ride on the lines themselves (`RefLine.legend`, 2.x), so the swatch, the
  // dash and the label are one record and cannot drift. `label` is the caller's, derived from the
  // live reading it marks.
  const refs = useMemo(
    () =>
      refLines.map((ref) => ({
        value: ref.value,
        color: ref.color,
        dashed: true,
        legend: { label: ref.label },
      })),
    [refLines],
  )
  const tooltip = useMemo(
    () => ({
      onFollow: inView,
      formatHeader: runHeader,
    }),
    [inView],
  )

  return (
    <ChartCard
      // Titled in compact only, where there is no section heading to name the block — see
      // `GuidedChart` for the whole rule.
      title={compact ? 'Speed' : undefined}
      // The unit lives here, not on the y ticks: it is said once for a card whose two series share it.
      subtitle="Mbps"
      info="Ookla runs, one point each, placed at the moment the run happened. Download and upload share one axis."
    >
      {/* See `availability-strip.tsx`'s identical wrapper for why this is a floor, not a height. */}
      <div ref={viewRef} style={{ minHeight: compact ? SPEED_HEIGHT_COMPACT : SPEED_HEIGHT }}>
        <Lines
          data={points}
          x={runX}
          xDomain={xDomain}
          series={SERIES}
          refLines={refs}
          formatX={runTickFormat}
          y={{ domain: 'auto' }}
          height={compact ? SPEED_HEIGHT_COMPACT : SPEED_HEIGHT}
          state={{ pending }}
          ariaLabel="Download against upload in Mbps, one point per speed-test run"
          tooltip={tooltip}
        />
      </div>
    </ChartCard>
  )
}

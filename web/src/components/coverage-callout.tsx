import { Stack, Text } from '@mantine/core'
import { Callout } from 'basalt-ui/content'
import type { HomeLineVerdict, RangeSummary } from '../lib/types'
import { coverageKind, coverageSinceFirst, fmtCoveragePct } from '../lib/coverage'
import { fmtDateTime } from '../lib/format'

/**
 * What each vantage verdict claims, phrased so the four never read alike. Only `all` claims the
 * whole range; `unknown` and `mixed` say what is *not* known rather than borrowing `all`'s
 * confidence, because an unreported vantage is not evidence that anything went out over the home
 * line (docs/DESIGN.md, `probe_cycle`).
 */
function homeLineSentence(summary: RangeSummary): string {
  const verdict: HomeLineVerdict = summary.onHomeLine
  const { recordedCycles, homeLineCycles, offHomeLineCycles, unknownHomeLineCycles } = summary

  // Nothing recorded is its own sentence: `homeLineVerdict` reports `unknown` for an empty range,
  // and "no cycle reported a vantage" would read as a collector that was running and silent.
  if (recordedCycles === 0) return 'Nothing was recorded in this range, so there is no vantage to report.'
  if (verdict === 'all') return `All ${recordedCycles} recorded cycles measured the home line.`
  if (verdict === 'none') {
    return `None of the ${recordedCycles} recorded cycles measured the home line — this range describes some other path.`
  }
  if (verdict === 'unknown') {
    return `No cycle reported what it measured through, so whether this range describes the home line is unknown — ${unknownHomeLineCycles} of ${recordedCycles} cycles carry no vantage.`
  }
  return `Only ${homeLineCycles} of ${recordedCycles} recorded cycles are known to have measured the home line (${offHomeLineCycles} measured something else, ${unknownHomeLineCycles} did not report).`
}

/**
 * The honesty envelope that has to sit under any downtime headline (`RangeSummary` in
 * `lib/types.ts`, `src/db/range-summary.ts` server-side). "24 h: 2 min downtime" over a window that
 * is 34% measured, holds degraded cycles, and mixes 475 cycles of unknown vantage is three lies of
 * omission in one 32 px number; this is where the three are stated.
 *
 * Renders **nothing** when `summary` is null. Null means the server had no window to compute
 * coverage over — not full coverage, and not zero coverage either, so there is nothing honest to
 * draw. A zero would be the loudest of the three lies.
 */
export function CoverageCallout({ summary }: { summary: RangeSummary | null }) {
  if (summary === null) return null

  const since = coverageSinceFirst(summary)
  // "unknown" is a word, not a number, so it gets its own headline rather than being dropped into
  // a sentence built for a percentage.
  const title =
    summary.coveragePct === null
      ? 'Coverage — unknown'
      : `Coverage — ${fmtCoveragePct(summary.coveragePct)} of this range measured`

  return (
    <Callout kind={coverageKind(summary)} title={title}>
      <Stack gap={4}>
        <Text size="sm">
          {summary.recordedCycles} of {summary.expectedCycles} expected probe cycles were recorded.
          {summary.coveragePct === null
            ? ' The share is unknown: this range is shorter than one probe cycle, so there is no share of it to report.'
            : ' The rest of the range was not measured, which is not the same as up.'}
        </Text>
        {since !== null && (
          <Text size="sm">
            Measured from {fmtDateTime(since.firstTs)} — the record starts inside this range, and
            since then {fmtCoveragePct(since.coveragePct)} of {since.expectedCycles} expected cycles
            were recorded. Nothing was owed before that.
          </Text>
        )}
        <Text size="sm">
          {summary.degradedCycles === 0
            ? `No cycle lost ${summary.degradedLossPct}% or more on every WAN anchor at once.`
            : `${summary.degradedCycles} cycles lost at least ${summary.degradedLossPct}% on every WAN anchor without any of them going silent — degradation no outage row can hold, because the outage machine only fires when nothing comes back.`}
        </Text>
        <Text size="sm">{homeLineSentence(summary)}</Text>
      </Stack>
    </Callout>
  )
}

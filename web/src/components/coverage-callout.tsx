import { Box, Collapse, Group, Stack, Text, UnstyledButton } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import { Callout } from 'basalt-ui/content'
import { VX } from 'basalt-ui/charts'
import type { HomeLineVerdict, RangeSummary } from '../lib/types'
import { coverageKind, coverageSinceFirst, fmtCoveragePct } from '../lib/coverage'
import { fmtDateTime } from '../lib/format'
import { useCompactMode } from '../lib/compact'

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
 * The degradation sentence, shared between the full `Callout` and the `info`-tier disclosure — the
 * fact is the same at every severity, only its size on the page changes.
 */
function degradedSentence(summary: RangeSummary): string {
  return summary.degradedCycles === 0
    ? `No cycle lost ${summary.degradedLossPct}% or more on every WAN anchor at once.`
    : `${summary.degradedCycles} cycles lost at least ${summary.degradedLossPct}% on every WAN anchor without any of them going silent — degradation no outage row can hold, because the outage machine only fires when nothing comes back.`
}

/**
 * The "record starts inside this range" restatement, shared for the same reason as
 * `degradedSentence` above. Null when `coverageSinceFirst` has nothing to restate.
 */
function sinceSentence(summary: RangeSummary): string | null {
  const since = coverageSinceFirst(summary)
  if (since === null) return null
  return `Measured from ${fmtDateTime(since.firstTs)} — the record starts inside this range, and since then ${fmtCoveragePct(since.coveragePct)} of ${since.expectedCycles} expected cycles were recorded. Nothing was owed before that.`
}

/**
 * The `info` case — `coverageKind` only reaches it when `coveragePct` is a real number at or above
 * `GOOD_COVERAGE_PCT` (see that function's docblock; `null` is routed to `warn`), which is the
 * ordinary case: nothing is wrong, and it was drawing a four-sentence, ~130px `Callout` on every
 * load to say so.
 *
 * Collapsed to one dim line carrying the headline figure and the count it rests on — chevron and
 * text together are the whole toggle, same idiom as `VerdictRow` in `verdict-panel.tsx`: a compact
 * row that expands in place rather than a separate disclosure control. The three sentences the full
 * `Callout` shows (the "measured from" restatement, the degradation count, the vantage sentence) are
 * still computed and still exist — nothing here is deleted, only deferred behind a click, on the
 * same argument `VerdictPanel` makes about its `info`/`ok` tier: a band nobody reads at 99.8% is a
 * band that cannot deliver its one important message when coverage actually drops.
 */
function CompactCoverage({ summary }: { summary: RangeSummary }) {
  const [opened, { toggle }] = useDisclosure(false)
  const Chevron = opened ? IconChevronDown : IconChevronRight

  const details = [sinceSentence(summary), degradedSentence(summary), homeLineSentence(summary)].filter(
    (sentence): sentence is string => sentence !== null,
  )

  return (
    <Box>
      <UnstyledButton onClick={toggle} aria-expanded={opened} w="100%">
        <Group gap={6} wrap="nowrap">
          <Chevron size={14} color={VX.faint} aria-hidden="true" />
          <Text size="xs" c="dimmed">
            Coverage {fmtCoveragePct(summary.coveragePct)} — {summary.recordedCycles} of{' '}
            {summary.expectedCycles} expected cycles recorded
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse expanded={opened}>
        <Stack gap={4} pl="lg" pt={4}>
          {details.map((sentence) => (
            <Text key={sentence} size="xs" c="dimmed">
              {sentence}
            </Text>
          ))}
        </Stack>
      </Collapse>
    </Box>
  )
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
 *
 * Size tracks severity: `info` (the ordinary, nothing-wrong case) collapses to `CompactCoverage`
 * above; `warn`/`bad` — where the numbers below this describe a minority of the window, or coverage
 * could not be expressed at all — keep the full `Callout`, every sentence visible, unconditionally.
 *
 * Three states, not two. `null` is the server having had no window to compute coverage over and
 * renders nothing, unchanged. `'pending'` is nobody having asked yet — and it must not collapse to
 * `null`, because this component unmounting and remounting on a query-key rotation is what made an
 * expanded coverage explanation snap shut on its own every time the window advanced.
 */
export function CoverageCallout({ summary }: { summary: RangeSummary | null | 'pending' }) {
  const [compact] = useCompactMode()
  if (summary === null) return null
  if (summary === 'pending') {
    return (
      <Box>
        <Text size="xs" c="dimmed">
          Coverage — measuring…
        </Text>
      </Box>
    )
  }

  const kind = coverageKind(summary)
  // The info row states that nothing is wrong ("Coverage 100.0% — 2880 of 2880 expected cycles
  // recorded"). It is the one coverage branch compact mode drops; `warn` and `bad` below are
  // findings and are drawn in every mode. See `lib/compact.tsx` for the whole split.
  if (kind === 'info') return compact ? null : <CompactCoverage summary={summary} />

  const since = sinceSentence(summary)
  // "unknown" is a word, not a number, so it gets its own headline rather than being dropped into
  // a sentence built for a percentage.
  const title =
    summary.coveragePct === null
      ? 'Coverage — unknown'
      : `Coverage — ${fmtCoveragePct(summary.coveragePct)} of this range measured`

  return (
    <Callout kind={kind} title={title}>
      <Stack gap={4}>
        <Text size="sm">
          {summary.recordedCycles} of {summary.expectedCycles} expected probe cycles were recorded.
          {summary.coveragePct === null
            ? ' The share is unknown: this range is shorter than one probe cycle, so there is no share of it to report.'
            : ' The rest of the range was not measured, which is not the same as up.'}
        </Text>
        {since !== null && <Text size="sm">{since}</Text>}
        <Text size="sm">{degradedSentence(summary)}</Text>
        <Text size="sm">{homeLineSentence(summary)}</Text>
      </Stack>
    </Callout>
  )
}

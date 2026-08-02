import { Card, Group, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core'
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconPlugConnectedX,
  IconRouter,
  IconWorld,
} from '@tabler/icons-react'
import type { LiveReading } from '../lib/live'
import { liveGateway, liveInternet } from '../lib/live'
import type { OngoingOutage, StatusSample } from '../lib/types'
import { isStale, latestSampleTs } from '../lib/freshness'
import { VX } from 'basalt-ui/charts'
import { fmtDateTime, fmtDuration, fmtMinutes, fmtMs, fmtPct, fmtRelative } from '../lib/format'

const SCOPE_LABEL: Record<OngoingOutage['scope'], string> = {
  wan: 'WAN outage',
  gateway: 'Gateway outage',
}

/**
 * `status-banner.tsx` and two copies of `live-tile.tsx`, folded into one 72–96 px row — same
 * question ("is the line working right now"), a third of the vertical cost, and every fact either
 * component carried is still here, just not in its own card.
 *
 * **The verdict column preserves status-banner's rule that green requires evidence, not the
 * absence of an outage row.** The outage state machine only advances when a cycle is *ingested*
 * (`src/routes/probes.ts`), so a dead collector opens no outage row and `ongoingOutages` stays
 * empty forever — reading that as "up" is the container-ICMP failure mode CLAUDE.md forbids,
 * reproduced at the UI layer. So `reporting` (a non-stale newest sample) gates green exactly as it
 * gated the old banner, a stalled collector still gets its own yellow line, and — because "the line
 * was down when we last heard" and "we stopped hearing" are two facts, not two options — a stalled
 * collector alongside an open outage renders BOTH lines rather than picking one. Each line states
 * its conclusion in the text that's always visible; the `Tooltip` only adds the timestamp/reasoning
 * that used to be a subtitle, never the only copy of the fact.
 *
 * **The reading columns preserve live-tile's staleness treatment**, per target: beyond two probe
 * cycles (`isStale`) the ping and loss go neutral and struck through, because a stale sample is
 * history, not evidence the target is up or down. What changes is *where* the age is said. The old
 * tiles each printed their own age underneath, which was fine at full width but is the exact
 * repetition this fold removes — both readings usually share one probe cycle, so two ages next to
 * each other say the same thing twice. The strip instead says the age once, on the right, for the
 * newest sample overall. A reading's own age comes back — "promoted", per the fold's brief, larger
 * and no longer a footnote — only when that reading has gone stale on its own and the shared age no
 * longer describes it; that divergence is a fact the strip-level age cannot carry and would
 * otherwise be lost. The `N of M answering` partial state stays its own explicit mark rather than
 * folding into the loss figure, for the same reason live-tile kept it separate: one dead anchor out
 * of three and an internet-wide outage must not read as the same number.
 *
 * "Latest cycle" is said once for the whole strip rather than once per reading, but it is still
 * said — drop it and "Loss 0.0%" here reads as contradicting the KPI row's "Worst 5 minutes: 100.0%
 * lost" a few rows down. They are different measurements and only that caption keeps them apart.
 */
export function NowStrip({
  ongoingOutages,
  lastSamples,
  now,
}: {
  ongoingOutages: OngoingOutage[]
  lastSamples: StatusSample[]
  /** The dashboard's floored clock (`rangeToWindow`'s `to`). */
  now: number
}) {
  const latestTs = latestSampleTs(lastSamples)
  const reporting = latestTs !== null && !isStale(latestTs, now)
  const gateway = liveGateway(lastSamples)
  const internet = liveInternet(lastSamples)

  return (
    <Card py="xs" px="sm">
      <Group justify="space-between" align="center" wrap="wrap" gap="md">
        <Verdict ongoingOutages={ongoingOutages} reporting={reporting} latestTs={latestTs} now={now} />

        <Stack gap={2}>
          <Text fz={VX.text.micro} c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.06em' }}>
            Latest cycle
          </Text>
          <Group gap="xl" wrap="wrap">
            <Reading kind="router" reading={gateway} now={now} />
            <Reading kind="internet" reading={internet} now={now} />
          </Group>
        </Stack>

        <Text size="sm" c="dimmed" ta="right">
          {latestTs === null ? 'no data' : fmtRelative(latestTs, now)}
        </Text>
      </Group>
    </Card>
  )
}

/** One verdict line per fact that's true — never a single line picked among several true facts. */
function Verdict({
  ongoingOutages,
  reporting,
  latestTs,
  now,
}: {
  ongoingOutages: OngoingOutage[]
  reporting: boolean
  latestTs: number | null
  now: number
}) {
  if (reporting && ongoingOutages.length === 0) {
    return (
      <Group gap="sm" wrap="nowrap">
        <ThemeIcon size={32} radius="md" color="green" variant="light">
          <IconCircleCheck size={18} />
        </ThemeIcon>
        <Stack gap={0}>
          <Text fw={600} size="sm">
            All systems up
          </Text>
          <Text size="xs" c="dimmed">
            WAN and gateway both reachable
          </Text>
        </Stack>
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
 * the reason outage detection can't fill the gap on its own. */
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
    <Tooltip label={detail} multiline w={280}>
      <Group gap="sm" wrap="nowrap">
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
  const short = `${SCOPE_LABEL[outage.scope]} in progress · ${fmtDuration((now - outage.startedAt) / 1000)} so far`

  return (
    <Tooltip label={`Started ${fmtDateTime(outage.startedAt)}`}>
      <Group gap="sm" wrap="nowrap">
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

/** One live reading, router or internet, at strip density. Same tone/staleness rules as
 * `live-tile.tsx`; the difference is what's said about age — see the module docblock. */
function Reading({ kind, reading, now }: { kind: 'router' | 'internet'; reading: LiveReading; now: number }) {
  const stale = reading.ts !== null && isStale(reading.ts, now)
  const nothing = reading.ts === null
  const down = !stale && !nothing && reading.upCount === 0
  const partial = !stale && !nothing && reading.upCount > 0 && reading.upCount < reading.total
  const degraded = !stale && !nothing && !down && (partial || (reading.worstLossPct ?? 0) > 0)
  const tone = stale || nothing ? 'gray' : down ? 'red' : degraded ? 'yellow' : 'green'

  const Icon = kind === 'router' ? IconRouter : IconWorld
  const title = kind === 'router' ? 'Router' : 'Internet'
  // What the ping is *of* — "median of 3" is the difference between a reading and an aggregate.
  const basis =
    reading.total === 0 ? '—' : reading.total === 1 ? (reading.samples[0]?.addr ?? '—') : `median of ${reading.total}`

  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <ThemeIcon size={24} radius="md" color={tone} variant="light">
        <Icon size={14} />
      </ThemeIcon>
      <Stack gap={0}>
        <Group gap={6} wrap="nowrap">
          <Text fw={600} size="xs">
            {title}
          </Text>
          <Text fz={VX.text.micro} c="dimmed" ff="monospace">
            {basis}
          </Text>
        </Group>
        <Group gap="sm" wrap="nowrap" align="baseline">
          <Text
            fw={600}
            size="sm"
            ff="monospace"
            c={stale ? 'dimmed' : undefined}
            td={stale ? 'line-through' : undefined}
          >
            {fmtMs(reading.medMs)}
          </Text>
          <Text
            size="xs"
            ff="monospace"
            c={stale ? 'dimmed' : degraded || down ? 'red' : 'dimmed'}
            td={stale ? 'line-through' : undefined}
          >
            {fmtPct(reading.worstLossPct)} loss
          </Text>
        </Group>
        {/* A partial answer is its own state and gets its own mark — folding "1 of 3 answering"
            into the loss figure would put an internet outage and a single dead anchor on the same
            scale, which is exactly the over-claim live-tile's fold was written to avoid. */}
        {partial && (
          <Text fz={VX.text.micro} c="yellow">
            {reading.upCount} of {reading.total} answering
          </Text>
        )}
        {/* The strip's one shared age (top-right) covers the common case where both readings share
            a probe cycle. This reading's own age comes back, promoted, only when it has gone stale
            on its own — a fact the shared age cannot carry. */}
        {(stale || nothing) && (
          <Text fz={stale ? undefined : VX.text.micro} size={stale ? 'xs' : undefined} c="dimmed" fw={stale ? 600 : undefined}>
            {nothing ? 'no data' : `Last seen ${fmtRelative(reading.ts as number, now)} — not current`}
          </Text>
        )}
      </Stack>
    </Group>
  )
}

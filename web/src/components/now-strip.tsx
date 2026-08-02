import { Card, Divider, Group, SimpleGrid, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core'
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconPlugConnectedX,
  IconRouter,
  IconWorld,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
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
 * each other say the same thing twice. The strip instead says the age once, as a labelled unit
 * (`MeasuredAge`), for the newest sample overall. A reading's own age comes back — "promoted", per
 * the fold's brief, larger and no longer a footnote — only when that reading has gone stale on its
 * own and the shared age no longer describes it; that divergence is a fact the strip-level age
 * cannot carry and would otherwise be lost. The `N of M answering` partial state stays its own
 * explicit mark rather than folding into the loss figure, for the same reason live-tile kept it
 * separate: one dead anchor out of three and an internet-wide outage must not read as the same
 * number.
 *
 * "Latest cycle" is said once for the whole strip rather than once per reading, but it is still
 * said — drop it and "Loss 0.0%" here reads as contradicting the KPI row's "Worst 5 minutes: 100.0%
 * lost" a few rows down. They are different measurements and only that caption keeps them apart.
 *
 * **Three labelled cells, left-packed, hairline-separated — not three items spread by
 * `space-between`.** The spread version distributed the same three children across whatever width
 * the card had, which on a 1500px monitor put ~400px of nothing between each: the readings floated
 * unanchored near the middle and the age sat alone against the right edge, so the row read as three
 * unrelated fragments rather than one strip. Distribution is not composition — nothing said which
 * fragment belonged to which, and the gaps moved with the viewport. Every cell now has the same
 * internal shape (a micro-caps `CellLabel` over its content), the cells sit adjacent behind vertical
 * `Divider`s, and the whole cluster hugs the left. The right-hand emptiness is then plainly margin
 * rather than three pieces of debris that happen to be far apart.
 *
 * `CellLabel` is also what lets the verdict column keep its caption-free headline *and* line up: the
 * three labels share one baseline, so "All systems up", the two readings and the age all start at
 * the same y regardless of how many lines the verdict happens to need.
 *
 * **The latency figures are the largest type in the strip** (`fz="lg"` mono against `sm`/`xs`
 * elsewhere). They are the only live measurements here; at uniform `sm` they carried the same weight
 * as their own captions and the timestamp, so the eye had nowhere to land first.
 *
 * **Two explicit layouts, not one wrapping row.** At 338px (this card's width on a 360px viewport)
 * the three cells measure ~600px, so a single `wrap="wrap"` row broke onto two or three flex lines,
 * and *which* items shared a line moved with the verdict's own width (one line vs two, with vs
 * without an outage), so the age drifted between renders. The narrow path stacks the same three
 * cells with horizontal rules instead — same segmentation, same labels, rotated.
 */
export function NowStrip({
  status,
  now,
}: {
  /**
   * `null` only while `GET /api/status` has genuinely not resolved — the same guard
   * `PageHeader`'s `live` prop enforces on the identical query, extended here to close the gap
   * that let it slip past.
   *
   * `ongoingOutages={status?.ongoingOutages ?? []}` used to coalesce "not asked yet" into "asked,
   * and got nothing" — and an empty `ongoingOutages` with no samples makes `reporting` false, which
   * used to render `NotReportingLine`'s "No data yet — collector has never reported": a verdict
   * about a DEAD collector, drawn over a query nobody had answered. Five lines up in the same
   * render, `PageHeader` already gets this right (`status === undefined ? null : {...}`), so the
   * same undefined status produced a dash in the header and a claim about a dead collector in the
   * card beneath it — two readings of one fact that cannot both be right.
   *
   * GUARD CONSISTENTLY, on purpose. `statusQuery` IS in the route loader, so `null` should be
   * unreachable in practice — but that guarantee is a property of the route config, not of this
   * component, and a future edit (someone moves the query out of the loader, a `gcTime` eviction
   * lands between renders) can silently remove it with no signal here. The failure mode of being
   * wrong is asserting the collector is dead; the failure mode of guarding anyway is one branch
   * that never fires. This is the same convention `PageHeader`'s `live`, `VantageCard`'s and
   * `LinkComparison`'s skeletons, and `pathStats`'s own `vantage === undefined` branch already
   * follow — one deliberate rule across four call sites, not four independent accidents.
   */
  status: { ongoingOutages: OngoingOutage[]; lastSamples: StatusSample[] } | null
  /** The dashboard's floored clock (`rangeToWindow`'s `to`). */
  now: number
}) {
  const pending = status === null
  const ongoingOutages = status?.ongoingOutages ?? []
  const lastSamples = status?.lastSamples ?? []
  const latestTs = latestSampleTs(lastSamples)
  const reporting = latestTs !== null && !isStale(latestTs, now)
  const gateway = liveGateway(lastSamples)
  const internet = liveInternet(lastSamples)

  const verdict = (
    <Verdict ongoingOutages={ongoingOutages} reporting={reporting} latestTs={latestTs} now={now} pending={pending} />
  )
  const age = (
    <Text size="sm" c="dimmed" ff="monospace">
      {latestTs === null ? 'no data' : fmtRelative(latestTs, now)}
    </Text>
  )

  return (
    <Card py="xs" px="sm">
      <Stack gap="xs" hiddenFrom="sm">
        <Cell label="Status">{verdict}</Cell>
        <Divider />
        <Cell label="Latest cycle">
          <SimpleGrid cols={2} spacing="xs">
            <Reading kind="router" reading={gateway} now={now} />
            <Reading kind="internet" reading={internet} now={now} />
          </SimpleGrid>
        </Cell>
        <Divider />
        <Cell label="Measured">{age}</Cell>
      </Stack>

      <Group align="stretch" wrap="nowrap" gap="lg" visibleFrom="sm">
        <Cell label="Status">{verdict}</Cell>
        <Divider orientation="vertical" />
        <Cell label="Latest cycle">
          <Group gap="xl" wrap="nowrap" align="flex-start">
            <Reading kind="router" reading={gateway} now={now} />
            <Reading kind="internet" reading={internet} now={now} />
          </Group>
        </Cell>
        <Divider orientation="vertical" />
        <Cell label="Measured">{age}</Cell>
      </Group>
    </Card>
  )
}

/**
 * One segment of the strip: a micro-caps label over its content.
 *
 * Every cell takes this shape so the three labels share a baseline and the strip reads as a grid
 * rather than as three differently-built clusters that happen to be adjacent. **"Latest cycle" in
 * particular is load-bearing copy, not decoration** — drop it and "0.0% loss" here reads as
 * contradicting the KPI row's "Worst 5 minutes: 100.0% lost" a few rows down. They are different
 * measurements and this caption is the only thing keeping them apart. "Measured" is the same
 * argument for the age: it used to be a bare right-aligned number whose meaning came entirely from
 * where flexbox happened to put it, which stopped being anywhere in particular the moment the row
 * wrapped.
 */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={4} miw={0}>
      <Text fz={VX.text.micro} c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.06em' }}>
        {label}
      </Text>
      {children}
    </Stack>
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
  /** True while `status` (the module's docblock) is `null` — see that comment for why this must
   * short-circuit before `reporting`, not be folded into it. */
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
        {/* 28, matching `NotReportingLine`/`OutageLine`. At 32 the card grew a few px taller the
            moment the verdict went from green to a warning, i.e. the strip changed height for a
            reason that had nothing to do with what it was saying. */}
        <ThemeIcon size={28} radius="md" color="green" variant="light">
          <IconCircleCheck size={16} />
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
 * is called once per `ongoingOutages` entry rather than assuming at most one. Same touch-reachable
 * tooltip treatment as `NotReportingLine` — this one carries the start time, which a phone otherwise
 * has no way to see. */
function OutageLine({ outage, now }: { outage: OngoingOutage; now: number }) {
  const short = `${SCOPE_LABEL[outage.scope]} in progress · ${fmtDuration((now - outage.startedAt) / 1000)} so far`

  return (
    <Tooltip
      label={`Started ${fmtDateTime(outage.startedAt)}`}
      events={{ hover: true, focus: true, touch: true }}
    >
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
        {/* The strip's only live measurements, and the largest type in it — see the module
            docblock. Everything around them is a caption or a timestamp. */}
        <Group gap="sm" wrap="nowrap" align="baseline">
          <Text
            fw={600}
            fz="lg"
            ff="monospace"
            c={stale ? 'dimmed' : undefined}
            td={stale ? 'line-through' : undefined}
          >
            {fmtMs(reading.medMs)}
          </Text>
          <Text
            size="sm"
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
        {/* The strip's one shared age (`MeasuredAge`) covers the common case where both readings
            share a probe cycle. This reading's own age comes back, promoted, only when it has gone
            stale on its own — a fact the shared age cannot carry. */}
        {(stale || nothing) && (
          <Text fz={stale ? undefined : VX.text.micro} size={stale ? 'xs' : undefined} c="dimmed" fw={stale ? 600 : undefined}>
            {reading.ts === null ? 'no data' : `Last seen ${fmtRelative(reading.ts, now)} — not current`}
          </Text>
        )}
      </Stack>
    </Group>
  )
}

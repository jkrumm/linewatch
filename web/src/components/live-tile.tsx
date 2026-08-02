import { Card, Group, Stack, Text, ThemeIcon } from '@mantine/core'
import { IconRouter, IconWorld } from '@tabler/icons-react'
import type { LiveReading } from '../lib/live'
import { isStale } from '../lib/freshness'
import { fmtMs, fmtPct, fmtRelative } from '../lib/format'

/**
 * One live reading — and, first, whether it *is* a live reading.
 *
 * A tile toned purely on up/loss paints a three-day-old sample green with its RTT in 18 px
 * semibold monospace and the age in 11 px dimmed text underneath: the loudest element on the tile
 * says "fine right now" about a measurement from Tuesday. Beyond two probe cycles the tile goes
 * neutral, strikes the values through and promotes the age, because a stale sample is history — it
 * is neither evidence that the target is up nor evidence that it is down.
 *
 * The tile also names its own *scope*: everything below the "Latest cycle" caption is the single
 * newest probe cycle, never the window the page's range control selects — that is the KPI row,
 * over a whole window. An uncaptioned "Loss 0.0%" here reads as contradicting a "Worst 5 minutes:
 * 100.0% lost" a few rows up; it isn't a contradiction, it is a different measurement with no label
 * saying so. This does not change when a sample goes stale — the caption still describes what the
 * values below it are *of*, even after they've been struck through as no longer current.
 *
 * It renders a `LiveReading` rather than a single target's sample, so "Router" (one constituent)
 * and "Internet" (three, folded) are drawn by the same component. The constituent count rides on
 * the tile whenever there is more than one, because "5.4 ms" over three anchors and "5.4 ms" over
 * the one that still answers are different claims and nothing else on the tile distinguishes them.
 */
export function LiveTile({
  kind,
  reading,
  now,
}: {
  kind: 'router' | 'internet'
  reading: LiveReading
  /** The dashboard's floored clock (`rangeToWindow`'s `to`) — the reference the age is measured against. */
  now: number
}) {
  const stale = reading.ts !== null && isStale(reading.ts, now)
  const nothing = reading.ts === null
  const down = !stale && !nothing && reading.upCount === 0
  const partial = !stale && !nothing && reading.upCount > 0 && reading.upCount < reading.total
  const degraded = !stale && !nothing && !down && (partial || (reading.worstLossPct ?? 0) > 0)
  const tone = stale || nothing ? 'gray' : down ? 'red' : degraded ? 'yellow' : 'green'

  const Icon = kind === 'router' ? IconRouter : IconWorld
  const title = kind === 'router' ? 'Router' : 'Internet'
  // What the number is *of*, in the corner where the per-target tile used to print an IP address.
  // "Median of 3" is the difference between a reading and an aggregate, and this is the only place
  // on the tile it can be said without competing with the value.
  const basis =
    reading.total === 0
      ? '—'
      : reading.total === 1
        ? (reading.samples[0]?.addr ?? '—')
        : `median of ${reading.total}`

  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <ThemeIcon size={28} radius="md" color={tone} variant="light">
            <Icon size={16} />
          </ThemeIcon>
          <Text fw={600} size="sm">
            {title}
          </Text>
        </Group>
        <Text size="xs" c="dimmed" ff="monospace">
          {basis}
        </Text>
      </Group>
      {/* These tiles sit near the KPI row, which reports the selected window. Without this caption
          "Loss 0.0%" here reads as contradicting "Worst 5 minutes 100.0% lost" up there — it isn't
          a contradiction, it is a different measurement (this one probe cycle vs. the whole window)
          with no label saying so. One caption naming the scope, rather than repeating "latest
          cycle" on both the RTT and Loss labels below. */}
      <Text size="10px" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.06em' }} mb={4}>
        Latest cycle
      </Text>
      <Group justify="space-between" align="flex-end">
        <Stack gap={0}>
          <Text size="xs" c="dimmed">
            Ping
          </Text>
          <Text
            fw={600}
            size="lg"
            ff="monospace"
            c={stale ? 'dimmed' : undefined}
            td={stale ? 'line-through' : undefined}
          >
            {fmtMs(reading.medMs)}
          </Text>
        </Stack>
        <Stack gap={0} align="flex-end">
          <Text size="xs" c="dimmed">
            Loss
          </Text>
          <Text
            fw={600}
            size="sm"
            ff="monospace"
            c={stale ? 'dimmed' : degraded || down ? 'red' : undefined}
            td={stale ? 'line-through' : undefined}
          >
            {fmtPct(reading.worstLossPct)}
          </Text>
        </Stack>
      </Group>
      {/* A partial answer is its own state and gets its own sentence. Folding "1 of 3 answering"
          into the loss figure would put an internet outage and a single dead anchor on the same
          scale, which is exactly the over-claim the fold was written to avoid. */}
      {partial && (
        <Text size="xs" c="yellow" mt={4}>
          {reading.upCount} of {reading.total} answering
        </Text>
      )}
      {/* The age is the headline once the sample is stale, and a footnote while it is current. */}
      {reading.ts === null ? (
        <Text size="xs" c="dimmed" mt={4}>
          no data
        </Text>
      ) : (
        <Text size={stale ? 'sm' : 'xs'} c="dimmed" fw={stale ? 600 : undefined} mt={4}>
          {stale ? `Last seen ${fmtRelative(reading.ts, now)} — not current` : fmtRelative(reading.ts, now)}
        </Text>
      )}
    </Card>
  )
}

import { Card, Group, Stack, Text, ThemeIcon } from '@mantine/core'
import { IconRouter, IconWorld } from '@tabler/icons-react'
import type { StatusSample, TargetName } from '../lib/types'
import { TARGET_LABEL } from '../lib/types'
import { isStale } from '../lib/freshness'
import { fmtMs, fmtPct, fmtRelative } from '../lib/format'

/**
 * One target's latest reading — and, first, whether it *is* a latest reading.
 *
 * A tile toned purely on `up`/`lossPct` paints a three-day-old sample green with its RTT in 18 px
 * semibold monospace and the age in 11 px dimmed text underneath: the loudest element on the tile
 * says "fine right now" about a measurement from Tuesday. Beyond two probe cycles the tile goes
 * neutral, strikes the values through and promotes the age, because a stale sample is history — it
 * is neither evidence that the target is up nor evidence that it is down.
 */
export function TargetTile({
  target,
  sample,
  now,
}: {
  target: TargetName
  sample: StatusSample | null
  /** The dashboard's floored clock (`rangeToWindow`'s `to`) — the reference the age is measured against. */
  now: number
}) {
  const stale = sample !== null && isStale(sample.ts, now)
  // `up` is server-derived (`received > 0`) — trust it over re-deriving from lossPct here.
  const down = !stale && (sample === null || !sample.up)
  const degraded = !stale && !down && sample !== null && sample.lossPct > 0
  const tone = stale ? 'gray' : down ? 'red' : degraded ? 'yellow' : 'green'
  const Icon = target === 'gateway' ? IconRouter : IconWorld

  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <ThemeIcon size={28} radius="md" color={tone} variant="light">
            <Icon size={16} />
          </ThemeIcon>
          <Text fw={600} size="sm">
            {TARGET_LABEL[target]}
          </Text>
        </Group>
        <Text size="xs" c="dimmed" ff="monospace">
          {sample?.addr ?? '—'}
        </Text>
      </Group>
      <Group justify="space-between" align="flex-end">
        <Stack gap={0}>
          <Text size="xs" c="dimmed">
            Median RTT
          </Text>
          <Text
            fw={600}
            size="lg"
            ff="monospace"
            c={stale ? 'dimmed' : undefined}
            td={stale ? 'line-through' : undefined}
          >
            {fmtMs(sample?.medMs ?? null)}
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
            {fmtPct(sample?.lossPct ?? null)}
          </Text>
        </Stack>
      </Group>
      {/* The age is the headline once the sample is stale, and a footnote while it is current. */}
      {sample === null ? (
        <Text size="xs" c="dimmed" mt={4}>
          no data
        </Text>
      ) : (
        <Text size={stale ? 'sm' : 'xs'} c="dimmed" fw={stale ? 600 : undefined} mt={4}>
          {stale ? `Last seen ${fmtRelative(sample.ts, now)} — not current` : fmtRelative(sample.ts, now)}
        </Text>
      )}
    </Card>
  )
}

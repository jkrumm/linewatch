import { Card, Group, Stack, Text, ThemeIcon } from '@mantine/core'
import { IconRouter, IconWorld } from '@tabler/icons-react'
import type { StatusSample, TargetName } from '../lib/types'
import { TARGET_LABEL } from '../lib/types'
import { fmtMs, fmtPct, fmtRelative } from '../lib/format'

export function TargetTile({ target, sample }: { target: TargetName; sample: StatusSample | null }) {
  // `up` is server-derived (`received > 0`) — trust it over re-deriving from lossPct here.
  const down = sample === null || !sample.up
  const degraded = !down && sample !== null && sample.lossPct > 0
  const tone = down ? 'red' : degraded ? 'yellow' : 'green'
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
          <Text fw={600} size="lg" ff="monospace">
            {fmtMs(sample?.medMs ?? null)}
          </Text>
        </Stack>
        <Stack gap={0} align="flex-end">
          <Text size="xs" c="dimmed">
            Loss
          </Text>
          <Text fw={600} size="sm" ff="monospace" c={degraded || down ? 'red' : undefined}>
            {fmtPct(sample?.lossPct ?? null)}
          </Text>
        </Stack>
      </Group>
      <Text size="xs" c="dimmed" mt={4}>
        {sample ? fmtRelative(sample.ts) : 'no data'}
      </Text>
    </Card>
  )
}

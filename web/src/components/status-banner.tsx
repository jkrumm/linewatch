import { Badge, Card, Group, Stack, Text, ThemeIcon } from '@mantine/core'
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react'
import type { OngoingOutage } from '../lib/types'
import { fmtDateTime, fmtDuration } from '../lib/format'

const SCOPE_LABEL: Record<OngoingOutage['scope'], string> = {
  wan: 'WAN outage',
  gateway: 'Gateway outage',
}

/**
 * The "is it working right now" headline for the Now view — the one thing this dashboard must
 * answer in a single glance (docs/DESIGN.md's "Dashboard" section). Takes `ongoingOutages` as an
 * array straight off `GET /api/status` — a gateway outage and a WAN outage can be open at the
 * same time, so this renders one row per concurrent outage rather than assuming at most one.
 */
export function StatusBanner({ ongoingOutages }: { ongoingOutages: OngoingOutage[] }) {
  if (ongoingOutages.length === 0) {
    return (
      <Card withBorder radius="md" padding="lg">
        <Group gap="md">
          <ThemeIcon size={44} radius="md" color="green" variant="light">
            <IconCircleCheck size={26} />
          </ThemeIcon>
          <Stack gap={0}>
            <Text fw={600} size="lg">
              All systems up
            </Text>
            <Text size="sm" c="dimmed">
              WAN and gateway both reachable
            </Text>
          </Stack>
        </Group>
      </Card>
    )
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Stack gap="md">
        {ongoingOutages.map((outage) => (
          <Group key={outage.id} gap="md" justify="space-between" wrap="wrap">
            <Group gap="md">
              <ThemeIcon size={44} radius="md" color="red" variant="light">
                <IconAlertTriangle size={26} />
              </ThemeIcon>
              <Stack gap={0}>
                <Text fw={600} size="lg" c="red">
                  {SCOPE_LABEL[outage.scope]} in progress
                </Text>
                <Text size="sm" c="dimmed">
                  Started {fmtDateTime(outage.startedAt)} ·{' '}
                  {fmtDuration((Date.now() - outage.startedAt) / 1000)} so far
                </Text>
              </Stack>
            </Group>
            <Badge color="red" variant="light">
              {outage.scope}
            </Badge>
          </Group>
        ))}
      </Stack>
    </Card>
  )
}

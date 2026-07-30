import { Group, Stack, Text } from '@mantine/core'
import { IconArrowsRightLeft } from '@tabler/icons-react'
import type { SpeedTest } from '../lib/types'
import { fmtDateTime } from '../lib/format'

type ServerChange = { ts: number; from: string | null; to: SpeedTest }

function detectServerChanges(tests: SpeedTest[]): ServerChange[] {
  const sorted = [...tests].sort((a, b) => a.ts - b.ts)
  const changes: ServerChange[] = []
  let previous: SpeedTest | null = null
  for (const test of sorted) {
    if (
      test.serverId !== null &&
      previous !== null &&
      previous.serverId !== null &&
      test.serverId !== previous.serverId
    ) {
      changes.push({ ts: test.ts, from: previous.serverName, to: test })
    }
    previous = test
  }
  return changes
}

/** DESIGN.md: "Ookla picks a server per run ... the UI flags a change" — a server swap moves the
 * numbers independently of the line, so it needs to be visible next to the throughput chart. */
export function ServerChangeNote({ tests }: { tests: SpeedTest[] }) {
  const changes = detectServerChanges(tests)
  if (changes.length === 0) return null

  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        Server changed {changes.length}× in range
      </Text>
      <Text size="xs" c="dimmed">
        Ookla picks a server per run — a change moves the numbers independently of the line.
      </Text>
      <Stack gap={4}>
        {changes
          .slice(-5)
          .reverse()
          .map((change) => (
            <Group key={change.ts} gap="xs" wrap="nowrap">
              <IconArrowsRightLeft size={14} />
              <Text size="xs" c="dimmed">
                {fmtDateTime(change.ts)}
              </Text>
              <Text size="xs">
                {change.from ?? '—'} → {change.to.serverName ?? '—'}
              </Text>
            </Group>
          ))}
      </Stack>
    </Stack>
  )
}

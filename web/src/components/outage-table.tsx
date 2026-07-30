import { Badge, Table, Text } from '@mantine/core'
import { IconCircleCheck } from '@tabler/icons-react'
import { EmptyState } from 'basalt-ui'
import type { Outage, TargetName } from '../lib/types'
import { TARGET_LABEL } from '../lib/types'
import { fmtDateTime, fmtDuration } from '../lib/format'

/** `Outage.evidence` is typed as plain `string[]` by the API (it doesn't promise every entry is
 * one of our known targets) — fall back to the raw name for anything outside `TARGET_LABEL`. */
function targetLabel(name: string): string {
  return TARGET_LABEL[name as TargetName] ?? name
}

export function OutageTable({ outages }: { outages: Outage[] }) {
  if (outages.length === 0) {
    return (
      <EmptyState
        icon={<IconCircleCheck size={30} />}
        title="No outages in range"
        description="Nothing crossed the minimum-duration filter for the selected period."
        variant="section"
      />
    )
  }

  return (
    <Table verticalSpacing="xs" highlightOnHover>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Started</Table.Th>
          <Table.Th>Duration</Table.Th>
          <Table.Th>Scope</Table.Th>
          <Table.Th>Evidence</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {outages.map((outage) => (
          <Table.Tr key={outage.id}>
            <Table.Td>{fmtDateTime(outage.startedAt)}</Table.Td>
            <Table.Td>
              <Text size="sm" ff="monospace">
                {outage.durationS !== null ? fmtDuration(outage.durationS) : 'ongoing'}
              </Text>
            </Table.Td>
            <Table.Td>
              <Badge color={outage.scope === 'wan' ? 'red' : 'orange'} variant="light">
                {outage.scope}
              </Badge>
            </Table.Td>
            <Table.Td>
              <Text size="sm" c="dimmed">
                {outage.evidence.map(targetLabel).join(', ')}
              </Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  )
}

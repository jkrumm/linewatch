import { Badge, Box, Divider, Group, Skeleton, Stack, Table, Text } from '@mantine/core'
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

/**
 * **Two renderings of the same rows, one step less severe than `transition-timeline.tsx`.** No
 * fixed column widths here, so the browser squeezes to min-content instead of clipping — it fits
 * at 390px by ~11px today, with every column at its floor (`fmtDateTime` wraps to three lines,
 * the evidence join to four). One more evidence target or a longer scope value crosses into the
 * same clipped-by-`Card` state `transition-timeline.tsx` documents (`Card`'s `overflow: hidden`
 * does not scroll). Below `sm` each outage is a row instead; above `sm` the table stays, inside a
 * `Table.ScrollContainer` so growth can never reproduce the clip silently.
 *
 * **The mobile rows are divided `Box`es, not their own `Card`s.** `index.tsx` already wraps the
 * whole Outages view in one `<Card py="xs" px="sm">` for the panel surface; a `Card` per row inside
 * it used to stack an identical `--vx-surface-panel` fill and `shadow-card` ring on top of that
 * same surface — no contrast step, just a doubled ring, which is what the one-card-idiom doctrine
 * exists to prevent. A `Divider` between rows reads as a list inside one panel, which is what this
 * actually is.
 */
export function OutageTable({ outages, isPending }: { outages: Outage[]; isPending?: boolean }) {
  if (outages.length === 0 && isPending === true) {
    return (
      <Stack gap="xs">
        <Skeleton h={28} />
        <Skeleton h={28} />
        <Skeleton h={28} />
      </Stack>
    )
  }

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
    <>
      <Table.ScrollContainer minWidth={520} type="native" visibleFrom="sm">
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
      </Table.ScrollContainer>

      <Stack gap={0} hiddenFrom="sm">
        {outages.map((outage, i) => (
          <Box key={outage.id}>
            {i > 0 && <Divider />}
            <Stack gap={4} py="xs">
              <Group justify="space-between" wrap="nowrap" align="baseline">
                <Text size="sm" ff="monospace">
                  {fmtDateTime(outage.startedAt)}
                </Text>
                <Text size="sm" ff="monospace" fw={600}>
                  {outage.durationS !== null ? fmtDuration(outage.durationS) : 'ongoing'}
                </Text>
              </Group>
              <Badge color={outage.scope === 'wan' ? 'red' : 'orange'} variant="light" w="fit-content">
                {outage.scope}
              </Badge>
              <Text size="xs" c="dimmed">
                {outage.evidence.map(targetLabel).join(', ')}
              </Text>
            </Stack>
          </Box>
        ))}
      </Stack>
    </>
  )
}

import { Box, Collapse, Group, Stack, Text, UnstyledButton } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { IconArrowsRightLeft, IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import { VX } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'
import { fmtDateTime } from '../lib/format'

type ServerChange = { ts: number; from: string | null; to: SpeedTest }

/** How many rows the disclosure shows, most recent first — same cap the note has always drawn. */
const SHOWN_CHANGES = 5

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

/**
 * DESIGN.md: "Ookla picks a server per run ... the UI flags a change" — a server swap moves the
 * numbers independently of the line, so it needs to be visible next to the throughput chart.
 *
 * That fact used to draw a bold line, an explanatory sentence and up to five dated rows un-carded at
 * full width — ~130px, on every load, for background context on a chart the reader is looking at for
 * a different reason. Collapsed to one dim line carrying the count *and* the caveat sentence (the
 * caveat is why this component exists at all — without it an unexplained step in the throughput
 * chart reads as the line changing, not the vantage point Ookla measured from), with the dated rows
 * behind a disclosure that names its own count. The rows are unchanged, cap included: this only
 * changes when they're drawn, not what's in the list.
 */
export function ServerChangeNote({ tests }: { tests: SpeedTest[] }) {
  const changes = detectServerChanges(tests)
  const [opened, { toggle }] = useDisclosure(false)
  const Chevron = opened ? IconChevronDown : IconChevronRight

  if (changes.length === 0) return null

  const shown = changes.slice(-SHOWN_CHANGES).reverse()
  const capped = shown.length < changes.length
  // A capped list must say so — claiming "all" while showing 5 of 19 implies a complete list that
  // isn't there.
  const toggleLabel = capped
    ? `Show last ${shown.length} of ${changes.length} changes`
    : `Show all ${changes.length} change${changes.length === 1 ? '' : 's'}`

  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        Server changed {changes.length}× in this window — Ookla picks a server per run, so a change
        moves the numbers independently of the line.
      </Text>
      <Box>
        <UnstyledButton onClick={toggle} aria-expanded={opened}>
          <Group gap={6} wrap="nowrap">
            <Chevron size={14} color={VX.faint} aria-hidden="true" />
            <Text size="xs" c="dimmed">
              {toggleLabel}
            </Text>
          </Group>
        </UnstyledButton>
        <Collapse expanded={opened}>
          <Stack gap={4} pl={20} pt={4}>
            {shown.map((change) => (
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
        </Collapse>
      </Box>
    </Stack>
  )
}

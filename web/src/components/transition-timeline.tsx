import { Badge, Table, Text, Tooltip } from '@mantine/core'
import { IconEyeOff } from '@tabler/icons-react'
import { EmptyState } from 'basalt-ui'
import type { LinewatchEvent } from '../lib/types'
import { EVENT_KIND_LABEL, eventSourceLabel, summariseEventDetail, timelineEmptyState } from '../lib/events'
import { fmtDateTime } from '../lib/format'

/**
 * Every recorded transition in the window: path changes, sub-cycle link flaps, carrier resyncs and
 * the interventions that explain some of them.
 *
 * A plain Mantine `Table`, following `outage-table.tsx`, and **not** `basalt-ui/data`'s
 * `BasaltDataTable`: that one needs `@tanstack/react-table`, which is an optional peer this app
 * does not install. A dependency for a sub-20-row timeline is the trade the dependency-hygiene
 * rule exists to refuse.
 *
 * The source column is not decoration. A `vantage-diff` row is stamped when the *snapshot* was
 * taken, so its transition happened somewhere in the preceding 30 s; a `link-sampler` row is
 * stamped at the transition itself to ~1 s. One timestamp column showing both without saying which
 * is which claims a precision two of the three writers do not have.
 */
export function TransitionTimeline({
  events,
  linkSamplingSince,
}: {
  events: LinewatchEvent[]
  /** Earliest cycle in this window that reported `link_watch_s`, or null when none did. Decides
   * which of the two empty states is true, and they say opposite things. */
  linkSamplingSince: number | null
}) {
  if (events.length === 0) {
    const empty = timelineEmptyState(linkSamplingSince)
    return (
      <EmptyState
        icon={<IconEyeOff size={30} />}
        title={empty.title}
        description={empty.description}
        variant="section"
      />
    )
  }

  return (
    <Table verticalSpacing="xs" highlightOnHover>
      <Table.Thead>
        <Table.Tr>
          {/* Explicit widths on the three narrow columns. Without them the browser gives Detail —
              by far the longest cell — almost the whole table and squeezes the badges until their
              own text ellipsises: `link_change` rendered as "LINK …" and `vantage-diff` as
              "VANTAG…", which turns the two columns that say WHAT happened and WHO saw it into
              the least readable thing on the page. Detail takes the remainder. */}
          <Table.Th w={150}>When</Table.Th>
          <Table.Th w={130}>Kind</Table.Th>
          <Table.Th w={140}>Observed by</Table.Th>
          <Table.Th>Detail</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {events.map((event) => {
          const source = eventSourceLabel(event.source)
          return (
            <Table.Tr key={event.id}>
              <Table.Td>
                <Text size="sm" ff="monospace">
                  {fmtDateTime(event.ts)}
                </Text>
              </Table.Td>
              <Table.Td>
                <Badge color={event.kind === 'intervention' ? 'grape' : 'blue'} variant="light" style={{ whiteSpace: 'nowrap' }}>
                  {EVENT_KIND_LABEL[event.kind]}
                </Badge>
              </Table.Td>
              <Table.Td>
                {/* The precision rides on the badge rather than in a fifth column: it is the
                    caveat on the timestamp, not a fact of its own. */}
                <Tooltip label={`Timestamp means: ${source.precision}`} multiline w={280}>
                  <Badge color={source.color} variant="light" style={{ cursor: 'help', whiteSpace: 'nowrap' }}>
                    {source.label}
                  </Badge>
                </Tooltip>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {summariseEventDetail(event.detail)}
                </Text>
              </Table.Td>
            </Table.Tr>
          )
        })}
      </Table.Tbody>
    </Table>
  )
}

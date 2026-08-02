import { Badge, Box, Divider, Group, Skeleton, Stack, Table, Text, Tooltip } from '@mantine/core'
import { IconEyeOff } from '@tabler/icons-react'
import { EmptyState } from 'basalt-ui'
import type { LinewatchEvent } from '../lib/types'
import { EVENT_KIND_LABEL, eventSourceLabel, summariseEventDetail, timelineEmptyState } from '../lib/events'
import { fmtDateTime } from '../lib/format'

/**
 * One hue per kind, from the identity set only. `grape` was off-identity (the theme guard's
 * allowed accents are blue, gray, and the status hues) and three of the four kinds shared one blue,
 * which made a mixed timeline read as one repeated fact. `intervention` keeps the earned accent
 * because it is the only row where a human acted; the rest are events, not actions.
 */
const KIND_COLOR: Record<LinewatchEvent['kind'], string> = {
  intervention: 'blue',
  link_change: 'orange',
  config_change: 'gray',
  note: 'gray',
}

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
 *
 * **Two renderings of the same rows, and the reason is not density.** Inside `Card`'s `overflow:
 * hidden`, a table whose min-content is ~550px in a 338px card does not scroll — it is cut, with no
 * scrollbar anywhere on the page, and the two columns saying WHAT happened and WHO saw it are the
 * two that fall off the edge. So below `sm` each event is its own row and every field gets its own
 * line, including the source-precision caveat that rides a hover Tooltip on the table path. Above
 * `sm` the table stays, inside a `Table.ScrollContainer` so a longer detail string can never
 * reproduce the clip silently.
 *
 * **The mobile rows are divided `Box`es, not their own `Card`s** — see `outage-table.tsx`'s
 * identical note. `index.tsx` already wraps the whole Transitions view in one panel `Card`; a
 * second `Card` per row inside it doubled the same `--vx-surface-panel` fill and `shadow-card` ring
 * with no contrast step to show for it, which is exactly what the one-card idiom rules out.
 */
export function TransitionTimeline({
  events,
  linkSamplingSince,
  isPending,
}: {
  events: LinewatchEvent[]
  /** Earliest cycle in this window that reported `link_watch_s`, or null when none did. Decides
   * which of the two empty states is true, and they say opposite things. */
  linkSamplingSince: number | null
  /** True while the events query for this window is in flight. A key rotation empties `events`, and
   * the empty state then claims "no transition was observed" over a window nobody has asked about
   * yet — which is the exact over-claim `timelineEmptyState`'s two branches exist to avoid. */
  isPending?: boolean
}) {
  if (events.length === 0 && isPending === true) {
    return (
      <Stack gap="xs">
        <Skeleton h={28} />
        <Skeleton h={28} />
        <Skeleton h={28} />
      </Stack>
    )
  }

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
    <>
      <Table.ScrollContainer minWidth={560} type="native" visibleFrom="sm">
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
                    <Badge color={KIND_COLOR[event.kind]} variant="light" style={{ whiteSpace: 'nowrap' }}>
                      {EVENT_KIND_LABEL[event.kind]}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {/* The precision rides on the badge rather than in a fifth column: it is the
                        caveat on the timestamp, not a fact of its own. `touch: true` because Mantine's
                        default is touch-off — a `cursor: help` badge otherwise advertises information
                        no gesture on a phone can open. */}
                    <Tooltip
                      label={`Timestamp means: ${source.precision}`}
                      multiline
                      w={280}
                      events={{ hover: true, focus: true, touch: true }}
                    >
                      <Badge
                        color={source.color}
                        variant="light"
                        tabIndex={0}
                        style={{ cursor: 'help', whiteSpace: 'nowrap' }}
                      >
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
      </Table.ScrollContainer>

      <Stack gap={0} hiddenFrom="sm">
        {events.map((event, i) => {
          const source = eventSourceLabel(event.source)
          return (
            <Box key={event.id}>
              {i > 0 && <Divider />}
              <Stack gap={4} py="xs">
                <Text size="sm" ff="monospace">
                  {fmtDateTime(event.ts)}
                </Text>
                <Group gap="xs" wrap="wrap">
                  <Badge color={KIND_COLOR[event.kind]} variant="light">
                    {EVENT_KIND_LABEL[event.kind]}
                  </Badge>
                  <Badge color={source.color} variant="light">
                    {source.label}
                  </Badge>
                </Group>
                {/* The precision caveat is a visible line here, not a hover. On the table path it
                    rides a Tooltip on the badge; a phone has no hover, and this caveat is the
                    difference between a timestamp meaning "within 30 s of this" and "within 1 s of
                    this". */}
                <Text size="xs" c="dimmed">
                  Timestamp means: {source.precision}
                </Text>
                <Text size="sm" c="dimmed">
                  {summariseEventDetail(event.detail)}
                </Text>
              </Stack>
            </Box>
          )
        })}
      </Stack>
    </>
  )
}

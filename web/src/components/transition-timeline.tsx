import { useState } from 'react'
import { Badge, Box, Divider, Group, Pagination, Skeleton, Stack, Table, Text, Tooltip } from '@mantine/core'
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
 * Rows per page.
 *
 * This list was unpaged, and `GET /api/events` has no `limit` — it returns every event in the
 * window, newest first. That was survivable while the record was days old and is not the shape it
 * grows into: the events table takes a row per link transition, per config change and per non-clean
 * poll, which measured at ~60/day, so the `all` range reaches five figures inside a year. Rendering
 * them is one enormous scroll a reader cannot navigate and, on the mobile path, that many mounted
 * `Tooltip`s.
 *
 * Paged rather than capped, deliberately. A `limit` on the query would be this repo's own
 * silent-truncation failure — the list would look complete and be a slice — while a page control
 * states the total on itself and can reach every row. The payload is still the whole window; that
 * is the next thing to fix here, and it is a server change, not this one.
 */
const PAGE_SIZE = 25

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
  const [page, setPage] = useState(1)

  // Reset to the first page when the underlying list changes — switching the range while on page 4
  // should not land the reader in the middle of a different window's events.
  //
  // Keyed on a cheap SIGNATURE rather than the array's identity, and that is not a micro-
  // optimisation: `routes/index.tsx` passes `events?.events ?? []`, so while the query is
  // unresolved every render produces a fresh empty array. An identity comparison would see a change
  // every time, set state during render, and re-render into the same comparison — a loop. The
  // signature is stable for an empty list and for TanStack Query's structurally-shared refetches,
  // and changes exactly when the window's newest event or its count does.
  const signature = `${events.length}:${events[0]?.id ?? ''}`
  const [seen, setSeen] = useState(signature)
  if (seen !== signature) {
    setSeen(signature)
    setPage(1)
  }

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

  const pageCount = Math.max(1, Math.ceil(events.length / PAGE_SIZE))
  // Clamped rather than trusted. The signature reset above handles a window change, but a refetch
  // that merely shortens the list (an event ageing out of the window) leaves `page` past the end,
  // and an out-of-range slice renders as an empty table under a control that says otherwise.
  const current = Math.min(page, pageCount)
  const shown = events.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

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
            {shown.map((event) => {
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
        {shown.map((event, i) => {
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

      {/* The control is drawn only when it has something to do, but the COUNT is stated either way
          — "24 transitions" over a single page is the fact a reader needs to know the list is
          whole, and it is the same sentence that stops a paged list from reading as the whole
          record. `withEdges` because the newest and oldest transitions are the two a reader jumps
          to; stepping there one page at a time over a year of events is not navigation. */}
      <Group justify="space-between" align="center" wrap="wrap" gap="xs" pt="xs">
        <Text size="xs" c="dimmed">
          {events.length} transition{events.length === 1 ? '' : 's'} in this window
          {pageCount > 1 && ` · showing ${(current - 1) * PAGE_SIZE + 1}\u2013${(current - 1) * PAGE_SIZE + shown.length}`}
        </Text>
        {pageCount > 1 && (
          <Pagination
            size="sm"
            withEdges
            total={pageCount}
            value={current}
            onChange={setPage}
            aria-label="Transition timeline pages"
          />
        )}
      </Group>
    </>
  )
}

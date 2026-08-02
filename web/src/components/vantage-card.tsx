import { Badge, Card, Group, Skeleton, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import { StatCard } from 'basalt-ui'
import { Callout } from 'basalt-ui/content'
import type { Vantage } from '../lib/types'
import { homeLineChip } from '../lib/vantage'
import { fmtDateTime, fmtRelative } from '../lib/format'

/** Every field on `Vantage` is nullable because the collector reports what it could parse and
 * nothing more. A dash is the only honest rendering of an unparsed field — a plausible default is
 * the exact fabrication `probe_cycle` exists to prevent. */
function value(v: string | number | null, suffix = ''): string {
  if (v === null) return '—'
  return `${v}${suffix}`
}

/**
 * What the newest cycle measured *through* — the answer to "is this even my line", which every
 * other number on this dashboard silently assumes.
 *
 * Three renderings, not two. `vantage === undefined` is `GET /api/status` not having answered yet
 * — a skeleton, nothing asserted. `vantage === null` is the answer having come back with no cycle
 * ever reporting one, which is a different fact and used to be indistinguishable from the pending
 * case (both collapsed through `status?.vantage ?? null` in `routes/index.tsx`), so this card could
 * assert "no cycle has reported a vantage" — a claim about the collector — before the query behind
 * it had returned. And `onHomeLine: null` gets its own grey "unknown" chip: it is not a weaker
 * `true`, and a check mark there would claim a home-line measurement nobody made.
 *
 * Titled "This machine → router" rather than "Current vantage", because the section holds two cards
 * and a reader could not tell which half each answered. The two titles now name the two hops: this
 * card is the wire out of this machine, `LinkComparison` is the line past the router. "Vantage" is
 * the word the schema uses; it is not a word the reader has.
 */
export function VantageCard({ vantage, now }: { vantage: Vantage | null | undefined; now: number }) {
  if (vantage === undefined) {
    return (
      <Card py="xs" px="sm">
        <Stack gap="sm">
          <Title order={4}>This machine → router</Title>
          <Skeleton h={90} />
        </Stack>
      </Card>
    )
  }

  if (vantage === null) {
    return (
      <Card py="xs" px="sm">
        <Stack gap="sm">
          <Title order={4}>This machine → router</Title>
          <Callout kind="info" title="No cycle has reported a vantage">
            `probe_cycle` is empty, so what these measurements went out over is unrecorded — not
            Ethernet, not the home line, unrecorded. Every reading elsewhere on this dashboard is
            true of some path; which one is unknown.
          </Callout>
        </Stack>
      </Card>
    )
  }

  const chip = homeLineChip(vantage.onHomeLine)

  return (
    <Card py="xs" px="sm">
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <Stack gap={0}>
            <Title order={4}>This machine → router</Title>
            <Text size="sm" c="dimmed">
              Cycle of {fmtDateTime(vantage.ts)} · {fmtRelative(vantage.ts, now)}
            </Text>
          </Stack>
          <Badge color={chip.color} variant="light">
            {chip.label}
          </Badge>
        </Group>

        <Text size="sm" c="dimmed">
          {chip.description}
        </Text>

        {/* One column below sm, not two. At two-up each card holds ~147px of content against a
            24px mono hero, and `overflow: hidden` on the card silently cut the gateway address (13
            chars, 187px, and browsers do not break at dots), the DHCP bind time, and the duplex.
            Eight cards in a column is tall; a truncated gateway on the card that answers "is this
            even my line" is wrong. */}
        <SimpleGrid cols={{ base: 1, sm: 3, lg: 4 }} spacing="md">
          <StatCard label="Interface" value={value(vantage.pathIf)} />
          <StatCard label="Path class" value={value(vantage.pathClass)} />
          <StatCard label="Media" value={value(vantage.linkMedia)} />
          <StatCard label="Negotiated" value={value(vantage.linkMbit, ' Mbit')} />
          <StatCard label="Duplex" value={value(vantage.linkDuplex)} />
          {/* The NIC's supported ceiling, not its negotiated rate. Equal values mean the link is
              running at everything the adapter has; a ceiling above the negotiated rate is what
              separates a cable fault from a 100 Mbit adapter. A dash is neither. */}
          <StatCard label="NIC ceiling" value={value(vantage.linkMaxMbit, ' Mbit')} />
          <StatCard label="Gateway" value={value(vantage.gatewayAddr)} />
          <StatCard
            label="DHCP bound"
            value={vantage.dhcpBoundAt === null ? '—' : fmtDateTime(vantage.dhcpBoundAt)}
          />
        </SimpleGrid>

        <Text size="xs" c="dimmed">
          A change in the DHCP bind time proves the interface re-bound; an unchanged one proves
          nothing about link stability — two link-downs on this host left it untouched.
        </Text>
      </Stack>
    </Card>
  )
}

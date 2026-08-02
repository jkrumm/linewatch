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

/** Joins the parts of a merged card, dropping the ones that were never parsed. All-null is a dash,
 * not an empty string: the card still has to say it knows nothing rather than look blank. */
function joined(parts: (string | number | null)[]): string {
  const present = parts.filter((p) => p !== null)
  return present.length === 0 ? '—' : present.join(' · ')
}

/**
 * The negotiated rate against the adapter's own ceiling, on one card.
 *
 * These were two cards, and separating them buried the only question either answers. A bare
 * "100 Mbit" is not a finding — a 100 Mbit adapter running at 100 is perfect, a gigabit adapter
 * running at 100 is a cable fault, and the difference lived on the other card. Read together they
 * are one reading; read apart the reader has to already know to compare them.
 *
 * So the ceiling is stated only when it DIFFERS. `1000 of 1000 Mbit` is noise on the card that is
 * fine, every cycle, forever; `100 of 1000 Mbit` is the entire finding.
 */
function linkSpeedValue(vantage: Vantage): string {
  const { linkMbit, linkMaxMbit } = vantage
  if (linkMbit === null) return linkMaxMbit === null ? '—' : `— of ${linkMaxMbit} Mbit`
  if (linkMaxMbit === null || linkMaxMbit === linkMbit) return `${linkMbit} Mbit`
  return `${linkMbit} of ${linkMaxMbit} Mbit`
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

        {/* **Three cards, from eight.** The eight were each individually defensible and together
            unreadable — a wall of mono heroes in which the two that change (the negotiated rate,
            the bind time) sat at the same weight as the six that have not moved since the machine
            was plugged in. Reference detail is not deleted; it is demoted to the line below, where
            it is still there to read and no longer competes with a finding.

            What merged, merged because the parts only mean anything together: an interface without
            its path class does not say whether this is even the home line, and a negotiated rate
            without the adapter's ceiling cannot tell a cable fault from a 100 Mbit NIC.

            One column below sm, still. At two-up each card holds ~147px of content against a 24px
            mono hero, and `overflow: hidden` on the card silently cut the longer values. */}
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
          <StatCard label="Interface" value={joined([vantage.pathIf, vantage.pathClass])} />
          <StatCard label="Link speed" value={linkSpeedValue(vantage)} />
          <StatCard label="Media" value={joined([vantage.linkMedia, vantage.linkDuplex])} />
        </SimpleGrid>

        <Text size="xs" c="dimmed">
          Gateway {value(vantage.gatewayAddr)} · DHCP bound{' '}
          {vantage.dhcpBoundAt === null ? '—' : fmtDateTime(vantage.dhcpBoundAt)}. A change in the
          bind time proves the interface re-bound; an unchanged one proves nothing about link
          stability — two link-downs on this host left it untouched.
        </Text>
      </Stack>
    </Card>
  )
}

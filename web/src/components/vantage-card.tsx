import { Badge, Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core'
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
 * Two renderings are load-bearing. `vantage === null` says no cycle ever reported one, rather than
 * showing a grid of dashes that reads like a cycle reporting nothing. And `onHomeLine: null` gets
 * its own grey "unknown" chip: it is not a weaker `true`, and a check mark there would claim a
 * home-line measurement nobody made.
 */
export function VantageCard({ vantage, now }: { vantage: Vantage | null; now: number }) {
  if (vantage === null) {
    return (
      <Card withBorder radius="md" padding="lg">
        <Stack gap="sm">
          <Title order={4}>Current vantage</Title>
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
    <Card withBorder radius="md" padding="lg">
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <Stack gap={0}>
            <Title order={4}>Current vantage</Title>
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

        <SimpleGrid cols={{ base: 2, sm: 3, lg: 4 }} spacing="md">
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

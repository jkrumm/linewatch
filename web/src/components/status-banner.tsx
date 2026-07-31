import { Badge, Card, Group, Stack, Text, ThemeIcon } from '@mantine/core'
import { IconAlertTriangle, IconCircleCheck, IconPlugConnectedX } from '@tabler/icons-react'
import type { OngoingOutage, StatusSample } from '../lib/types'
import { isStale, latestSampleTs } from '../lib/freshness'
import { fmtDateTime, fmtDuration, fmtMinutes } from '../lib/format'

const SCOPE_LABEL: Record<OngoingOutage['scope'], string> = {
  wan: 'WAN outage',
  gateway: 'Gateway outage',
}

/**
 * The "is it working right now" headline for the Now view — the one thing this dashboard must
 * answer in a single glance (docs/DESIGN.md's "Dashboard" section). Takes `ongoingOutages` as an
 * array straight off `GET /api/status` — a gateway outage and a WAN outage can be open at the
 * same time, so this renders one row per concurrent outage rather than assuming at most one.
 *
 * **Green requires evidence, not the absence of an outage row.** The outage state machine only
 * advances when a cycle is *ingested* (`src/routes/probes.ts`), so a dead launchd collector opens
 * no outage row, closes none, and leaves `ongoingOutages` empty forever — the old banner read that
 * as "All systems up" and would have kept saying so for weeks. That is the container-ICMP failure
 * mode CLAUDE.md forbids, reproduced at the UI layer: a screen that cannot report its own
 * blindness. So the newest sample's age is a precondition for the green state, and a collector that
 * stopped reporting gets its own non-green row — rendered *alongside* any open outage, because
 * "the line was down when we last heard" and "we stopped hearing" are two facts, not two options.
 *
 * `status.up` is the same `ongoingOutages.length === 0` expression computed server-side and is
 * deliberately not read here; reading it would reintroduce exactly this bug with a server's
 * authority behind it.
 */
export function StatusBanner({
  ongoingOutages,
  lastSamples,
  now,
}: {
  ongoingOutages: OngoingOutage[]
  lastSamples: StatusSample[]
  /** The dashboard's floored clock (`rangeToWindow`'s `to`), so the age is quantised like the data. */
  now: number
}) {
  const latestTs = latestSampleTs(lastSamples)
  const reporting = latestTs !== null && !isStale(latestTs, now)

  if (reporting && ongoingOutages.length === 0) {
    return (
      <Card withBorder radius="md" padding="lg">
        <Group gap="md">
          <ThemeIcon size={44} radius="md" color="green" variant="light">
            <IconCircleCheck size={26} />
          </ThemeIcon>
          <Stack gap={0}>
            <Text fw={600} size="lg">
              All systems up
            </Text>
            <Text size="sm" c="dimmed">
              WAN and gateway both reachable
            </Text>
          </Stack>
        </Group>
      </Card>
    )
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Stack gap="md">
        {!reporting && <NotReportingRow latestTs={latestTs} now={now} />}
        {ongoingOutages.map((outage) => (
          <Group key={outage.id} gap="md" justify="space-between" wrap="wrap">
            <Group gap="md">
              <ThemeIcon size={44} radius="md" color="red" variant="light">
                <IconAlertTriangle size={26} />
              </ThemeIcon>
              <Stack gap={0}>
                <Text fw={600} size="lg" c="red">
                  {SCOPE_LABEL[outage.scope]} in progress
                </Text>
                <Text size="sm" c="dimmed">
                  Started {fmtDateTime(outage.startedAt)} ·{' '}
                  {fmtDuration((now - outage.startedAt) / 1000)} so far
                </Text>
              </Stack>
            </Group>
            <Badge color="red" variant="light">
              {outage.scope}
            </Badge>
          </Group>
        ))}
      </Stack>
    </Card>
  )
}

/**
 * Neither green nor red: nothing is known about the line, which is its own state. Yellow rather
 * than red because a stalled collector is not evidence of an outage — it is evidence that the
 * question is currently unanswerable.
 */
function NotReportingRow({ latestTs, now }: { latestTs: number | null; now: number }) {
  return (
    <Group gap="md" justify="space-between" wrap="wrap">
      <Group gap="md">
        <ThemeIcon size={44} radius="md" color="yellow" variant="light">
          <IconPlugConnectedX size={26} />
        </ThemeIcon>
        <Stack gap={0}>
          <Text fw={600} size="lg" c="yellow.7">
            {latestTs === null
              ? 'No data yet — the collector has never reported'
              : `No data for ${fmtMinutes((now - latestTs) / 1000)} — the collector is not reporting`}
          </Text>
          <Text size="sm" c="dimmed">
            {latestTs === null
              ? 'Nothing has been measured, which is not the same as nothing being wrong.'
              : `Last sample ${fmtDateTime(latestTs)}. Outages are only detected when a cycle arrives, so the line's state is unknown — not up.`}
          </Text>
        </Stack>
      </Group>
      <Badge color="yellow" variant="light">
        no data
      </Badge>
    </Group>
  )
}

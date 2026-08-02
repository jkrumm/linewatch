import { Card, Group, Skeleton, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import { StatCard } from 'basalt-ui'
import { Callout } from 'basalt-ui/content'
import type { RouterSnapshot, StatusSpeedTest, Vantage } from '../lib/types'
import type { RateReading } from '../lib/vantage'
import { compareCarrierHost } from '../lib/vantage'
import { fmtPct, fmtRelative } from '../lib/format'

/**
 * The carrier's sync rate, the host's negotiated link and the last measured throughput, side by
 * side — the three numbers that between them say whether a slow line is the line, the cable, or
 * neither.
 *
 * **Each carries its own age, and the ratio is withheld whenever the two sides disagree about
 * when.** `GET /api/router`'s parts age independently and the poller stores a minority of its due
 * polls, so the carrier figure is routinely tens of minutes old beside a 30-second-old vantage.
 * A percentage across that gap is a disagreement between two moments dressed up as a fact about
 * one. `compareCarrierHost` decides; this file only draws what it returns.
 *
 * **Pending is a skeleton, not a call to `compareCarrierHost` with fabricated inputs.** `router`,
 * `vantage` and `speedTest` come from two independent queries, and `compareCarrierHost` cannot
 * tell "this query hasn't answered" apart from "this source genuinely has nothing" — both arrive
 * as `null`. Gating on all three before that call keeps a merely-loading page from producing one
 * of `compareCarrierHost`'s real, worded refusals (e.g. "the carrier side is unknown") over a
 * request nobody has made yet.
 */
export function LinkComparison({
  router,
  vantage,
  speedTest,
  now,
}: {
  router: RouterSnapshot | null | undefined
  vantage: Vantage | null | undefined
  speedTest: StatusSpeedTest | null | undefined
  /** The dashboard's floored clock, so every age here is quantised like the data. */
  now: number
}) {
  if (router === undefined || vantage === undefined || speedTest === undefined) {
    return (
      <Card py="xs" px="sm">
        <Stack gap="sm">
          <Title order={4}>Router → carrier</Title>
          <Skeleton h={90} />
        </Stack>
      </Card>
    )
  }

  const comparison = compareCarrierHost({ router, vantage, speedTest, now })

  return (
    <Card py="xs" px="sm">
      <Stack gap="md">
        <Stack gap={0}>
          <Title order={4}>Router → carrier</Title>
          <Text size="sm" c="dimmed">
            Carrier sync, host link, and one measured transfer — sharing a unit, nothing else.
          </Text>
        </Stack>

        {router !== null && !router.pollerEnabled ? (
          <Callout kind="info" title="The router poller is off">
            {router.disabledReason ??
              'No reason was recorded. Nothing was asked of the router, which is not the same as the router not answering.'}
          </Callout>
        ) : (
          <>
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
              <ReadingCard reading={comparison.carrier} now={now} />
              <ReadingCard reading={comparison.host} now={now} />
              <ReadingCard reading={comparison.throughput} now={now} />
            </SimpleGrid>

            {comparison.refusal === null && comparison.hostVsCarrierPct !== null ? (
              <Text size="sm">
                The host link is {fmtPct(comparison.hostVsCarrierPct)} of the carrier sync rate.
                Both readings were taken close enough together to describe the same moment.
              </Text>
            ) : (
              <Callout kind="warn" title="No ratio shown">
                {comparison.refusal}
              </Callout>
            )}

            {router !== null && router.configWarning !== null && (
              <Callout kind="warn" title="The poller is running degraded">
                {router.configWarning}
              </Callout>
            )}
          </>
        )}
      </Stack>
    </Card>
  )
}

/**
 * One rate with its own age on the label — the same discipline the Now view's speed cards use. A
 * rate without its age reads as current, and two of these three routinely are not.
 */
function ReadingCard({ reading, now }: { reading: RateReading; now: number }) {
  const age = reading.observedAt === null ? 'never observed' : fmtRelative(reading.observedAt, now)
  const unit = reading.kind === 'measured' ? 'Mbps' : 'Mbit'

  return (
    <Stack gap={4}>
      <StatCard
        label={`${reading.label} · ${age}`}
        value={reading.mbps === null ? '—' : `${reading.mbps.toFixed(reading.mbps < 10 ? 2 : 1)} ${unit}`}
      />
      <Group gap={6}>
        <Text size="xs" c="dimmed">
          {reading.kind === 'measured' ? 'measured throughput' : 'negotiated rate'}
        </Text>
        {/* `stale: null` is not "fresh" — it means the source has no staleness rule (the speed test
            runs hourly). Saying so beats printing nothing, which reads as current. */}
        {reading.stale === true && (
          <Text size="xs" c="orange">
            · history, not a current reading
          </Text>
        )}
        {reading.stale === null && reading.observedAt !== null && (
          <Text size="xs" c="dimmed">
            · no freshness rule applies
          </Text>
        )}
      </Group>
    </Stack>
  )
}

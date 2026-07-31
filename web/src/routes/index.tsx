import { createFileRoute } from '@tanstack/react-router'
import { SimpleGrid, Stack } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { StatCard } from 'basalt-ui'
import { ChartCard } from 'basalt-ui/charts'
import { Callout } from 'basalt-ui/content'
import { probeBucketsQuery, statusQuery, verdictsQuery } from '../lib/queries'
import { StatusBanner } from '../components/status-banner'
import { VerdictPanel } from '../components/verdict-panel'
import { TargetTile } from '../components/target-tile'
import { AvailabilityStrip } from '../charts/availability-strip'
import { TARGETS, type StatusSpeedTest } from '../lib/types'
import { rangeToWindow } from '../lib/range'
import { fmtMbps, fmtMs, fmtRelative } from '../lib/format'

/** 15-minute buckets over 24h ≈ 96 columns for the WAN availability strip. */
const SPARKLINE_BUCKET_SECONDS = 900

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(statusQuery()),
  component: NowPage,
})

function NowPage() {
  const { data: status } = useQuery(statusQuery())
  // Via rangeToWindow, not a raw Date.now(): probeBucketsQuery embeds `from`/`to` in its query key,
  // so an unquantised clock read mints a new key every render and refetches forever. `to` also
  // serves as "now" for relative formatting and for every staleness verdict on this page — it is
  // the clock floored to one probe cycle.
  const { from, to } = rangeToWindow('24h')
  const { data: probeData } = useQuery(
    probeBucketsQuery({
      from,
      to,
      target: 'cloudflare',
      bucket: SPARKLINE_BUCKET_SECONDS,
    }),
  )
  const { data: verdicts } = useQuery(verdictsQuery({ from, to }))

  if (!status) return null

  const sampleByTarget = new Map(status.lastSamples.map((sample) => [sample.target, sample]))

  return (
    <Stack gap="lg">
      <StatusBanner
        ongoingOutages={status.ongoingOutages}
        lastSamples={status.lastSamples}
        now={to}
      />

      {/* Directly under the banner rather than above it: the banner answers "is it working", these
          answer "and here is what the record actually supports". Rendered only once the query has
          resolved — `undefined` is "not fetched yet", and passing it as an empty array would draw
          the "no verdicts" state over a window nobody has evaluated. */}
      {verdicts !== undefined && <VerdictPanel verdicts={verdicts} />}

      <SpeedTestSummary test={status.lastSpeedTest} now={to} />

      <ChartCard
        title="WAN availability"
        subtitle="Cloudflare, last 24h in 15-minute buckets"
        tooltip="One column per 15-minute bucket, always the same number of columns for the window. Darker means more of that bucket's packets were lost, up to 5% which paints full; a solid column is a bucket where every cycle got nothing back. Hatched columns were not measured at all, which is not the same as a bucket with no loss."
      >
        <AvailabilityStrip
          target="cloudflare"
          buckets={probeData?.buckets ?? []}
          from={from}
          to={to}
          bucketSeconds={SPARKLINE_BUCKET_SECONDS}
        />
      </ChartCard>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        {TARGETS.map((target) => (
          <TargetTile
            key={target}
            target={target}
            sample={sampleByTarget.get(target) ?? null}
            now={to}
          />
        ))}
      </SimpleGrid>
    </Stack>
  )
}

/**
 * The last speed test's numbers, with the two things a bare "—" cannot say.
 *
 * `StatusSpeedTest` carries `ok` and `error`, and neither used to be rendered: a run that failed
 * showed three dashes, identical to a deployment where no run has ever happened, identical to a run
 * still in flight. Those are three different situations and only one of them is a reason to look at
 * the line. The age rides on the labels rather than in a fourth card, because a throughput number
 * without its age is the same class of claim as a stale target tile — it reads as current.
 */
function SpeedTestSummary({ test, now }: { test: StatusSpeedTest | null; now: number }) {
  // Only a successful run's numbers get an age: attaching one to a failed run's dashes would date a
  // measurement that does not exist.
  const suffix = test !== null && test.ok ? ` · ${fmtRelative(test.ts, now)}` : ''

  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md">
        <StatCard label={`Download${suffix}`} value={fmtMbps(test?.downloadMbps ?? null)} />
        <StatCard label={`Upload${suffix}`} value={fmtMbps(test?.uploadMbps ?? null)} />
        <StatCard label={`Idle ping${suffix}`} value={fmtMs(test?.pingMs ?? null)} />
      </SimpleGrid>
      {test === null && (
        <Callout kind="info" title="No speed test on record">
          Nothing has been measured yet — the numbers above are absent, not zero.
        </Callout>
      )}
      {test !== null && !test.ok && (
        <Callout kind="bad" title={`Last speed test failed ${fmtRelative(test.ts, now)}`}>
          {test.error ?? 'The run recorded no error message, so why it failed is unknown.'}
        </Callout>
      )}
    </Stack>
  )
}

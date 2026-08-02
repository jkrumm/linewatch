import { Elysia } from 'elysia'
import { z } from 'zod'
import { db } from '../db/client.js'
import { MAX_INTERVAL_MS, bucketThroughput } from '../db/bucket-throughput.js'

/**
 * How much the line actually carried, over time — as opposed to how much it
 * *could* carry, which is what the speed tests measure.
 *
 * The two are routinely confused and answer different questions. A speed test
 * says the line can do 550 Mbit; this says 517 GB came down it last month and
 * that most of it arrived between 20:00 and 23:00. Neither substitutes for the
 * other, and a dashboard that only has the first cannot tell a quiet line from
 * a broken one.
 *
 * Derived from `probe_cycle`'s cumulative `if_ibytes`/`if_obytes`, which the
 * collector already reads every cycle out of the same `netstat -I <if> -b` row
 * as its error counters — so this costs no new sampler, no new process and no
 * new command. What it costs instead is resolution: the differencing interval is
 * the 30 s probe cycle, so this is a smoothed rate and cannot show a burst. It
 * is a history, and a history does not need to.
 *
 * **Every bucket reports its own completeness**, because the honest answer to a
 * counter reset, an interface failover or a long gap is "unknown", not zero —
 * see `bucketThroughput` for the three refusals. `spanMs` is the measured time
 * behind the bytes and is the only correct denominator for a rate; the bucket's
 * own width is not, since a bucket may have measured a fraction of itself.
 */
const ThroughputBucketSchema = z.object({
  bucket: z.number().int().describe('Bucket-start timestamp, unix ms'),
  inBytes: z.number().int().describe('Bytes received over the accepted intervals in this bucket'),
  outBytes: z.number().int(),
  spanMs: z
    .number()
    .int()
    .describe(
      'Milliseconds of measured time the bytes cover — the denominator for a rate. NOT the bucket width: a bucket with one accepted interval out of twenty covers 30 s of a 10-minute slot, and dividing by the slot understates the rate twentyfold.',
    ),
  intervals: z.number().int().describe('Cycle-to-cycle intervals whose byte delta was usable'),
  skipped: z
    .number()
    .int()
    .describe(
      'Intervals refused: the interface changed, the counter went backwards (a reboot), or the gap between cycles was too long to place the bytes in time. A non-zero value means this bucket UNDERSTATES what moved — it never means the line was idle.',
    ),
})

export const throughputRoutes = new Elysia().get(
  '/api/throughput',
  ({ query }) => ({
    from: query.from,
    to: query.to,
    bucketSeconds: query.bucket,
    maxIntervalMs: MAX_INTERVAL_MS,
    buckets: bucketThroughput(db, { from: query.from, to: query.to, bucketSeconds: query.bucket }),
  }),
  {
    query: z.object({
      from: z.coerce.number().int(),
      to: z.coerce.number().int(),
      bucket: z.coerce.number().int().min(1).default(3600).describe('Bucket width in seconds (default 3600 = hourly)'),
    }),
    response: z.object({
      from: z.number().int(),
      to: z.number().int(),
      bucketSeconds: z.number().int(),
      maxIntervalMs: z
        .number()
        .int()
        .describe('Longest cycle-to-cycle gap whose bytes are still attributed to a point in time; longer intervals count toward `skipped`.'),
      buckets: z.array(ThroughputBucketSchema),
    }),
    detail: {
      tags: ['Probes'],
      summary: 'Volume actually carried, bucketed',
      description:
        "How many bytes crossed the default-route interface, bucketed in SQL by `floor(ts / (bucket*1000))` — never raw rows. Differenced from `probe_cycle`'s cumulative `if_ibytes`/`if_obytes`, which the collector reads every 30 s cycle from the same `netstat -I <if> -b` row as its error counters, so the resolution is the probe cycle: this is a smoothed rate and will not show a sub-30 s burst. It answers a different question from `/api/speedtests` — what the line *carried*, not what it *could carry*. An interval is refused, and counted in `skipped` rather than treated as zero, when the default-route interface changed between cycles (the counters are per interface), when a counter went backwards (a reboot resets them to zero), or when the gap exceeded `maxIntervalMs` (the volume is still accurate but the moment it moved is not, and attributing hours of traffic to one bucket would draw a spike that never happened). A bucket with `skipped > 0` therefore understates what moved and never claims an idle line. Divide `inBytes` by `spanMs`, never by the bucket width — a bucket may have measured only a fraction of itself.",
    },
  },
)

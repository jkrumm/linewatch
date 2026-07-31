import { Elysia } from 'elysia'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'

/**
 * The Wi-Fi radio history: **an alternate radio path currently attached**,
 * measured every 10th probe cycle (5 min) rather than inferred.
 *
 * The phrasing above is the honest one and the shorter ones are wrong. This is
 * not "the standby path": `networksetup -listnetworkserviceorder` on the
 * collector host ranks Ethernet first, then a **cellular hotspot**, and only
 * then Wi-Fi. Wi-Fi is what a failover would reach today only because neither
 * cellular device is attached.
 *
 * Two properties are load-bearing:
 *
 * 1. **Bucketed in SQL**, like every other range route here. `wifi_sample`
 *    grows by 288 rows a day, ~105k a year — three orders of magnitude below
 *    `probe_sample`, but the rule does not have an exemption for small tables.
 * 2. **Nothing here is throughput.** `txRateMbpsAvg` is the negotiated PHY/MCS
 *    rate; the only end-to-end number is `rttMedMsAvg`, and measured, that was
 *    9.99 ms on Wi-Fi against 5.24 ms on Ethernet. No response field supports a
 *    "the radio is faster than the wire" claim and none may be presented as one.
 *
 * `snrDbAvg` is derived on read and stored nowhere — SQLite's `rssi - noise` is
 * NULL when either side is, and `AVG` skips NULLs, so it averages exactly the
 * samples that measured both.
 */

const WifiBucketSchema = z.object({
  bucket: z.number().int(),
  samples: z.number().int().describe('Wi-Fi samples in this bucket — one per 10th probe cycle'),
  firstTs: z.number().int(),
  lastTs: z.number().int(),
  connectedSamples: z
    .number()
    .int()
    .describe('…of which this many reported `status: Connected`. Fewer than `samples` means the radio was associated for only part of the bucket.'),
  ifaces: z.array(z.string()),
  statuses: z.array(z.string()).describe('Distinct statuses seen, verbatim — more than one means the radio changed state inside the bucket'),
  phyModes: z
    .array(z.string())
    .describe('Distinct PHY modes seen. More than one is reported as both rather than averaged into a mode that never existed.'),
  bands: z.array(z.string()).describe('Distinct bands seen — more than one means the radio changed band inside the bucket'),
  channelMax: z.number().int().nullable().describe('Highest channel number seen; channels are labels, so they are never averaged'),
  widthMhzMax: z.number().int().nullable(),
  rssiDbmAvg: z.number().nullable(),
  noiseDbmAvg: z.number().nullable(),
  snrDbAvg: z
    .number()
    .nullable()
    .describe('Average of `rssi - noise`, computed on read over the samples that measured both. Never stored, and null when no sample did.'),
  txRateMbpsAvg: z
    .number()
    .nullable()
    .describe('Average negotiated PHY/MCS rate — **not** throughput and not comparable with a speed test'),
  rttMedMsAvg: z.number().nullable().describe('Average of the per-sample median RTT from a ping bound to the interface'),
  lossPctAvg: z.number().nullable(),
})

interface WifiBucketRow {
  bucket: number
  samples: number
  first_ts: number
  last_ts: number
  connected_samples: number
  ifaces: string | null
  statuses: string | null
  phy_modes: string | null
  bands: string | null
  channel_max: number | null
  width_max: number | null
  rssi_avg: number | null
  noise_avg: number | null
  snr_avg: number | null
  tx_rate_avg: number | null
  rtt_avg: number | null
  loss_avg: number | null
}

/** Splits a `group_concat(DISTINCT …)` result. Empty/absent means every value was NULL. */
function splitDistinct(value: string | null): string[] {
  if (!value) return []
  return value
    .split(',')
    .filter((part) => part.length > 0)
    .sort()
}

/** Rounds to `places` decimals, or stays null. dBm is measured whole, so an average gets one decimal. */
function roundOrNull(value: number | null, places: number): number | null {
  if (value === null) return null
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

export const wifiRoutes = new Elysia().get(
  '/api/wifi',
  ({ query }) => {
    const bucketMs = Math.max(1, Math.round(query.bucket * 1000))

    const rows = db.all<WifiBucketRow>(sql`
      SELECT
        (ts / ${bucketMs}) * ${bucketMs} AS bucket,
        COUNT(*) AS samples,
        MIN(ts) AS first_ts,
        MAX(ts) AS last_ts,
        SUM(CASE WHEN status = 'Connected' THEN 1 ELSE 0 END) AS connected_samples,
        -- group_concat(DISTINCT x) skips NULLs, which is right: an unreported
        -- band is not a band the radio was ever on.
        group_concat(DISTINCT iface) AS ifaces,
        group_concat(DISTINCT status) AS statuses,
        group_concat(DISTINCT phy_mode) AS phy_modes,
        group_concat(DISTINCT band) AS bands,
        -- MAX, not AVG: a channel is a label. The mean of channel 3 and channel
        -- 44 is channel 23.5, which is a number the radio was never on.
        MAX(channel) AS channel_max,
        MAX(width_mhz) AS width_max,
        AVG(rssi_dbm) AS rssi_avg,
        AVG(noise_dbm) AS noise_avg,
        -- Derived here and stored nowhere. NULL on either side makes the
        -- difference NULL, and AVG skips it — so this averages exactly the
        -- samples that measured both, never a half-known one.
        AVG(rssi_dbm - noise_dbm) AS snr_avg,
        AVG(tx_rate_mbps) AS tx_rate_avg,
        AVG(rtt_med_ms) AS rtt_avg,
        AVG(loss_pct) AS loss_avg
      FROM wifi_sample
      WHERE ts >= ${query.from} AND ts <= ${query.to}
      GROUP BY bucket
      ORDER BY bucket
    `)

    return {
      from: query.from,
      to: query.to,
      bucketSeconds: query.bucket,
      buckets: rows.map((row) => ({
        bucket: row.bucket,
        samples: row.samples,
        firstTs: row.first_ts,
        lastTs: row.last_ts,
        connectedSamples: row.connected_samples,
        ifaces: splitDistinct(row.ifaces),
        statuses: splitDistinct(row.statuses),
        phyModes: splitDistinct(row.phy_modes),
        bands: splitDistinct(row.bands),
        channelMax: row.channel_max,
        widthMhzMax: row.width_max,
        rssiDbmAvg: roundOrNull(row.rssi_avg, 1),
        noiseDbmAvg: roundOrNull(row.noise_avg, 1),
        snrDbAvg: roundOrNull(row.snr_avg, 1),
        txRateMbpsAvg: roundOrNull(row.tx_rate_avg, 1),
        rttMedMsAvg: roundOrNull(row.rtt_avg, 2),
        lossPctAvg: roundOrNull(row.loss_avg, 2),
      })),
    }
  },
  {
    query: z.object({
      from: z.coerce.number().int(),
      to: z.coerce.number().int(),
      bucket: z.coerce.number().int().min(1).default(300).describe('Bucket width in seconds (default 300 = the sampling cadence)'),
    }),
    response: z.object({
      from: z.number().int(),
      to: z.number().int(),
      bucketSeconds: z.number().int(),
      buckets: z.array(WifiBucketSchema),
    }),
    detail: {
      tags: ['Status'],
      summary: 'Wi-Fi radio history',
      description:
        'Signal, noise, negotiated PHY rate and interface-bound round trips for an alternate radio path currently attached, bucketed in SQL by `floor(ts / (bucket*1000))` — never raw rows. Sampled every 10th probe cycle (5 min) because `system_profiler SPAirPortDataType` costs ~4.8 s, so a 30-day range at the default 300 s bucket returns at most one row per sample taken. Signal strength averages; band, PHY mode and status do not — those come back as the distinct values seen, so a bucket spanning a band change says so instead of hiding it. `snrDb` is derived on read from `rssi - noise` over the samples that measured both, and is stored nowhere. **`txRateMbps` is the negotiated PHY/MCS rate, not throughput**: measured, the radio negotiated 229 Mbit while its round trip was 9.99 ms against Ethernet\'s 5.24 ms, so nothing here supports calling the radio path faster. The response deliberately carries no network name and no hardware address — those columns do not exist.',
    },
  },
)

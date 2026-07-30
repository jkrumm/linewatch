import { Elysia } from 'elysia'
import { z } from 'zod'
import { db } from '../db/client.js'
import { readRouterSnapshot } from '../services/router/poll.js'
import { bucketRouterLine, bucketRouterThroughput, isRangeError, MAX_BUCKETS, resolveRange } from '../services/router/range.js'
import { routerConfig } from '../services/router/config.js'

/**
 * Router reads. Open like every other read route.
 *
 * These rows are the carrier-side counterpart to the host-side probe record:
 * sync rate is the ceiling the probes live under, noise margin is the early
 * warning, and the per-interface rates show household load without generating
 * any. Nothing here can be written through this API — the poller is read-only
 * against the router and these routes are read-only against its record.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * 1. `GET /api/router` never presents a stored reading as a current one. Each
 *    part carries its own `observedAt`/`ageMs`/`stale`, because during a WAN
 *    outage the LAN half keeps updating while the WAN half stops, and the
 *    difference is invisible without it.
 * 2. The range routes bucket in SQL and never truncate. `router_line_sample`
 *    and `router_intf_sample` grow by ~315k rows a year between them.
 */

const ObservationMeta = {
  observedAt: z.number().int().describe('Unix ms of the poll that produced this value'),
  ageMs: z.number().int().describe('Age of the value when the snapshot was taken'),
  stale: z
    .boolean()
    .describe('True when ageMs exceeds staleAfterMs — the value is history, not a current reading'),
}

/** Wraps a value in the observation envelope every part of `GET /api/router` carries. */
function observation<T extends z.ZodTypeAny>(value: T) {
  return z.object({ ...ObservationMeta, value })
}

const LineSampleSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  carrier: z.enum(['gfast', 'dsl', 'gpon']).nullable(),
  status: z.string().nullable(),
  downSyncKbps: z.number().int().nullable(),
  upSyncKbps: z.number().int().nullable(),
  downCurrKbps: z.number().int().nullable(),
  upCurrKbps: z.number().int().nullable(),
  downNoiseMarginDb: z.number().nullable(),
  upNoiseMarginDb: z.number().nullable(),
  downAttenuationDb: z.number().nullable(),
  profile: z.string().nullable(),
  showtimeStartS: z.number().int().nullable(),
  erroredSecs: z.number().int().nullable(),
  severelyErroredSecs: z.number().int().nullable(),
})

const IntfSampleSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  name: z.string(),
  stack: z.number().int().nullable(),
  role: z.enum(['wan', 'lan', 'other']).nullable(),
  rxKbps: z.number().int().nullable(),
  txKbps: z.number().int().nullable(),
  bytesRx: z.number().int().nullable(),
  bytesTx: z.number().int().nullable(),
})

const EthPortSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  name: z.string().nullable(),
  alias: z.string().nullable(),
  status: z.string().nullable(),
  maxBitRate: z.number().int().nullable(),
  duplexMode: z.string().nullable(),
})

const HostSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  ip: z.string().nullable(),
  interfaceType: z.string().nullable(),
  active: z.number().int().nullable(),
  clientType: z.string().nullable(),
  hostName: z.string().nullable(),
})

const LineBucketSchema = z.object({
  bucket: z.number().int(),
  samples: z.number().int(),
  firstTs: z.number().int(),
  lastTs: z.number().int(),
  statuses: z.array(z.string()).describe('Distinct statuses in the bucket — more than one means the line changed state inside it'),
  upSamples: z.number().int(),
  carriers: z.array(z.string()),
  profiles: z.array(z.string()),
  downSyncKbpsMin: z.number().int().nullable(),
  downSyncKbpsAvg: z.number().int().nullable(),
  downSyncKbpsMax: z.number().int().nullable(),
  upSyncKbpsMin: z.number().int().nullable(),
  upSyncKbpsAvg: z.number().int().nullable(),
  upSyncKbpsMax: z.number().int().nullable(),
  downCurrKbpsAvg: z.number().int().nullable(),
  upCurrKbpsAvg: z.number().int().nullable(),
  downNoiseMarginDbMin: z.number().nullable().describe('Worst noise margin in the bucket — the early-warning number the average hides'),
  downNoiseMarginDbAvg: z.number().nullable(),
  upNoiseMarginDbMin: z.number().nullable(),
  upNoiseMarginDbAvg: z.number().nullable(),
  downAttenuationDbAvg: z.number().nullable(),
  resyncs: z.number().int().describe('Polls where showtime_start_s dropped below the previous poll — the line restarted'),
  erroredSecsMax: z.number().int().nullable(),
  severelyErroredSecsMax: z.number().int().nullable(),
})

const ThroughputBucketSchema = z.object({
  bucket: z.number().int(),
  role: z.enum(['wan', 'lan', 'other']).nullable(),
  samples: z.number().int(),
  firstTs: z.number().int(),
  lastTs: z.number().int(),
  names: z.array(z.string()),
  rxKbpsAvg: z.number().int().nullable(),
  rxKbpsMax: z.number().int().nullable(),
  txKbpsAvg: z.number().int().nullable(),
  txKbpsMax: z.number().int().nullable(),
  bytesRxDelta: z.number().int().describe('Bytes moved inside the bucket, from consecutive counter deltas'),
  bytesTxDelta: z.number().int(),
})

const RangeMetaSchema = {
  from: z.number().int(),
  to: z.number().int(),
  bucketSeconds: z.number().int(),
}

const RangeErrorSchema = z.object({
  error: z.enum(['invalid_range', 'range_too_fine']),
  message: z.string(),
  from: z.number().int(),
  to: z.number().int(),
  bucketSeconds: z.number().int(),
  /** How many buckets the request asked for, when that is what made it invalid. */
  buckets: z.number().int().nullable(),
  maxBuckets: z.number().int(),
})

const RangeQuery = z.object({
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  bucket: z.coerce.number().int().min(1).default(3600).describe('Bucket width in seconds (default 3600 = hourly)'),
})

type RangeError = z.infer<typeof RangeErrorSchema>

interface ResolvedRange {
  from: number
  to: number
  bucketSeconds: number
}

/**
 * Turns the query into a range, or into the reason it cannot be one. Both
 * failures are explicit 400s: the alternative — clamping the range or widening
 * the bucket on the caller's behalf — answers a question that was not asked and
 * looks exactly like a complete answer.
 */
function resolveRange(query: z.infer<typeof RangeQuery>): ResolvedRange | RangeError {
  const to = query.to ?? Date.now()
  const from = query.from ?? to - DEFAULT_WINDOW_MS
  const bucketSeconds = query.bucket

  if (from > to) {
    return {
      error: 'invalid_range',
      message: `from (${from}) is after to (${to})`,
      from,
      to,
      bucketSeconds,
      buckets: null,
      maxBuckets: MAX_BUCKETS,
    }
  }

  const buckets = Math.ceil((to - from) / (bucketSeconds * 1000))
  if (buckets > MAX_BUCKETS) {
    return {
      error: 'range_too_fine',
      message: `${buckets} buckets requested (max ${MAX_BUCKETS}) — widen \`bucket\` or shorten the range`,
      from,
      to,
      bucketSeconds,
      buckets,
      maxBuckets: MAX_BUCKETS,
    }
  }

  return { from, to, bucketSeconds }
}

function isRangeError(value: ResolvedRange | RangeError): value is RangeError {
  return 'error' in value
}

export const routerRoutes = new Elysia()
  .get(
    '/api/router',
    () => {
      const snapshot = readRouterSnapshot(db, {
        collectorHostIp: routerConfig.collectorHostIp,
        staleAfterMs: routerConfig.staleAfterMs,
      })
      return {
        pollerEnabled: routerConfig.enabled,
        disabledReason: routerConfig.disabledReason,
        configWarning: routerConfig.configWarning,
        collectorHostIp: routerConfig.collectorHostIp,
        pollIntervalMs: routerConfig.pollIntervalMs,
        now: snapshot.now,
        staleAfterMs: snapshot.staleAfterMs,
        line: snapshot.line,
        wan: snapshot.wan,
        lan: snapshot.lan,
        collectorHost: snapshot.collector,
        ports: snapshot.ports,
      }
    },
    {
      response: z.object({
        pollerEnabled: z.boolean(),
        disabledReason: z.string().nullable(),
        configWarning: z.string().nullable(),
        collectorHostIp: z.string(),
        pollIntervalMs: z.number().int(),
        now: z.number().int(),
        staleAfterMs: z.number().int(),
        line: observation(LineSampleSchema).nullable(),
        wan: observation(IntfSampleSchema).nullable(),
        lan: observation(IntfSampleSchema).nullable(),
        collectorHost: observation(HostSchema).nullable(),
        ports: observation(z.array(EthPortSchema)).nullable(),
      }),
      detail: {
        tags: ['Router'],
        summary: 'Latest router reading',
        description:
          'Most recent carrier-side line sample, WAN/LAN throughput, the router-side view of the collector host, and every LAN port from the latest poll. Each part comes from its own latest row and carries its own `observedAt`/`ageMs`/`stale`: a poll where one OID was refused writes some tables and not others, and during a WAN outage no `role: wan` row is written at all while the LAN bridge keeps updating. `stale: true` means the value is older than `staleAfterMs` (two poll intervals) and describes the past, not now — it is never silently substituted for a current reading. Disagreements between this and the host-side `probe_cycle` vantage are materialised into `GET /api/events` as `link_change` at poll time, not recomputed here.',
      },
    },
  )
  .get(
    '/api/router/line',
    ({ query, status }) => {
      const range = resolveRange(query)
      if (isRangeError(range)) return status(400, range)
      return {
        from: range.from,
        to: range.to,
        bucketSeconds: range.bucketSeconds,
        buckets: bucketRouterLine(db, range),
      }
    },
    {
      query: RangeQuery,
      response: {
        200: z.object({ ...RangeMetaSchema, buckets: z.array(LineBucketSchema) }),
        400: RangeErrorSchema,
      },
      detail: {
        tags: ['Router'],
        summary: 'Carrier line history',
        description:
          'Sync rates, noise margin (real dB — the router reports tenths and the poller converts at the write site), attenuation, profile and line resyncs, bucketed in SQL by `floor(ts / (bucket*1000))`. Never raw rows: `router_line_sample` grows by ~105k rows a year. Defaults to the last 24 hours at hourly buckets. Sync rate and noise margin keep a `min` beside the average because the average is what hides a five-minute drop. A range needing more than 20000 buckets is refused with a 400 rather than truncated.',
      },
    },
  )
  .get(
    '/api/router/throughput',
    ({ query, status }) => {
      const range = resolveRange(query)
      if (isRangeError(range)) return status(400, range)
      return {
        from: range.from,
        to: range.to,
        bucketSeconds: range.bucketSeconds,
        buckets: bucketRouterThroughput(db, { ...range, ...(query.role === undefined ? {} : { role: query.role }) }),
      }
    },
    {
      query: RangeQuery.extend({ role: z.enum(['wan', 'lan', 'other']).optional() }),
      response: {
        200: z.object({ ...RangeMetaSchema, buckets: z.array(ThroughputBucketSchema) }),
        400: RangeErrorSchema,
      },
      detail: {
        tags: ['Router'],
        summary: 'Per-interface throughput history',
        description:
          "Router-side interface rates, bucketed in SQL — one row per bucket per role, never raw rows. `role: wan` is the live internet-facing interface, resolved by name from the router's own connection table rather than by index; on that row `rxKbps` is the downstream direction. `rxKbpsAvg`/`rxKbpsMax` average the router's own ~30s spot rates; `bytesRxDelta`/`bytesTxDelta` sum consecutive counter deltas and are the figures that cover the whole bucket. Load measured this way costs no traffic, so a latency spike can be attributed to the household saturating the uplink instead of the line degrading. A range needing more than 20000 buckets is refused with a 400 rather than truncated.",
      },
    },
  )

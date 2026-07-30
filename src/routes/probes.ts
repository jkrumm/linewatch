import { Elysia } from 'elysia'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { bucketProbes, bucketVantage } from '../db/bucket-probes.js'
import { db } from '../db/client.js'
import { probeSample } from '../db/schema.js'
import { config } from '../config.js'
import { hasValidBearer } from '../lib/auth.js'
import { outageDetector } from '../services/outage-detector-instance.js'
import type { TargetCycleResult } from '../services/outage-detector.js'
import { recordCycleVantage } from '../services/cycle-vantage.js'

const SampleInput = z.object({
  target: z.string(),
  addr: z.string(),
  sent: z.number().int(),
  received: z.number().int(),
  lossPct: z.number(),
  minMs: z.number().nullable(),
  medMs: z.number().nullable(),
  maxMs: z.number().nullable(),
  avgMs: z.number().nullable(),
  jitterMs: z.number().nullable(),
  samples: z.array(z.number()).nullable().optional(),
  // Optional, not required: the native collector and the container deploy
  // independently, and collector/spool.jsonl can hold batches written before
  // these fields existed. A required field here would reject that replay and
  // lose real measurements — the exact hole the spool exists to prevent.
  duplicates: z.number().int().min(0).optional(),
  outOfWaitTime: z.number().int().min(0).optional(),
})

/**
 * What the cycle measured *through* — one per batch, not per sample, because the
 * vantage is a property of the cycle (see the `probe_cycle` doc comment).
 *
 * Optional for the same reason every field inside it is nullable: a collector
 * predating the vantage, or a spooled batch written by one, must still ingest.
 * An absent `cycle` writes no `probe_cycle` row at all, which reads downstream
 * as "unknown" — never as "the home line over Ethernet".
 */
const CycleInput = z.object({
  pathIf: z.string().nullable().optional(),
  pathClass: z.enum(['ethernet', 'wifi', 'cellular', 'other']).nullable().optional(),
  linkMedia: z.string().nullable().optional(),
  linkMbit: z.number().int().nullable().optional(),
  linkDuplex: z.enum(['full', 'half']).nullable().optional(),
  gatewayAddr: z.string().nullable().optional(),
  ifIerrs: z.number().int().min(0).nullable().optional(),
  ifOerrs: z.number().int().min(0).nullable().optional(),
  ifColl: z.number().int().min(0).nullable().optional(),
  // The collector's own verdict. Accepted as 0/1 (what collector/vantage.ts
  // sends, mirroring the SQLite column) or as a boolean, because rejecting one
  // spelling of a field that is *optional anyway* would fail the whole batch and
  // lose four real probe samples over a formatting disagreement.
  //
  // The server re-derives the verdict from pathClass + gatewayAddr whenever both
  // are present and takes the stricter of the two — "which gateway is home" is
  // server config, so the server gets the last word.
  onHomeLine: z.union([z.boolean(), z.literal(0), z.literal(1)]).nullable().optional(),
})

const IngestBody = z.object({
  ts: z.number().int(),
  samples: z.array(SampleInput).min(1),
  cycle: CycleInput.optional(),
})

const HomeLineVerdictSchema = z
  .enum(['all', 'none', 'mixed', 'unknown'])
  .describe(
    'all = every recorded cycle in the bucket reported on_home_line=1; none = every cycle reported 0; unknown = no cycle reported it; mixed = anything else, including unreported cycles alongside reported ones. Only `all` claims the whole bucket — never treat `unknown` as `all`.',
  )

const VantageBucketSchema = z.object({
  bucket: z.number().int(),
  cycles: z.number().int().describe('Distinct cycle timestamps with probe samples in this bucket'),
  vantageCycles: z.number().int().describe('…of which this many recorded a vantage at all'),
  pathClasses: z.array(z.string()).describe('Distinct path classes seen — more than one means the path changed mid-bucket'),
  linkMbits: z.array(z.number().int()).describe('Distinct negotiated link speeds seen — more than one means the NIC renegotiated'),
  pathIfs: z.array(z.string()),
  onHomeLine: HomeLineVerdictSchema,
  homeLineCycles: z.number().int(),
  offHomeLineCycles: z.number().int(),
  unknownHomeLineCycles: z.number().int(),
})

const ProbeBucketSchema = z.object({
  bucket: z.number().int(),
  target: z.string(),
  medianMs: z.number().nullable(),
  p5Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  minMs: z.number().nullable(),
  maxMs: z.number().nullable(),
  maxLossPct: z.number(),
  lossPct: z.number(),
  downCycles: z.number().int(),
  count: z.number().int(),
})

export const probesRoutes = new Elysia()
  .post(
    '/api/probes',
    ({ body, headers, status }) => {
      if (!hasValidBearer(headers)) return status(401, 'Unauthorized')

      // Idempotency: a spool replay resends an already-ingested cycle
      // verbatim. One POST is always exactly one cycle (one `ts`, every
      // target) — see collector/probe.ts — so "a row for this ts already
      // exists" means the whole batch was already recorded.
      const existing = db.select({ id: probeSample.id }).from(probeSample).where(eq(probeSample.ts, body.ts)).limit(1).all()
      if (existing.length > 0) {
        return { ok: true as const, inserted: 0, skipped: true, linkChange: false }
      }

      db.insert(probeSample)
        .values(
          body.samples.map((sample) => ({
            ts: body.ts,
            target: sample.target,
            addr: sample.addr,
            sent: sample.sent,
            received: sample.received,
            lossPct: sample.lossPct,
            minMs: sample.minMs,
            medMs: sample.medMs,
            maxMs: sample.maxMs,
            avgMs: sample.avgMs,
            jitterMs: sample.jitterMs,
            samples: sample.samples ? JSON.stringify(sample.samples) : null,
            duplicates: sample.duplicates ?? null,
            outOfWaitTime: sample.outOfWaitTime ?? null,
          })),
        )
        .run()

      // Written before the outage machine runs so that if a link_change and an
      // outage land on the same cycle, the timeline already carries the cause.
      const cycle = body.cycle
        ? recordCycleVantage(db, { ts: body.ts, vantage: body.cycle, homeGatewayAddr: config.homeGatewayAddr })
        : { inserted: false, linkChangeEventId: null }

      const cycleResults: TargetCycleResult[] = body.samples.map((sample) => ({
        target: sample.target,
        scope: config.targets.find((t) => t.name === sample.target)?.scope ?? 'wan',
        down: sample.received === 0,
      }))
      outageDetector.ingest(body.ts, cycleResults)

      return { ok: true as const, inserted: body.samples.length, skipped: false, linkChange: cycle.linkChangeEventId !== null }
    },
    {
      body: IngestBody,
      response: {
        200: z.object({
          ok: z.literal(true),
          inserted: z.number().int(),
          skipped: z.boolean(),
          linkChange: z.boolean().describe('true when this cycle materialised a `link_change` event'),
        }),
        401: z.string(),
      },
      detail: {
        tags: ['Probes'],
        summary: 'Ingest one probe cycle',
        description:
          'Batch ingest from the native collector: one cycle timestamp plus one sample per target, plus an optional `cycle` object recording what the cycle measured *through* (interface, path class, negotiated link, gateway, NIC error counters). Idempotent — replaying an already-ingested `ts` is a no-op (`skipped: true`), and `probe_cycle.ts` is UNIQUE so a replayed vantage cannot duplicate either. Feeds the outage state machine and materialises `link_change` events.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .get(
    '/api/probes',
    ({ query }) => {
      const params = {
        from: query.from,
        to: query.to,
        bucketSeconds: query.bucket,
        ...(query.target !== undefined ? { target: query.target } : {}),
      }
      return {
        buckets: bucketProbes(db, params),
        // Separate series, one row per bucket: the vantage belongs to the cycle,
        // so folding it into `buckets` would repeat it once per target.
        vantage: bucketVantage(db, params),
      }
    },
    {
      query: z.object({
        from: z.coerce.number().int(),
        to: z.coerce.number().int(),
        target: z.string().optional(),
        bucket: z.coerce.number().int().min(1).default(3600),
      }),
      response: z.object({ buckets: z.array(ProbeBucketSchema), vantage: z.array(VantageBucketSchema) }),
      detail: {
        tags: ['Probes'],
        summary: 'Server-bucketed probe timeseries',
        description:
          'Buckets probe_sample rows in SQL — never raw rows — grouping by `floor(ts / (bucket*1000))` per target. Each bucket returns the median-of-medians, a p5/p95 band over those medians, the true min/max round trip for the SmokePing spread band, and the sample count. Two loss figures: `lossPct` is the sent-weighted aggregate (availability = `100 - lossPct`), `maxLossPct` is the worst single cycle, and `downCycles` counts cycles with nothing returned. `bucket` is in seconds (default 3600 = hourly). The parallel `vantage` array carries one row per bucket describing what those cycles measured *through* — distinct path classes and link speeds, and whether the whole bucket was on the home line. A bucket mixing Ethernet and Wi-Fi reports both classes and `onHomeLine: "mixed"`; it is never flattened to a majority.',
      },
    },
  )

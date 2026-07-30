import { Elysia } from 'elysia'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { bucketProbes } from '../db/bucket-probes.js'
import { db } from '../db/client.js'
import { probeSample } from '../db/schema.js'
import { config } from '../config.js'
import { hasValidBearer } from '../lib/auth.js'
import { outageDetector } from '../services/outage-detector-instance.js'
import type { TargetCycleResult } from '../services/outage-detector.js'

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
})

const IngestBody = z.object({
  ts: z.number().int(),
  samples: z.array(SampleInput).min(1),
})

const ProbeBucketSchema = z.object({
  bucket: z.number().int(),
  target: z.string(),
  medianMs: z.number().nullable(),
  p5Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  maxLossPct: z.number(),
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
        return { ok: true as const, inserted: 0, skipped: true }
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
          })),
        )
        .run()

      const cycleResults: TargetCycleResult[] = body.samples.map((sample) => ({
        target: sample.target,
        scope: config.targets.find((t) => t.name === sample.target)?.scope ?? 'wan',
        down: sample.received === 0,
      }))
      outageDetector.ingest(body.ts, cycleResults)

      return { ok: true as const, inserted: body.samples.length, skipped: false }
    },
    {
      body: IngestBody,
      response: {
        200: z.object({ ok: z.literal(true), inserted: z.number().int(), skipped: z.boolean() }),
        401: z.string(),
      },
      detail: {
        tags: ['Probes'],
        summary: 'Ingest one probe cycle',
        description:
          'Batch ingest from the native collector: one cycle timestamp plus one sample per target. Idempotent — replaying an already-ingested `ts` is a no-op (`skipped: true`). Feeds the outage state machine.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .get(
    '/api/probes',
    ({ query }) => ({
      buckets: bucketProbes(db, {
        from: query.from,
        to: query.to,
        bucketSeconds: query.bucket,
        ...(query.target !== undefined ? { target: query.target } : {}),
      }),
    }),
    {
      query: z.object({
        from: z.coerce.number().int(),
        to: z.coerce.number().int(),
        target: z.string().optional(),
        bucket: z.coerce.number().int().min(1).default(3600),
      }),
      response: z.object({ buckets: z.array(ProbeBucketSchema) }),
      detail: {
        tags: ['Probes'],
        summary: 'Server-bucketed probe timeseries',
        description:
          'Buckets probe_sample rows in SQL — never raw rows — grouping by `floor(ts / (bucket*1000))` per target. Each bucket returns the median-of-medians, a p5/p95 band, max packet loss, and the sample count, for the SmokePing-style latency chart. `bucket` is in seconds (default 3600 = hourly).',
      },
    },
  )

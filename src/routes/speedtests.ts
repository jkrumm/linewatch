import { Elysia } from 'elysia'
import { z } from 'zod'
import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { speedTest } from '../db/schema.js'
import { percentile } from '../lib/stats.js'
import { hasValidBearer } from '../lib/auth.js'
import { triggerSpeedtestNow } from '../services/speedtest-runner.js'

const SpeedTestSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  backend: z.enum(['ookla', 'cloudflare']),
  ok: z.boolean(),
  downloadMbps: z.number().nullable(),
  uploadMbps: z.number().nullable(),
  pingMs: z.number().nullable(),
  jitterMs: z.number().nullable(),
  latencyDownMs: z.number().nullable(),
  latencyUpMs: z.number().nullable(),
  packetLoss: z.number().nullable(),
  serverName: z.string().nullable(),
  serverLocation: z.string().nullable(),
  serverId: z.string().nullable(),
  isp: z.string().nullable(),
  externalIp: z.string().nullable(),
  bytesDown: z.number().int().nullable(),
  bytesUp: z.number().int().nullable(),
  resultUrl: z.string().nullable(),
  durationS: z.number().nullable(),
  error: z.string().nullable(),
})

const DirectionSummarySchema = z.object({
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  best: z.number().nullable(),
  worst: z.number().nullable(),
})

export const speedtestsRoutes = new Elysia()
  .get(
    '/api/speedtests',
    ({ query }) => {
      const conditions: SQL[] = []
      if (query.from !== undefined) conditions.push(gte(speedTest.ts, query.from))
      if (query.to !== undefined) conditions.push(lte(speedTest.ts, query.to))
      const where = conditions.length > 0 ? and(...conditions) : undefined

      const rows = db.select().from(speedTest).where(where).orderBy(desc(speedTest.ts)).all()
      return { speedTests: rows }
    },
    {
      query: z.object({
        from: z.coerce.number().int().optional(),
        to: z.coerce.number().int().optional(),
      }),
      response: z.object({ speedTests: z.array(SpeedTestSchema) }),
      detail: {
        tags: ['Speed Tests'],
        summary: 'List speed tests',
        description: 'Hourly Ookla runs, most recent first. Failed runs are included (`ok: false`, `error` set) — a failed test is data, not noise.',
      },
    },
  )
  .get(
    '/api/speedtests/summary',
    ({ query }) => {
      const days = query.days ?? 7
      const since = Date.now() - days * 24 * 60 * 60 * 1000
      const rows = db
        .select()
        .from(speedTest)
        .where(and(gte(speedTest.ts, since), eq(speedTest.ok, true)))
        .all()

      const downloads = rows.map((r) => r.downloadMbps).filter((v): v is number => v !== null)
      const uploads = rows.map((r) => r.uploadMbps).filter((v): v is number => v !== null)

      const summarize = (values: number[]) => ({
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        best: values.length > 0 ? Math.max(...values) : null,
        worst: values.length > 0 ? Math.min(...values) : null,
      })

      return {
        days,
        count: rows.length,
        download: summarize(downloads),
        upload: summarize(uploads),
      }
    },
    {
      query: z.object({
        days: z.coerce.number().int().min(1).max(365).default(7).optional(),
      }),
      response: z.object({
        days: z.number().int(),
        count: z.number().int(),
        download: DirectionSummarySchema,
        upload: DirectionSummarySchema,
      }),
      detail: {
        tags: ['Speed Tests'],
        summary: 'Rolling speed-test summary',
        description: 'p50/p95/best/worst download and upload (Mbps) over successful runs in the last `days` (default 7).',
      },
    },
  )
  .post(
    '/api/speedtests/run',
    ({ headers, status }) => {
      if (!hasValidBearer(headers)) return status(401, 'Unauthorized')
      const triggered = triggerSpeedtestNow()
      return { ok: true as const, triggered }
    },
    {
      response: {
        200: z.object({
          ok: z.literal(true),
          triggered: z.boolean().describe('false if a run — scheduled or manual — was already in progress'),
        }),
        401: z.string(),
      },
      detail: {
        tags: ['Speed Tests'],
        summary: 'Trigger a speed test now',
        description:
          'Fire-and-forget: starts an Ookla run in the background and returns immediately. Poll GET /api/speedtests or GET /api/status for the result once it lands.',
        security: [{ BearerAuth: [] }],
      },
    },
  )

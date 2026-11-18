import { Elysia } from 'elysia'
import { z } from 'zod'
import { and, eq, gte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { speedTest } from '../db/schema.js'
import { percentile } from '../lib/stats.js'

const DirectionSummarySchema = z.object({
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  best: z.number().nullable(),
  worst: z.number().nullable(),
})

export const speedtestsRoutes = new Elysia().get(
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
      description:
        'p50/p95/best/worst download and upload (Mbps) over successful runs in the last `days` (default 7).',
    },
  },
)

import { Elysia } from 'elysia'
import { z } from 'zod'
import { desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { outage, probeSample, speedTest } from '../db/schema.js'
import { config } from '../config.js'

const LastSampleSchema = z.object({
  target: z.string(),
  scope: z.enum(['gateway', 'wan']),
  ts: z.number().int(),
  addr: z.string(),
  sent: z.number().int(),
  received: z.number().int(),
  lossPct: z.number(),
  medMs: z.number().nullable(),
  jitterMs: z.number().nullable(),
  up: z.boolean(),
})

const OngoingOutageSchema = z.object({
  id: z.number().int(),
  scope: z.enum(['gateway', 'wan']),
  startedAt: z.number().int(),
  cycles: z.number().int(),
  evidence: z.array(z.string()),
})

const LastSpeedTestSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  ok: z.boolean(),
  downloadMbps: z.number().nullable(),
  uploadMbps: z.number().nullable(),
  pingMs: z.number().nullable(),
  latencyDownMs: z.number().nullable(),
  latencyUpMs: z.number().nullable(),
  serverName: z.string().nullable(),
  error: z.string().nullable(),
})

const StatusResponse = z.object({
  up: z.boolean().describe('false while any scope (gateway or wan) has an ongoing outage'),
  ongoingOutages: z.array(OngoingOutageSchema),
  lastSamples: z.array(LastSampleSchema),
  lastSpeedTest: LastSpeedTestSchema.nullable(),
})

export const statusRoute = new Elysia().get(
  '/api/status',
  () => {
    const lastSamples = config.targets
      .map((target) => {
        const row = db
          .select()
          .from(probeSample)
          .where(eq(probeSample.target, target.name))
          .orderBy(desc(probeSample.ts))
          .limit(1)
          .get()
        if (!row) return null
        return {
          target: row.target,
          scope: target.scope,
          ts: row.ts,
          addr: row.addr,
          sent: row.sent,
          received: row.received,
          lossPct: row.lossPct,
          medMs: row.medMs,
          jitterMs: row.jitterMs,
          up: row.received > 0,
        }
      })
      .filter((sample): sample is NonNullable<typeof sample> => sample !== null)

    const ongoingOutages = db
      .select()
      .from(outage)
      .where(isNull(outage.endedAt))
      .all()
      .map((row) => ({
        id: row.id,
        scope: row.scope,
        startedAt: row.startedAt,
        cycles: row.cycles,
        evidence: JSON.parse(row.evidence) as string[],
      }))

    const lastSpeedTestRow = db.select().from(speedTest).orderBy(desc(speedTest.ts)).limit(1).get()
    const lastSpeedTest = lastSpeedTestRow
      ? {
          id: lastSpeedTestRow.id,
          ts: lastSpeedTestRow.ts,
          ok: lastSpeedTestRow.ok,
          downloadMbps: lastSpeedTestRow.downloadMbps,
          uploadMbps: lastSpeedTestRow.uploadMbps,
          pingMs: lastSpeedTestRow.pingMs,
          latencyDownMs: lastSpeedTestRow.latencyDownMs,
          latencyUpMs: lastSpeedTestRow.latencyUpMs,
          serverName: lastSpeedTestRow.serverName,
          error: lastSpeedTestRow.error,
        }
      : null

    return {
      up: ongoingOutages.length === 0,
      ongoingOutages,
      lastSamples,
      lastSpeedTest,
    }
  },
  {
    response: StatusResponse,
    detail: {
      tags: ['Status'],
      summary: 'Current line status',
      description:
        'Up/down now, any ongoing outage (gateway and/or wan scope), the most recent sample per configured target, and the most recent speed test. This is the "Now" dashboard view in one call.',
    },
  },
)

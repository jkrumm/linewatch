import { Elysia } from 'elysia'
import { z } from 'zod'
import { desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { outage, probeSample, speedTest } from '../db/schema.js'
import { config } from '../config.js'
import { currentVantage } from '../services/cycle-vantage.js'

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

const VantageSchema = z.object({
  ts: z.number().int(),
  pathIf: z.string().nullable(),
  pathClass: z.enum(['ethernet', 'wifi', 'cellular', 'other']).nullable(),
  linkMedia: z.string().nullable(),
  linkMbit: z.number().int().nullable(),
  linkDuplex: z.enum(['full', 'half']).nullable(),
  linkMaxMbit: z
    .number()
    .int()
    .nullable()
    .describe(
      'Fastest speed in the interface\'s *supported* media list, not the negotiated one in linkMbit. It is what separates "the NIC can only do 100" from "the NIC can do 1000 and negotiated 100" — a different repair in each case. Null when the collector could not parse it; never an implied 1000.',
    ),
  dhcpBoundAt: z
    .number()
    .int()
    .nullable()
    .describe(
      'Unix ms of the DHCP lease start on pathIf. A *change* proves a re-bind; an unchanged value proves nothing about link stability. Null when the line was absent or unparseable.',
    ),
  gatewayAddr: z.string().nullable(),
  onHomeLine: z
    .boolean()
    .nullable()
    .describe('true = Ethernet through the configured home gateway; false = some other path; null = not reported, i.e. UNKNOWN. Never render null as true.'),
})

const StatusResponse = z.object({
  up: z.boolean().describe('false while any scope (gateway or wan) has an ongoing outage'),
  ongoingOutages: z.array(OngoingOutageSchema),
  lastSamples: z.array(LastSampleSchema),
  lastSpeedTest: LastSpeedTestSchema.nullable(),
  vantage: VantageSchema.nullable().describe('The most recent cycle vantage, or null when no cycle ever reported one'),
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

    const vantageRow = currentVantage(db)
    const vantage = vantageRow
      ? {
          ts: vantageRow.ts,
          pathIf: vantageRow.pathIf,
          pathClass: vantageRow.pathClass,
          linkMedia: vantageRow.linkMedia,
          linkMbit: vantageRow.linkMbit,
          linkDuplex: vantageRow.linkDuplex,
          linkMaxMbit: vantageRow.linkMaxMbit,
          dhcpBoundAt: vantageRow.dhcpBoundAt,
          gatewayAddr: vantageRow.gatewayAddr,
          // Three states, preserved: the column is 0/1/NULL and NULL means the
          // collector did not report. Coalescing it to `true` here is precisely
          // the lie this table exists to prevent.
          onHomeLine: vantageRow.onHomeLine === null ? null : vantageRow.onHomeLine === 1,
        }
      : null

    return {
      up: ongoingOutages.length === 0,
      ongoingOutages,
      lastSamples,
      lastSpeedTest,
      vantage,
    }
  },
  {
    response: StatusResponse,
    detail: {
      tags: ['Status'],
      summary: 'Current line status',
      description:
        'Up/down now, any ongoing outage (gateway and/or wan scope), the most recent sample per configured target, the most recent speed test, and the current vantage — which interface and negotiated link the last cycle went out over, the ceiling that NIC advertises as supported, when its DHCP lease last started, and whether any of it was the home line at all. This is the "Now" dashboard view in one call.',
    },
  },
)

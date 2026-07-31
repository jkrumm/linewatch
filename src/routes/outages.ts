import { Elysia } from 'elysia'
import { z } from 'zod'
import { and, desc, gte, isNull, lte, or, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { outage } from '../db/schema.js'
import { config } from '../config.js'
import { rangeSummary } from '../db/range-summary.js'

const RangeSummarySchema = z.object({
  from: z.number().int(),
  to: z.number().int(),
  recordedCycles: z.number().int().describe('Distinct probe cycles actually recorded in the range'),
  expectedCycles: z.number().int().describe('How many the probe cadence should have produced across the whole range'),
  coveragePct: z
    .number()
    .nullable()
    .describe(
      'recordedCycles / expectedCycles × 100. Below 100 means part of the range was NOT MEASURED, which is not the same as up. `null` means unknown: the range is shorter than one probe cycle, so `expectedCycles` is 0 and there is no share of it to report — 0 would claim a measured window was unmeasured.',
    ),
  firstTs: z.number().int().nullable(),
  lastTs: z.number().int().nullable(),
  degradedCycles: z
    .number()
    .int()
    .describe(
      'Cycles in which EVERY WAN anchor lost ≥ degradedLossPct while no outage row covered them — degradation the outage table structurally cannot show. All anchors, not the worst one: three anchors sit on three networks so that one provider deprioritising ICMP is not a line problem. The gateway is excluded — gateway loss is a LOCAL problem, not a home-line degradation.',
    ),
  degradedLossPct: z.number().describe('The threshold used (LINEWATCH_DEGRADED_LOSS_PCT / src/config.ts)'),
  onHomeLine: z
    .enum(['all', 'none', 'mixed', 'unknown'])
    .describe('Vantage verdict over the range. Only `all` means every recorded cycle measured the home line; `unknown` is not `all`.'),
  homeLineCycles: z.number().int(),
  offHomeLineCycles: z.number().int(),
  unknownHomeLineCycles: z.number().int(),
})

const OutageSchema = z.object({
  id: z.number().int(),
  scope: z.enum(['gateway', 'wan']),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  durationS: z.number().int().nullable(),
  cycles: z.number().int(),
  evidence: z.array(z.string()),
})

export const outagesRoutes = new Elysia().get(
  '/api/outages',
  ({ query }) => {
    const conditions: SQL[] = []
    // True overlap, not containment of the start instant. `startedAt >= from`
    // dropped an outage that began 30 min before a 24 h window and ran three
    // hours into it — whole, from both the table and the downtime sum, which is
    // the single worst row to lose. An outage overlaps the window when it began
    // at or before `to` and had not yet ended at `from` (still ongoing counts).
    if (query.to !== undefined) conditions.push(lte(outage.startedAt, query.to))
    if (query.from !== undefined) conditions.push(or(isNull(outage.endedAt), gte(outage.endedAt, query.from)) as SQL)
    if (query.minDuration !== undefined) {
      // An ongoing outage (durationS still null) always passes — its final
      // duration isn't known yet, and it's the most operationally relevant row.
      conditions.push(or(isNull(outage.durationS), gte(outage.durationS, query.minDuration)) as SQL)
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const rows = db.select().from(outage).where(where).orderBy(desc(outage.startedAt)).all()

    // Only computable for an explicit range: "how much of the window was
    // actually measured" is meaningless without a window. The dashboard's
    // headline ("24 h: 0 min downtime") must be read together with this.
    const summary =
      query.from !== undefined && query.to !== undefined
        ? rangeSummary(db, {
            from: query.from,
            to: query.to,
            probeCycleSeconds: config.probeCycleSeconds,
            degradedLossPct: config.degradedLossPct,
            // Scope, not name: which targets are WAN anchors is configuration
            // (src/config.ts), and a degradation of the *line* has to be
            // visible on all of them. Renaming a target must not silently
            // change what "degraded" counts.
            wanTargets: config.targets.filter((target) => target.scope === 'wan').map((target) => target.name),
          })
        : null

    return {
      outages: rows.map((row) => ({
        id: row.id,
        scope: row.scope,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationS: row.durationS,
        cycles: row.cycles,
        evidence: JSON.parse(row.evidence) as string[],
      })),
      summary,
    }
  },
  {
    query: z.object({
      from: z.coerce.number().int().optional(),
      to: z.coerce.number().int().optional(),
      minDuration: z.coerce.number().int().optional().describe('Seconds — filters closed outages; ongoing outages always show'),
    }),
    response: z.object({
      outages: z.array(OutageSchema),
      summary: RangeSummarySchema.nullable().describe('Coverage, degradation and vantage over the requested range; null when `from`/`to` were not both given'),
    }),
    detail: {
      tags: ['Outages'],
      summary: 'List outages',
      description:
        'Outage rows materialised by the ingest-time state machine (never derived on read). Single-cycle blips are included honestly — filter them client-side or with `minDuration`. When both `from` and `to` are given, `summary` carries the three things an outage list cannot say on its own: how much of the range was actually measured (`recordedCycles` vs `expectedCycles` — "0 min downtime" over an unmeasured range is a lie of omission), how many cycles were materially degraded without ever reaching zero replies (`degradedCycles`, which the outage state machine cannot record because it only fires on `received === 0`), and whether the range was measured over the home line at all (`onHomeLine`).',
    },
  },
)

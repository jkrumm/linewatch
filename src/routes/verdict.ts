import { Elysia } from 'elysia'
import { z } from 'zod'
import { db } from '../db/client.js'
import { config } from '../config.js'
import { routerConfig } from '../services/router/config.js'
import { collectVerdictInput } from '../lib/verdict-queries.js'
import { deriveVerdicts } from '../lib/verdict.js'

const EvidenceSchema = z.object({
  label: z.string(),
  value: z.string().describe('Already formatted, units included. `unknown` where a term was not measured — never 0 standing in for it.'),
})

const VerdictSchema = z.object({
  id: z.string().describe('Rule id. Not unique: a per-row rule emits one verdict per row it fired on.'),
  severity: z.enum(['critical', 'warn', 'info', 'ok']),
  conclusion: z.string().describe('One sentence, templated from the numbers in `evidence`. Never a literal authored in the UI.'),
  evidence: z.array(EvidenceSchema).describe('The numbers the conclusion rests on. Always non-empty — a verdict that cannot cite them is not constructed.'),
  action: z.string().nullable(),
  uncertainty: z
    .string()
    .nullable()
    .describe('Set when a cause was withheld for want of evidence — most often missing link-sampler coverage. Render it; swallowing it turns a hedged statement into a confident one.'),
})

export const verdictRoutes = new Elysia().get(
  '/api/verdicts',
  ({ query }) => {
    const input = collectVerdictInput(db, {
      from: query.from,
      to: query.to,
      now: Date.now(),
      probeCycleSeconds: config.probeCycleSeconds,
      degradedLossPct: config.degradedLossPct,
      // Scope, not name — the same reasoning `GET /api/outages` applies: which
      // targets are anchors is configuration, and renaming one must not change
      // what any rule means.
      wanTargets: config.targets.filter((target) => target.scope === 'wan').map((target) => target.name),
      gatewayTarget: config.targets.find((target) => target.scope === 'gateway')?.name ?? null,
      expectedTargetCount: config.targets.length,
      router: {
        enabled: routerConfig.enabled,
        disabledReason: routerConfig.disabledReason,
        pollIntervalMs: routerConfig.pollIntervalMs,
      },
    })

    return { verdicts: deriveVerdicts(input), window: { from: query.from, to: query.to } }
  },
  {
    // Both bounds required. A verdict that reports coverage is meaningless
    // without the window it covers, the same reason `GET /api/outages` only
    // attaches its range summary when both bounds are given.
    query: z.object({
      from: z.coerce.number().int(),
      to: z.coerce.number().int(),
    }),
    response: z.object({
      verdicts: z.array(VerdictSchema).describe('Ordered by severity, then by rule id.'),
      window: z.object({ from: z.number().int(), to: z.number().int() }),
    }),
    detail: {
      tags: ['Status'],
      summary: 'Rule-based verdicts over a window',
      description:
        'What the record says about this window, in sentences built from its own numbers. Nine rules, all deterministic and unit-tested — ' +
        'no model and no scoring. Every conclusion carries the `evidence` it was templated from, and a rule whose inputs include a null ' +
        'term returns nothing rather than substituting a plausible value. `uncertainty` is the honest half: a rule that attributes a cause ' +
        'across a window only does so when the host-side link sampler covered at least 90% of it with no recorded transition — otherwise ' +
        'the measurement stays, the cause is dropped, the severity drops one step, and `uncertainty` names what is missing.',
    },
  },
)

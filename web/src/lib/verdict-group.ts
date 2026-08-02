import type { Evidence, Severity, Verdict } from './types'

/** Worse-first so a group's severity can only be pulled toward `critical`, never away from it. */
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warn: 1, info: 2, ok: 3 }

function worstSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b
}

/**
 * One rule collapsed to a single card. `instances` is the full ordered run that formed it — never
 * dropped, because the disclosure this exists to feed has to be able to reach every one of them.
 *
 * The representative fields (`title`/`conclusion`/`evidence`/`action`/`uncertainty`) are always a
 * verbatim copy of one instance, never a merge: the rule engine authors sentences from numbers it
 * queried, and this layer only ever selects among what already exists. Writing a new sentence here
 * ("3 resyncs since ...") would be exactly the unevidenced inference `src/lib/verdict.ts` refuses to
 * produce.
 */
export type VerdictGroup = {
  id: string
  severity: Severity
  title: string
  conclusion: string
  evidence: Evidence[]
  action: string | null
  uncertainty: string | null
  instances: Verdict[]
}

/**
 * Collapses the rule engine's one-verdict-per-row output into one card per rule.
 *
 * A per-row rule (`carrier_resync_dated`, the "all targets stalled" family) emits one `Verdict` per
 * row it fired on, so the same `id` legitimately repeats — and at a 30 d window that repetition is
 * exactly what buries the band under a thousand pixels of structurally identical cards. Grouping by
 * `id` rather than by array position is deliberate: the input is sorted severity-first, so same-`id`
 * instances at different severities are not contiguous, and a contiguity-based grouping would split
 * one rule's findings across the list instead of collapsing them.
 *
 * The group is never gentler than its worst member (a group holding one `critical` instance among
 * ten `info` ones is `critical`), and its representative sentence is the first instance *at that
 * worst severity* — not the first instance overall, which could be a milder one that arrived first
 * and would otherwise understate the group.
 *
 * Output order is first-appearance order of each `id`, which is enough to keep the server's overall
 * severity-then-id ordering intact: the first instance of an id still carries that id's rank.
 */
export function groupVerdicts(verdicts: readonly Verdict[]): VerdictGroup[] {
  const order: string[] = []
  const instancesById = new Map<string, Verdict[]>()

  for (const verdict of verdicts) {
    const existing = instancesById.get(verdict.id)
    if (existing === undefined) {
      order.push(verdict.id)
      instancesById.set(verdict.id, [verdict])
    } else {
      existing.push(verdict)
    }
  }

  return order.map((id) => {
    // The `!`s are safe: `id` came from `order`, which is only ever populated together with the
    // map, and each map entry starts with one push before it can ever be looked up.
    const instances = instancesById.get(id)!
    const first = instances[0]!
    const severity = instances.reduce((worst, v) => worstSeverity(worst, v.severity), first.severity)
    const representative = instances.find((v) => v.severity === severity)!
    return {
      id,
      severity,
      title: representative.title,
      conclusion: representative.conclusion,
      evidence: representative.evidence,
      action: representative.action,
      uncertainty: representative.uncertainty,
      instances,
    }
  })
}

/**
 * The three ways a group can be drawn, decided by severity alone.
 *
 * `critical` earns the full card, `warn` earns a line, `routine` (`info`/`ok`) earns a place in a
 * closed disclosure. The tiers are not three sizes of the same thing — they answer three different
 * questions: "act now", "there is something here", "the record contains this".
 */
export interface VerdictTriage {
  critical: VerdictGroup[]
  warn: VerdictGroup[]
  routine: VerdictGroup[]
}

/**
 * Sort grouped verdicts into the three render tiers.
 *
 * This replaces a `visibleLimit` budget that rendered the first three `info`/`ok` groups as full
 * cards. That budget is what buried the band: **`info` is the severity of a rule that fired
 * correctly.** `carrier_resync_dated` states a real, dated, past event and goes on stating it for
 * as long as that event is inside the selected window — three weeks, on a 30 d range — so an
 * eager-`info` band is one that never goes quiet no matter how healthy the line is. A reader who
 * sees the same three cards every day stops reading the band, which costs the `critical` card its
 * only reader. Routine findings are still reachable, still counted on the toggle, and still exactly
 * the sentences the rules wrote; they are just not the first thing on the page any more.
 *
 * **`critical` and `warn` are never routine and never behind the disclosure** — that is the
 * load-bearing rule and it is unchanged. What changed is only how large a `warn` is drawn: a line
 * rather than a card. It is still on screen unconditionally, which is the property that matters.
 *
 * Order-preserving and total: every input group lands in exactly one tier, in input order.
 */
export function triageVerdicts(groups: readonly VerdictGroup[]): VerdictTriage {
  const triage: VerdictTriage = { critical: [], warn: [], routine: [] }

  for (const group of groups) {
    if (group.severity === 'critical') triage.critical.push(group)
    else if (group.severity === 'warn') triage.warn.push(group)
    else triage.routine.push(group)
  }

  return triage
}

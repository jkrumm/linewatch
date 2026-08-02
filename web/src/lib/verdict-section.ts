import type { Verdict } from './types'

/** The stacked sections of the single-page dashboard, in reading order. */
export const SECTION_KEYS = ['uptime', 'latency', 'speed', 'throughput', 'path'] as const
export type SectionKey = (typeof SECTION_KEYS)[number]

export const SECTION_LABEL: Record<SectionKey, string> = {
  uptime: 'Uptime',
  latency: 'Ping',
  speed: 'Speed',
  throughput: 'Throughput',
  path: 'Path & hardware',
}

/** The DOM id each section renders on, so a verdict can link straight to its evidence. */
export function sectionAnchor(key: SectionKey): string {
  return `section-${key}`
}

export function isSectionKey(value: string): value is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(value)
}

/**
 * Which section a rule's evidence lives in.
 *
 * Every id `src/lib/verdict.ts` can emit appears here exactly once, and a test reads that module to
 * prove it — a hand-copied list of rule names is a list that drifts, and the whole point is to fail
 * when the rule engine grows a rule.
 *
 * This map used to drive attention dots on a row of tabs: the sections below were four panes, only
 * one of which was rendered at a time, so a finding about a closed pane needed a mark on the outside
 * to keep the pane from going silent. **The tabs are gone** — every section is now on the page at
 * once — so that guarantee is no longer something the map has to provide. What survives is the more
 * useful half: a finding names where its evidence is, and the reader gets a link rather than four
 * sections to guess between. The completeness test survives unchanged, because a rule that points
 * the reader nowhere is still a rule the reader cannot follow up.
 */
export const VERDICT_SECTION: Record<string, SectionKey> = {
  // Whether the record covers the window at all is an uptime question before it is anything else:
  // every downtime figure in that section is only as true as the coverage behind it.
  no_data: 'uptime',
  collector_silent: 'uptime',
  coverage_unknown: 'uptime',
  probe_coverage_low: 'uptime',
  gateway_outage_uncorroborated: 'uptime',
  // Both are cycle-level path findings, and the Latency section is where a reader sees the cycles.
  sub_cycle_path_stall: 'latency',
  symmetric_loss_not_line: 'latency',
  throughput_exceeds_link: 'speed',
  // Carrier- and host-link findings sit with the vantage/link blocks that evidence them, not with
  // the throughput number they happen to cap.
  link_below_carrier_sync: 'path',
  router_disabled: 'path',
  router_no_data: 'path',
  router_coverage_low: 'path',
  carrier_resync_dated: 'path',
}

/**
 * Rule ids in this verdict set that no section claims.
 *
 * Returned rather than ignored: a new rule id added server-side without a mapping would otherwise
 * render in the band pointing at nothing, and the reader would have to know the codebase to find
 * what it is about. The caller surfaces it as a defect in the page rather than in the line.
 */
export function unmappedVerdictIds(verdicts: readonly Verdict[]): string[] {
  const unmapped: string[] = []
  for (const verdict of verdicts) {
    if (verdict.id in VERDICT_SECTION) continue
    if (!unmapped.includes(verdict.id)) unmapped.push(verdict.id)
  }
  return unmapped
}

import { createPersistedState } from 'basalt-ui/state'

/**
 * Compact mode: the dashboard with its supporting detail dropped, and every conclusion still on
 * screen.
 *
 * **What it hides, and the one rule it is written around.** This page's standing contract is that a
 * section's *evidence* may sit behind a named view switch but a *conclusion* never may — every
 * finding renders in the verdict band above the sections, unconditionally (`components/section.tsx`,
 * and `routes/index.tsx`'s docblock). A "show me less" control is exactly the shape that breaks
 * that rule by accident, so the split is explicit rather than left to whoever adds the next block:
 *
 * - **Hidden:** the per-section stat strips (`Section.meta`), the *informational* coverage rows
 *   (`CoverageCallout`'s `kind === 'info'` branch — "Coverage 100.0% — 2880 of 2880 expected cycles
 *   recorded", which is the statement that nothing is wrong), `ServerChangeNote`, the routine
 *   verdict group, each section's heading row (title AND view switch — see below), and the
 *   Path & hardware section entirely.
 * - **Never hidden:** the status bar, the verdict band's critical and warn findings, the `warn`/`bad`
 *   coverage callouts, and the charts.
 *
 * **The heading row goes as a unit, and it has to.** The title and the view switch share one
 * `Group justify="space-between"` whose height is set by the taller of the two — the switch. Hiding
 * the title alone therefore saves nothing at all; hiding both saves the row. The cost is real and
 * accepted: a reader in compact cannot reach a section's other views (the outage table, per-target
 * latency, the 30-day pattern). Compact is the mode for watching, not for reading evidence, and the
 * switch is one click away in the other mode.
 *
 * **Path & hardware is dropped whole** rather than reduced. It is the one section whose content is
 * reference — hardware that has not changed since the machine was plugged in — which is why it is
 * also the only `collapsible` one. It is also the reason `SectionLink` below leaves compact rather
 * than merely scrolling.
 *
 * The routine group is the one judgement call in that list, and it is a judgement call, not an
 * oversight. `triageVerdicts` sorts findings into critical / warn / routine, and *routine* means, by
 * construction, the ones that need no action — the collapsed row says so in words ("N routine
 * findings — nothing to act on"). Dropping it in a mode the reader has explicitly opted into is not
 * hiding a conclusion that asks for something; a critical or warn finding is, and neither is
 * droppable here. If `triageVerdicts` ever starts routing an actionable finding to `routine`, this
 * is the second place that breaks.
 *
 * **Persisted, not in the URL.** The range and the outage filter are in the URL because they change
 * what the page *reports* and a link to a reading has to carry them. Density changes what one reader
 * wants to look at, and a URL that pins someone else's density is a worse link, not a better one.
 * Same reasoning `Section`'s fold overrides already follow.
 */
export const useCompactMode = createPersistedState({
  key: 'compact-mode',
  version: 1,
  initial: false,
})

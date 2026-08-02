import { ActionIcon, Tooltip } from '@mantine/core'
import { IconLayoutList, IconLayoutRows } from '@tabler/icons-react'
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
 *   recorded", which is the statement that nothing is wrong), `ServerChangeNote`, and the routine
 *   verdict group.
 * - **Never hidden:** the status bar, the verdict band's critical and warn findings, the `warn`/`bad`
 *   coverage callouts, section headings, the view switches, and the charts.
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

/**
 * The toggle, drawn beside the theme switch because it belongs to the same family: a per-reader
 * display preference that changes nothing about what was measured.
 *
 * The icon names the state you get by pressing it, not the state you are in — the same convention
 * basalt's `ThemeToggle` uses — and the tooltip says it in words, because an icon pair whose
 * difference is line spacing is not self-evident either way round.
 */
export function CompactToggle() {
  const [compact, setCompact] = useCompactMode()
  const label = compact ? 'Show detail' : 'Compact — charts and findings only'

  return (
    <Tooltip label={label} events={{ hover: true, focus: true, touch: true }}>
      <ActionIcon
        variant="default"
        size="lg"
        aria-label={label}
        aria-pressed={compact}
        onClick={() => setCompact(!compact)}
      >
        {compact ? <IconLayoutList size={18} /> : <IconLayoutRows size={18} />}
      </ActionIcon>
    </Tooltip>
  )
}

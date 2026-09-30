import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { Box } from '@mantine/core'
import { Section } from 'basalt-ui'
import { ViewTabs } from 'basalt-ui/controls'
import { createPersistedState } from 'basalt-ui/state'
import type { EnumField, FieldHandle } from 'basalt-ui/state'
import { dashboard } from '../lib/dashboard-store'
import { SECTION_LABEL, sectionAnchor, type SectionKey } from '../lib/verdict-section'

/**
 * One switchable view of a section.
 *
 * `render` is a thunk rather than a `ReactNode` so the inactive views cost nothing: a section holds
 * up to four charts and eagerly building all of them to show one is how a page with five sections
 * ends up mounting seventeen SVGs to display four. basalt's `Section` only ever sees the ACTIVE
 * branch, which is why this stays a thunk after the migration — and a COLLAPSED section costs one
 * element tree rather than one mounted chart, because `Section` renders its body under `open &&`
 * (the predecessor needed an explicit guard inside `Collapse`, which keeps children mounted).
 */
export interface SectionView<T extends string> {
  key: T
  /** What is inside, named as a thing rather than as a verb. The reader decides whether to click
   * from this string alone, so "Per anchor" beats "Details" and "More" says nothing at all. */
  label: string
  render: () => ReactNode
}

/**
 * One section of the dashboard: basalt's `Section` plus the three things that are content decisions
 * rather than framework ones.
 *
 * The heading, the fold, the chevron, the persisted fold state, the `ViewTabs` responsive swap and
 * the anchor's `scroll-margin-top` (which now clears the measured `PageBar` height, not a guessed
 * 96px) are all basalt's since 1.26.0 — a ~190-line fork went with them. What is left here:
 *
 * 1. **Compact drops the whole header**, so compact drops `Section` itself rather than passing it
 *    fewer props: basalt always draws the header, and title-plus-tabs is one row whose height is set
 *    by the switch. See `dashboard.field.compact`'s docblock for the split and its cost.
 * 2. **The views are a lazy switch** over `SectionView.render`, keyed off a `createLocalStore` field.
 * 3. **The hash listener**, which basalt has none of — see `useOpenOnHash`.
 *
 * What this deliberately does *not* do is hide a conclusion. Every finding the rule engine reaches
 * renders in the verdict band at the top of the page, unconditionally and outside any section —
 * see `triageVerdicts`. A section view holds evidence, and evidence the reader can see the name of
 * is not hidden. The one rule this places on the page that composes it: **the primary view is the
 * one a verdict's "see the Uptime section ↓" link lands on**, so a finding's numbers are never a
 * click further than the anchor promises. Order the views accordingly, and keep the view field on
 * the in-memory lane (`dashboard-store.ts`) so no reload can land a link somewhere else.
 *
 * `SECTION_LABEL` and `sectionAnchor` are both keyed off the same `SectionKey` the verdict map uses,
 * so a finding's link and the heading it scrolls to cannot drift apart.
 */
export function DashboardSection<T extends string>({
  id,
  subtitle,
  meta,
  field,
  views,
  collapsible = false,
  defaultOpen = true,
}: {
  id: SectionKey
  /**
   * One line stating the question this section answers — not a description of the charts in it.
   *
   * **Optional, and omitted on every section today.** Each of the five read as a restatement of the
   * heading plus the `meta` strip directly under it: "Reachability, and how long it was down." sat
   * above a strip already printing Downtime, Outages and Coverage. A subtitle on every section is a
   * line the reader learns to skip, which costs the ones that carry a fact. Pass it only where the
   * heading genuinely does not name the question.
   */
  subtitle?: string
  /**
   * The section's headline figures. Usually a `StatStrip`, and it rides `Section.summary` rather
   * than being the first child: `summary` survives a collapse, so the one folded section still
   * states its own numbers instead of costing the reader the figures they were watching.
   */
  meta?: ReactNode
  /** The section's view field — a `createLocalStore` enum whose values are exactly `views`' keys. */
  field: FieldHandle<EnumField<T>>
  views: SectionView<T>[]
  /**
   * Whether this section's VIEWS can be folded away. Opt-in, and the docblock above is the reason
   * it has to be: a disclosure that hides a finding is exactly what this component's predecessor
   * replaced.
   *
   * What makes it defensible on one section is that the heading and `meta` both stay drawn — so a
   * collapsed section still states its own headline figures — and that every verdict renders in the
   * band at the top of the page regardless. Folding is a choice about how much EVIDENCE to keep on
   * screen, and only earns its place where the evidence is largely reference: hardware that has not
   * changed since the machine was plugged in.
   */
  collapsible?: boolean
  /** What an untouched section does. Only consulted while nothing is persisted, and only meaningful
   * when `collapsible` — basalt's `Section` lets a persisted value outrank it, so a section the
   * reader has closed stays closed. */
  defaultOpen?: boolean
}) {
  const [compact] = dashboard.field.compact.use()
  const [view] = field.use()
  const anchor = sectionAnchor(id)
  useOpenOnHash({ id, active: collapsible, defaultOpen })

  // The lazy switch. `views[0]` is the fallback rather than an error: the field's enum and this array
  // are declared apart, and a section drawing its primary view beats a section drawing nothing.
  const body = (views.find((candidate) => candidate.key === view) ?? views[0])?.render() ?? null

  if (compact) {
    // The heading row and `meta` both go, so there is nothing left for `Section` to draw — see
    // `dashboard.field.compact`. The anchor and its offset stay: a verdict link leaves compact in
    // the same click, but the hash resolves against whatever is mounted at the time.
    return (
      <Box
        component="section"
        id={anchor}
        style={{ scrollMarginTop: 'var(--basalt-page-bar-h, 0px)' }}
      >
        {body}
      </Box>
    )
  }

  return (
    <Section
      id={anchor}
      title={SECTION_LABEL[id]}
      {...(subtitle !== undefined && { subtitle })}
      {...(meta !== undefined && { summary: meta })}
      {...(views.length > 1 && {
        tabs: (
          <ViewTabs
            field={field}
            options={views.map((candidate) => ({ value: candidate.key, label: candidate.label }))}
            label={`${SECTION_LABEL[id]} view`}
          />
        ),
      })}
      {...(collapsible && { collapsible: true, persistKey: id, defaultOpen })}
    >
      {body}
    </Section>
  )
}

/**
 * A verdict's "see the Path & hardware section ↓" link must never land the reader on a closed box —
 * that is the one hard rule the component docblock states, and a fold is the obvious way to break
 * it.
 *
 * **It is honoured by OPENING the section, not by overriding the reader.** The first attempt let a
 * live finding force the section open for as long as it held, and on this line one holds more or
 * less permanently (carrier poll coverage sits under its threshold most days) — so the section was
 * open on every visit, the chevron did nothing visible when pressed, and the fold the reader asked
 * for did not exist. A control that silently does nothing is worse than no control.
 *
 * The hash is the precise moment the guarantee is needed: the reader followed a link *here*. So that
 * flips the stored preference to open, once, and every later press of the chevron is theirs again.
 * `VerdictPanel` renders a plain `#section-…` anchor, which is why this listens to the hash rather
 * than to the verdict set.
 *
 * **It writes basalt's own fold key with a plain `setOpen`.** `Section` persists at
 * `basalt:section:<persistKey>` through `createPersistedState`; before basalt-ui 1.27.0 that
 * factory's in-tab listener set belonged to the INSTANCE that wrote, so a write from a second
 * instance (this one) reached localStorage but notified nobody, and the fold only opened on the
 * next unrelated re-render — worked around here with a synthetic `storage` event dispatched at the
 * same key. 1.27.0 registers subscribers per storage key instead, so every instance sharing a key
 * now notifies every other one in-tab and the workaround is gone.
 *
 * **It also re-scrolls, and that half only matters in compact.** Compact drops the collapsible
 * section outright, so a verdict link clicked there fires the browser's own hash scroll against a
 * document that does not contain the target yet — `EvidenceLink` leaves compact in the same click,
 * and by the time the section mounts the scroll has already happened and landed short. Scrolling
 * once on mount, only while the hash still names it, puts the reader where the link promised. It is
 * a no-op on a normal in-page click (the browser has already scrolled to the same element) and on a
 * cold load with a hash (same).
 */
function useOpenOnHash({
  id,
  active,
  defaultOpen,
}: {
  id: SectionKey
  active: boolean
  defaultOpen: boolean
}): void {
  const storageKey = `section:${id}`
  // Same construction `Section`'s own `useSectionOpen` uses, so the envelope and the version match
  // byte for byte — a second writer with a different `version` would look like corruption to it.
  const usePersistedOpen = useMemo(
    () => createPersistedState<boolean>({ key: storageKey, version: 1, initial: defaultOpen }),
    [storageKey, defaultOpen],
  )
  const [open, setOpen] = usePersistedOpen()

  // `open` in a ref so the listener below can read the current value without being torn down and
  // rebuilt on every write — `createPersistedState`'s setter takes a value, not an updater.
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    if (!active) return
    const anchor = sectionAnchor(id)
    const targeted = () => window.location.hash === `#${anchor}`
    const openIfTargeted = () => {
      if (!targeted() || openRef.current) return
      setOpen(true)
    }
    openIfTargeted()
    if (targeted()) document.getElementById(anchor)?.scrollIntoView()
    window.addEventListener('hashchange', openIfTargeted)
    return () => window.removeEventListener('hashchange', openIfTargeted)
  }, [active, id, setOpen, storageKey])
}

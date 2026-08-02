import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Box, Collapse, Group, SegmentedControl, Stack, Text, UnstyledButton, Title } from '@mantine/core'
import { IconChevronDown } from '@tabler/icons-react'
import { createPersistedState } from 'basalt-ui/state'
import { SECTION_LABEL, sectionAnchor, type SectionKey } from '../lib/verdict-section'

/**
 * Which sections the reader has explicitly opened or closed.
 *
 * A record of OVERRIDES, not of open sections: absent means "never touched this", which has to
 * stay distinguishable from "closed it", or a section's own `defaultOpen` could never be honoured
 * on a first visit. Same three-valued discipline the data layer uses everywhere else on this page.
 *
 * `createPersistedState` rather than a URL param: which reference block a reader keeps folded is a
 * preference about their own screen, not a description of what is being shown, and this dashboard
 * deliberately carries exactly one thing in its URL (the range) plus the outage filter. A second
 * class of state there would make every shared link carry someone else's furniture.
 */
const useSectionOverrides = createPersistedState({
  key: 'section-open',
  version: 1,
  initial: {} as Partial<Record<SectionKey, boolean>>,
})

/**
 * One switchable view of a section.
 *
 * `render` is a thunk rather than a `ReactNode` so the three inactive views cost nothing: a
 * section holds up to four charts and eagerly building all of them to show one is how a page with
 * five sections ends up mounting seventeen SVGs to display four.
 */
export interface SectionView {
  key: string
  /** What is inside, named as a thing rather than as a verb. The reader decides whether to click
   * from this string alone, so "Per anchor" beats "Details" and "More" says nothing at all. */
  label: string
  render: () => ReactNode
}

/**
 * One section of the dashboard: a heading, the question it answers, its headline figures, and one
 * of several views of its evidence.
 *
 * **This replaces a per-section disclosure, and the difference is what the reader is choosing
 * between.** The disclosure asked "do you also want the exhaustive version" and answered it by
 * appending a second screenful below the first — so the honest, complete page was also a page you
 * scrolled past four times to reach the bottom of. A view switch asks "which cut of this question"
 * and answers it in place, at constant height. Nothing is behind a chevron that says nothing; every
 * view is named on screen, always, whether or not it is the one drawn.
 *
 * What it deliberately does *not* do is hide a conclusion. Every finding the rule engine reaches
 * renders in the verdict band at the top of the page, unconditionally and outside any section —
 * see `triageVerdicts`. A section view holds evidence, and evidence the reader can see the name of
 * is not hidden. The one rule this places on the page that composes it: **the primary view is the
 * one a verdict's "see the Uptime section ↓" link lands on**, so a finding's numbers are never a
 * click further than the anchor promises. Order the views accordingly.
 *
 * `SECTION_LABEL` and `sectionAnchor` are both keyed off the same `SectionKey` the verdict map
 * uses, so a finding's link and the heading it scrolls to cannot drift apart.
 */
export function Section({
  id,
  subtitle,
  meta,
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
  /** The section's headline figures, drawn between the heading and the view. Usually a `StatStrip`. */
  meta?: ReactNode
  views: SectionView[]
  /**
   * Whether this section's VIEWS can be folded away. Opt-in, and the docblock above is the reason
   * it has to be: a disclosure that hides a finding is exactly what this component replaced.
   *
   * What makes it defensible on one section is that the heading, the subtitle and `meta` all stay
   * drawn — so a collapsed section still states its own headline figures — and that every verdict
   * renders in the band at the top of the page regardless. Folding is a choice about how much
   * EVIDENCE to keep on screen, and only earns its place where the evidence is largely reference:
   * hardware that has not changed since the machine was plugged in.
   */
  collapsible?: boolean
  /** What an untouched section does. Only consulted when `collapsible`. */
  defaultOpen?: boolean
}) {
  const [active, setActive] = useState(views[0]?.key ?? '')
  const current = views.find((view) => view.key === active) ?? views[0]
  const [overrides, setOverrides] = useSectionOverrides()

  const opened = !collapsible || (overrides[id] ?? defaultOpen)
  const bodyId = `${sectionAnchor(id)}-body`

  // `overrides` in a ref so the listener below can merge into the current value without being torn
  // down and rebuilt on every write — `createPersistedState`'s setter takes a value, not an updater.
  const overridesRef = useRef(overrides)
  overridesRef.current = overrides

  /**
   * A verdict's "see the Path & hardware section ↓" link must never land the reader on a closed
   * box — that is the one hard rule the docblock above states, and a fold is the obvious way to
   * break it.
   *
   * **It is honoured by OPENING the section, not by overriding the reader.** The first attempt let
   * a live finding force the section open for as long as it held, and on this line one holds more
   * or less permanently (carrier poll coverage sits under its threshold most days) — so the
   * section was open on every visit, the chevron did nothing visible when pressed, and the fold
   * the reader asked for did not exist. A control that silently does nothing is worse than no
   * control.
   *
   * The hash is the precise moment the guarantee is needed: the reader followed a link *here*. So
   * that flips the stored preference to open, once, and every later press of the chevron is
   * theirs again. `VerdictPanel` renders a plain `#section-…` anchor, which is why this listens to
   * the hash rather than to the verdict set.
   */
  useEffect(() => {
    if (!collapsible) return
    const openIfTargeted = () => {
      if (window.location.hash !== `#${sectionAnchor(id)}`) return
      if (overridesRef.current[id] === true) return
      setOverrides({ ...overridesRef.current, [id]: true })
    }
    openIfTargeted()
    window.addEventListener('hashchange', openIfTargeted)
    return () => window.removeEventListener('hashchange', openIfTargeted)
  }, [collapsible, id, setOverrides])

  const toggle = () => setOverrides({ ...overrides, [id]: !opened })

  return (
    // The offset is measured, not guessed. `page-header.tsx` writes its own height to
    // `--lw-header-h` because that height is not one number any more — the header lays out as two
    // rows below `sm`, and a 72px offset there puts the section heading under the sticky bar,
    // which is exactly the landing this margin exists to prevent. The fallback is the tall
    // (mobile) value on purpose: too much margin leaves air above the heading, too little hides it.
    <Box component="section" id={sectionAnchor(id)} style={{ scrollMarginTop: 'var(--lw-header-h, 96px)' }}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-end" wrap="wrap" gap="xs">
          {/* The whole heading is the target when it can fold, not a chevron beside it — a 16px hit
              area for the one control that decides whether a third of the page is drawn is the kind
              of thing that reads as decoration. `UnstyledButton` keeps it a real button (Enter,
              Space, focus ring) without bringing any of Mantine's button chrome into a heading. */}
          <Box style={{ minWidth: 0 }}>
            {collapsible ? (
              <UnstyledButton onClick={toggle} aria-expanded={opened} aria-controls={bodyId} style={{ textAlign: 'left' }}>
                <Group gap={6} wrap="nowrap">
                  <Title order={4}>{SECTION_LABEL[id]}</Title>
                  <IconChevronDown
                    size={16}
                    // Rotation only, and only on the glyph: the doctrine's 120–200ms band for a
                    // state flip, on a transform rather than on layout.
                    style={{
                      transition: 'transform 150ms',
                      transform: opened ? 'rotate(0deg)' : 'rotate(-90deg)',
                    }}
                  />
                </Group>
                {subtitle !== undefined && (
                  <Text size="sm" c="dimmed">
                    {subtitle}
                  </Text>
                )}
              </UnstyledButton>
            ) : (
              <>
                <Title order={4}>{SECTION_LABEL[id]}</Title>
                {subtitle !== undefined && (
                  <Text size="sm" c="dimmed">
                    {subtitle}
                  </Text>
                )}
              </>
            )}
          </Box>
          {/* Hidden while folded. A view switch over content nobody can see is a control with no
              observable effect, and pressing it would silently change what appears on unfold. */}
          {views.length > 1 && opened && (
            <>
              {/* Below sm the switch gets its own full-width row and grows to a real tap target. At
                  360px the three Speed labels measure ~307px against a ~334px line — they fit by
                  27px today, and the first view label longer than "Latency under load" turns them
                  into "Every…/By ho…/Laten…", which is exactly the string the reader is supposed to
                  decide from (SegmentedControl's label is `overflow: hidden; text-overflow:
                  ellipsis` with a flex-shrink minimum of 0). `size="xs"` is also a ~22px control,
                  under both the 24px WCAG target minimum and the 44px iOS guideline, on the control
                  the whole page hinges on. `orientation="vertical"` for three-or-more views is the
                  fully safe form — `fullWidth` alone only pushes the ellipsis threshold out. */}
              <Box hiddenFrom="sm" w="100%">
                <SegmentedControl
                  size="sm"
                  fullWidth
                  orientation={views.length > 2 ? 'vertical' : 'horizontal'}
                  value={current?.key ?? ''}
                  onChange={setActive}
                  data={views.map((view) => ({ label: view.label, value: view.key }))}
                  aria-label={`${SECTION_LABEL[id]} view`}
                />
              </Box>
              <SegmentedControl
                visibleFrom="sm"
                size="xs"
                value={current?.key ?? ''}
                onChange={setActive}
                data={views.map((view) => ({ label: view.label, value: view.key }))}
                aria-label={`${SECTION_LABEL[id]} view`}
              />
            </>
          )}
        </Group>
        {/* `meta` stays outside the fold. A collapsed section that reports nothing at all is a
            heading and a chevron — the reader has to open it to learn whether it was worth
            opening. Its headline figures are the thing that makes folding safe. */}
        {meta}
        {collapsible ? (
          // The guard inside is not redundant with `expanded`. `Collapse` keeps its children
          // mounted by default (React 19 `Activity`), so handing it `current.render()` outright
          // would call the thunk and build every chart in the section to then hide them — exactly
          // what `SectionView.render` being a thunk exists to avoid. Guarded, a folded section
          // costs no SVG at all.
          <Collapse expanded={opened} id={bodyId}>
            {opened && current?.render()}
          </Collapse>
        ) : (
          current?.render()
        )}
      </Stack>
    </Box>
  )
}

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Box, Group, SegmentedControl, Stack, Text, Title } from '@mantine/core'
import { SECTION_LABEL, sectionAnchor, type SectionKey } from '../lib/verdict-section'

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
}: {
  id: SectionKey
  /** One line stating the question this section answers — not a description of the charts in it. */
  subtitle: string
  /** The section's headline figures, drawn between the heading and the view. Usually a `StatStrip`. */
  meta?: ReactNode
  views: SectionView[]
}) {
  const [active, setActive] = useState(views[0]?.key ?? '')
  const current = views.find((view) => view.key === active) ?? views[0]

  return (
    // The offset is measured, not guessed. `page-header.tsx` writes its own height to
    // `--lw-header-h` because that height is not one number any more — the header lays out as two
    // rows below `sm`, and a 72px offset there puts the section heading under the sticky bar,
    // which is exactly the landing this margin exists to prevent. The fallback is the tall
    // (mobile) value on purpose: too much margin leaves air above the heading, too little hides it.
    <Box component="section" id={sectionAnchor(id)} style={{ scrollMarginTop: 'var(--lw-header-h, 96px)' }}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-end" wrap="wrap" gap="xs">
          <Box style={{ minWidth: 0 }}>
            <Title order={4}>{SECTION_LABEL[id]}</Title>
            <Text size="sm" c="dimmed">
              {subtitle}
            </Text>
          </Box>
          {views.length > 1 && (
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
        {meta}
        {current?.render()}
      </Stack>
    </Box>
  )
}

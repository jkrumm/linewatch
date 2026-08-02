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
    // `scrollMarginTop` clears the sticky header: an anchor jump that lands the heading under it
    // would send a reader following a verdict link to a section they cannot see the title of.
    <Box component="section" id={sectionAnchor(id)} style={{ scrollMarginTop: 72 }}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-end" wrap="wrap" gap="xs">
          <Box style={{ minWidth: 0 }}>
            <Title order={4}>{SECTION_LABEL[id]}</Title>
            <Text size="sm" c="dimmed">
              {subtitle}
            </Text>
          </Box>
          {views.length > 1 && (
            <SegmentedControl
              size="xs"
              value={current?.key ?? ''}
              onChange={setActive}
              data={views.map((view) => ({ label: view.label, value: view.key }))}
              aria-label={`${SECTION_LABEL[id]} view`}
            />
          )}
        </Group>
        {meta}
        {current?.render()}
      </Stack>
    </Box>
  )
}

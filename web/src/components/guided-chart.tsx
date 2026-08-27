import { Stack, Text } from '@mantine/core'
import { ChartCard } from 'basalt-ui/charts'
import { GuideLink } from 'basalt-ui/content'
import type { ReactNode } from 'react'
import type { ChartCopy } from '../lib/guides'
import { dashboard } from '../lib/dashboard-store'

/**
 * A chart with its explanation one hover (ⓘ) or one click (the guide drawer) away, and no prose
 * of its own on screen.
 *
 * The two registers come from `lib/guides.ts` — see that module for why the third, an always-visible
 * subtitle under every title, was removed. Every chart on the dashboard goes through here so the
 * decision cannot be applied to some charts and not others.
 *
 * The guide is passed as `children`, not `markdown` — see the note in `lib/guides.ts` on why this
 * app renders its own paragraphs rather than pulling in the markdown peers the drawer would need.
 *
 * **`title` is `undefined` outside compact, not `''`.** `ChartCard.title` became optional in
 * basalt-ui 1.26.0 and its header now renders on `info`/`actions` alone, which retired the
 * empty-string sentinel this app used to keep the ⓘ and the guide `?` alive under no title. Exactly
 * one label names a chart block at any time: in full view the section heading does it, in compact
 * there is no heading and the card's title is the only label there is. The four charts that compose
 * `ChartCard` directly (both heatmaps, the speed chart, the bufferbloat chart) follow the same rule
 * and point back here.
 */
export function GuidedChart({
  title,
  copy,
  children,
}: {
  title: string
  copy: ChartCopy
  children: ReactNode
}) {
  const [compact] = dashboard.field.compact.use()

  return (
    <ChartCard
      title={compact ? title : undefined}
      info={copy.tooltip}
      actions={
        <GuideLink title={title} iconOnly>
          <Stack gap="sm">
            {copy.guide.map((para) => (
              <Text key={para.body} size="sm">
                {para.lead !== undefined && <strong>{para.lead} </strong>}
                {para.body}
              </Text>
            ))}
          </Stack>
        </GuideLink>
      }
    >
      {children}
    </ChartCard>
  )
}

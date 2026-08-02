import { Stack, Text } from '@mantine/core'
import { ChartCard } from 'basalt-ui/charts'
import { GuideLink } from 'basalt-ui/content'
import type { ReactNode } from 'react'
import type { ChartCopy } from '../lib/guides'
import { useCardTitle } from '../lib/compact'

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
  const cardTitle = useCardTitle(title)

  return (
    <ChartCard
      title={cardTitle}
      tooltip={copy.tooltip}
      extra={
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

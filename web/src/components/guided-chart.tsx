import { Stack, Text } from '@mantine/core'
import { ChartCard } from 'basalt-ui/charts'
import { GuideLink } from 'basalt-ui/content'
import type { ReactNode } from 'react'
import type { ChartCopy } from '../lib/guides'

/**
 * A chart with its one-line caption visible and its full explanation a click away.
 *
 * The three registers come from `lib/guides.ts`, and the split is the point: the sentence a reader
 * needs in order not to misread the chart is on screen, not behind a hover. Every chart on the
 * dashboard goes through here so that split cannot be applied to some charts and not others.
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
  return (
    <ChartCard
      title={title}
      subtitle={copy.subtitle}
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

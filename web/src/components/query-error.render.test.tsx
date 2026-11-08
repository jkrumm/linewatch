import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { OutageTable } from './outage-table'
import { TransitionTimeline } from './transition-timeline'

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>)
}

describe('section error state', () => {
  test('OutageTable says the load failed, not "No outages in range"', () => {
    const html = render(<OutageTable outages={[]} error={new Error('503 from api')} />)
    expect(html).toContain('Could not load outages')
    expect(html).toContain('503 from api')
    expect(html).not.toContain('No outages in range')
  })

  test('TransitionTimeline says the load failed, not "no transition was observed"', () => {
    const html = render(
      <TransitionTimeline events={[]} linkSamplingSince={1_000} error={new Error('boom')} />,
    )
    expect(html).toContain('Could not load the transition timeline')
    expect(html).not.toContain('No transitions recorded')
  })

  test('an empty OutageTable with no error is still the empty state', () => {
    expect(render(<OutageTable outages={[]} />)).toContain('No outages in range')
  })
})

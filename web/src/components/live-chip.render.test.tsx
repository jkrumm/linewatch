import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { LiveChip, type HeaderLive } from './live-chip'

const NOW = 10_000_000
const LIVE: HeaderLive = { internetMs: 12, latestTs: NOW - 5_000, openOutages: 0, now: NOW }

function render(props: Parameters<typeof LiveChip>[0]): string {
  return renderToStaticMarkup(
    <MantineProvider>
      <LiveChip {...props} />
    </MantineProvider>,
  )
}

describe('LiveChip freshness', () => {
  test('a fresh reading says Up', () => {
    expect(render({ live: LIVE, fetchedAt: NOW - 5_000 })).toContain('Up')
  })

  test('a failed refetch over old data stops saying Up', () => {
    const html = render({ live: LIVE, fetchFailed: true, fetchedAt: NOW - 5_000 })
    expect(html).not.toContain('>Up<')
    expect(html).toContain('Not updating')
  })

  test('data this tab has not refreshed for two cycles stops saying Up, with no error at all', () => {
    const html = render({ live: LIVE, fetchedAt: NOW - 120_000 })
    expect(html).toContain('Not updating')
  })

  test('a failed status query with nothing received names the API, not a bare dash', () => {
    expect(render({ live: null, fetchFailed: true })).toContain('API unreachable')
    expect(render({ live: null })).not.toContain('API unreachable')
  })
})

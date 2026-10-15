import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { uptimeViews } from '../lib/dashboard-store'
import { DashboardSection } from './dashboard-section'

/**
 * `Section`'s own anchor clears 12px, because a shell's page-bar band sits outside the shell's
 * scrollport. This page's bar is sticky in the document scroll, so the anchor has to clear the bar's
 * measured height or a verdict link lands the section heading under it.
 *
 * The non-compact branch is rendered; the compact one cannot be (the compact flag is SSR-false, see
 * `lib/compact.contract.test.ts`), so it is pinned in source.
 */
describe('DashboardSection anchor offset', () => {
  test('the rendered section clears the measured page-bar height', () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <DashboardSection
          id="uptime"
          field={uptimeViews.field.view}
          views={[{ key: 'timeline', label: 'Timeline', render: () => null }]}
        />
      </MantineProvider>,
    )
    expect(html).toContain('scroll-margin-top:var(--basalt-page-bar-h, 0px)')
  })

  test('the compact branch uses the same offset', () => {
    const source = readFileSync(new URL('./dashboard-section.tsx', import.meta.url), 'utf8')
    expect(source.match(/style=\{ANCHOR_STYLE\}/g)?.length).toBe(2)
  })
})

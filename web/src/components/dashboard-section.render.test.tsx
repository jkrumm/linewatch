import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { uptimeViews } from '../lib/dashboard-store'
import { DashboardSection } from './dashboard-section'

/**
 * basalt-ui 2.9.0's `Section` clears a shell-less `PageBar` itself, so the non-compact branch passes
 * no anchor style of its own. The compact branch swaps `Section` for a plain element, which gets no
 * such offset, so it keeps one — and that half is a source test because the compact flag is
 * SSR-false (`lib/compact.contract.test.ts`).
 */
describe('DashboardSection anchor offset', () => {
  test('the rendered section sets no scroll margin of its own', () => {
    const html = renderToStaticMarkup(
      <MantineProvider>
        <DashboardSection
          id="uptime"
          field={uptimeViews.field.view}
          views={[{ key: 'timeline', label: 'Timeline', render: () => null }]}
        />
      </MantineProvider>,
    )
    expect(html).not.toContain('scroll-margin-top:var(--basalt-page-bar-h, 0px)')
    expect(html).toContain('id="section-uptime"')
  })

  test('only the compact branch carries the page-bar offset', () => {
    const source = readFileSync(new URL('./dashboard-section.tsx', import.meta.url), 'utf8')
    expect(source.match(/style=\{ANCHOR_STYLE\}/g)?.length).toBe(1)
  })
})

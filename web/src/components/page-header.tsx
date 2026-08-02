import { Box, Group, Text } from '@mantine/core'
import { ThemeToggle } from 'basalt-ui'
import { RangeSelector } from './range-selector'
import { RANGE_OPTIONS, type RangeOption } from '../lib/range'

/**
 * The page's only chrome: what this is, what window it is showing, and the theme.
 *
 * Sticky, because the range control is the one input on a page that is several screens tall and
 * scoped entirely by it. Unsticky, deciding to look at the last 7 days from the Path section meant
 * scrolling to the top, changing the range, and scrolling back — and the reader who does that twice
 * stops changing the range.
 *
 * It also states, permanently, that the range governs everything below. The one block that it does
 * not govern — the 30-day availability heatmap, whose shape is a fixed hour × day grid — says so
 * itself, on itself. Everything else on the page obeys this control, including the speed
 * percentiles, which used to come from a whole-days server route and answer for a different window
 * than the selector claimed.
 */
export function PageHeader({
  range,
  onRangeChange,
  version,
}: {
  range: RangeOption
  onRangeChange: (range: RangeOption) => void
  version: string
}) {
  return (
    <Box
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 3,
        background: 'var(--mantine-color-body)',
        borderBottom: '1px solid var(--mantine-color-default-border)',
      }}
      py="sm"
      mb="md"
    >
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Group gap="xs" align="baseline">
          <Text fw={700} size="lg">
            linewatch
          </Text>
          <Text size="xs" c="dimmed" ff="monospace">
            {version}
          </Text>
          <Text size="xs" c="dimmed" visibleFrom="md">
            · everything below is the selected window
          </Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <RangeSelector value={range} options={RANGE_OPTIONS} onChange={onRangeChange} />
          <ThemeToggle />
        </Group>
      </Group>
    </Box>
  )
}

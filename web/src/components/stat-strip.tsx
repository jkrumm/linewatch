import { Box, Group, Text, Tooltip } from '@mantine/core'
import { VX } from 'basalt-ui/charts'

export interface Stat {
  /**
   * React key, when the label is not unique within the strip.
   *
   * The Speed section draws `Download p50 · p95 · Upload p50 · p95`, where the two `p95` labels are
   * deliberately identical — each is read against the `p50` beside it, and spelling out
   * "Download p95" twice as wide is worse copy. Keyed on the label those two collided, and React's
   * response to a duplicate key is to drop one of the children.
   */
  id?: string
  label: string
  value: string
  /** A threshold verdict on the value. `undefined` — nothing wrong, or nothing measured — is never
   * tinted: absence is neither a good reading nor a bad one. */
  tone?: 'warn' | 'bad'
  /** What the figure is taken over, or the caveat it carries. Shown on hover; must never be the
   * only place a problem is stated. */
  hint?: string
}

/**
 * A section's headline figures as one line of text, not a grid of cards.
 *
 * `StatCard` is the right shape for the four numbers the page opens with: each is a judgment the
 * reader is meant to stop on, and each carries a sparkline and a window-over-window badge. It is
 * the wrong shape for "Downloaded 41.2 GB", which is one fact with no trend and no threshold — and
 * five of those in a `SimpleGrid` cost 120 px of height to say what fits on one line. Three
 * sections were spending that, which is a screenful of chrome around fifteen numbers.
 *
 * So: label dimmed, value monospace, separated by dots, wrapping on a narrow viewport. The
 * monospace is not decoration — it is what makes a column of figures scannable when they are laid
 * out horizontally rather than in aligned cards.
 *
 * A `tone` marks the value itself rather than the whole strip, because these sit side by side: a
 * tinted card is unambiguous about which figure it judges and a tinted strip would not be.
 */
export function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    <Group gap="md" wrap="wrap" align="baseline" role="list">
      {stats.map((stat) => (
        <Group key={stat.id ?? stat.label} gap={6} wrap="nowrap" align="baseline" role="listitem">
          <Text size="xs" c="dimmed">
            {stat.label}
          </Text>
          <StatValue stat={stat} />
        </Group>
      ))}
    </Group>
  )
}

/** The figure, tinted by its own threshold and carrying its own caveat — never the strip's. */
function StatValue({ stat }: { stat: Stat }) {
  const value = (
    <Text
      size="sm"
      fw={600}
      ff="monospace"
      c={stat.tone === 'bad' ? VX.status.bad : stat.tone === 'warn' ? VX.status.warn : undefined}
      // A dotted underline is the only affordance saying a hover exists. Without it the hint is a
      // fact nobody finds, which is indistinguishable from a fact that was never written.
      style={stat.hint === undefined ? undefined : { textDecoration: 'underline dotted', textUnderlineOffset: 3 }}
    >
      {stat.value}
    </Text>
  )

  if (stat.hint === undefined) return value
  return (
    <Tooltip label={stat.hint} multiline w={280} withArrow>
      <Box>{value}</Box>
    </Tooltip>
  )
}

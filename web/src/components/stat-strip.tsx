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
  /**
   * The figure, or `null` while the query behind it is in flight.
   *
   * `null` renders an untinted `—` and drops the hint. It is not the same as a real `0` and must
   * never be reachable from a computed figure: it means nobody has asked yet. Computing a strip
   * figure from an empty array during a key rotation is how this page briefly claimed a fully
   * unmeasured window, tinted warn, with a hint explaining why — over data it had not requested.
   */
  value: string | null
  /** A threshold verdict on the value. `undefined` — nothing wrong, or nothing measured — is never
   * tinted: absence is neither a good reading nor a bad one. */
  tone?: 'warn' | 'bad'
  /** What the figure is taken over, or the caveat it carries. Shown on hover; must never be the
   * only place a problem is stated. */
  hint?: string
  /** Entries sharing a `group` wrap as one unit. The Speed strip's `p95` label is deliberately bare
   * because it is read against the `Download p50` beside it — and on a narrow viewport flex-wrap
   * was free to put them on different lines, which leaves a `p95` on the page belonging to nothing. */
  group?: string
}

/** Split `stats` into runs of consecutive entries sharing a non-undefined `group`. An ungrouped
 * entry is its own run of one, rendered exactly as before. */
function groupRuns(stats: Stat[]): Stat[][] {
  const runs: Stat[][] = []
  for (const stat of stats) {
    const last = runs.at(-1)
    if (stat.group !== undefined && last !== undefined && last[0]?.group === stat.group) {
      last.push(stat)
    } else {
      runs.push([stat])
    }
  }
  return runs
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
    // A real `ul`/`li`, not a `div` carrying `role="list"`. The roles said the right thing to a
    // screen reader and nothing to anything else; the elements say it to both, and `listStyle:
    // none` is the whole cost. `Group` keeps the flex layout either way.
    <Group component="ul" gap="md" wrap="wrap" align="baseline" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {groupRuns(stats).map((run) => {
        const runKey = run[0]?.id ?? run[0]?.label ?? ''
        if (run.length === 1) {
          const stat = run[0]
          if (stat === undefined) return null
          return (
            <Group component="li" key={runKey} gap={6} wrap="nowrap" align="baseline">
              <Text size="xs" c="dimmed">
                {stat.label}
              </Text>
              <StatValue stat={stat} />
            </Group>
          )
        }
        return (
          <Group component="li" key={runKey} gap="md" wrap="nowrap">
            {run.map((stat) => (
              <Group key={stat.id ?? stat.label} gap={6} wrap="nowrap" align="baseline">
                <Text size="xs" c="dimmed">
                  {stat.label}
                </Text>
                <StatValue stat={stat} />
              </Group>
            ))}
          </Group>
        )
      })}
    </Group>
  )
}

/** The figure, tinted by its own threshold and carrying its own caveat — never the strip's. */
function StatValue({ stat }: { stat: Stat }) {
  if (stat.value === null) {
    return (
      <Text size="sm" fw={600} ff="monospace" c="dimmed">
        —
      </Text>
    )
  }

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
    // touch + focus, not Mantine's hover-only default: the dotted underline is an affordance for
    // information a phone could not open and a keyboard could not reach, and these hints are where
    // the page states its floors and its coverage caveats.
    <Tooltip label={stat.hint} multiline w={280} withArrow events={{ hover: true, focus: true, touch: true }}>
      <Box tabIndex={0}>{value}</Box>
    </Tooltip>
  )
}

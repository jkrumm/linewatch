import { Box, Group, Text } from '@mantine/core'
import { VX } from 'basalt-ui/charts'
import { isStale } from '../lib/freshness'
import { fmtMs, fmtRelative } from '../lib/format'

/**
 * The three facts the sticky page bar carries while the page is scrolled — and only three.
 *
 * `StatusBar` below states the same verdict, and that repetition is the point of a sticky bar: a
 * reader four sections down can see whether the line is up right now without scrolling back. What
 * keeps it from being noise is that the chip and the bar say different amounts. The chip says the
 * VERDICT WORD, and at wider viewports the newest internet median and its age. The bar says the
 * verdict as a sentence with its reason (when it started, how long so far, why the state is
 * unknown), BOTH readings with what each is a median OF, the loss on each, the "N of M answering"
 * partial state, and per-reading staleness. The chip never states a reason and never states loss;
 * the bar never states a bare word without one.
 *
 * They cannot contradict each other because they are computed from the same three helpers —
 * `liveInternet`, `latestSampleTs`, `isStale` — over the same `now`.
 */
export interface HeaderLive {
  /** `liveInternet(lastSamples).medMs` — null when nothing answered. */
  internetMs: number | null
  /** `latestSampleTs(lastSamples)` — null when the collector has never reported. */
  latestTs: number | null
  /** `ongoingOutages.length`. */
  openOutages: number
  /** The dashboard's 30 s freshness clock (`nowTick`) — never the window's `to`, which can be five
   * minutes behind and would make `isStale` compute a negative age and never fire. */
  now: number
}

/**
 * The verdict, one word, plus as much evidence as the viewport can hold.
 *
 * It rides `PageBar.actions.secondary` as a `kind: 'custom'` node with **`mobile: 'bar'`**, which is
 * not optional: a custom secondary defaults to `'more'`, and folding this into the kebab would hide
 * whether the line is up behind a tap on the one viewport that can see the least of the page at
 * once — the exact thing the shedding order below exists to prevent.
 *
 * It sheds from the least load-bearing end: the age goes first (below `md`), then the ping (below
 * `sm`), and the coloured dot with its word is what is left at 360px. The verdict is never dropped.
 *
 * **`reporting` is checked before `openOutages`, not after.** `openOutages > 0` used to win
 * outright, so a collector that died mid-outage kept the chip red "Outage" forever off a frozen
 * `live.internetMs` — the bar's own version of the container-ICMP failure mode: a stale reading
 * rendered as a current one. `StatusBar` (directly below this chip) already treats these as two
 * separate facts and renders both — a yellow "not reporting" line AND a red outage line at once.
 * This compact chip has room for one word, so it can't literally do that, but it still has to say
 * "this is stale" rather than silently keep asserting "Outage" as though the read were live: `!
 * reporting` downgrades the colour to the same warn yellow `StatusBar` uses for its own
 * not-reporting state, while the word stays "Outage"/"N outages" — the last fact this dashboard
 * actually has, carried at the honest (uncertain) tone rather than the confident (still-happening)
 * one.
 */
export function LiveChip({
  live,
}: {
  /** `null` while `GET /api/status` has not resolved. The chip renders a dash, never "Up" — an
   * unanswered status query is not evidence the line is working, which is the same rule
   * `StatusBar`'s verdict column enforces and the reason `reporting` gates green there. */
  live: HeaderLive | null
}) {
  if (live === null) {
    return (
      <Text size="sm" c="dimmed" ff="monospace">
        —
      </Text>
    )
  }

  const reporting = live.latestTs !== null && !isStale(live.latestTs, live.now)
  const state =
    live.openOutages > 0
      ? {
          // Bad only while the reading is current — see this function's own docblock. A frozen
          // outage reads as unresolved uncertainty (warn), not a live emergency (bad).
          color: reporting ? VX.status.bad : VX.status.warn,
          word: live.openOutages > 1 ? `${live.openOutages} outages` : 'Outage',
        }
      : !reporting
        ? { color: VX.status.warn, word: 'No data' }
        : // `VX.status.good` is the one place green is allowed in the page bar — it is verdict text,
          // the same rule `verdict-panel.tsx`'s `SEVERITY_COLOR` already carries. No `StatCard`, no
          // rail, no green anywhere else in this component.
          { color: VX.status.good, word: 'Up' }

  return (
    <Group gap={6} wrap="nowrap" align="center">
      {/* An 8px status dot, not a panel surface — no radius token expresses a circle (50%), and the
          fill tracks a per-scheme `VX.status.*` token, not a raw colour. */}
      <Box
        w={8}
        h={8}
        // theme-allow raw-surface — a circular dot, not a card corner: no radius token is 50%
        style={{ borderRadius: '50%', background: state.color, flexShrink: 0 }}
      />
      <Text size="sm" fw={600} c={state.color} style={{ whiteSpace: 'nowrap' }}>
        {state.word}
      </Text>
      {/* Struck through and dimmed once stale — the same treatment `status-bar.tsx`'s `Reading`
          gives the identical figure a few rows down. Undimmed, a collector dead for three days
          still showed "12.4 ms" with nothing on the figure itself saying it was three days old. */}
      <Text
        size="sm"
        ff="monospace"
        c="dimmed"
        td={reporting ? undefined : 'line-through'}
        visibleFrom="sm"
      >
        {fmtMs(live.internetMs)}
      </Text>
      <Text size="xs" ff="monospace" c="dimmed" visibleFrom="md">
        {live.latestTs === null ? 'no data' : fmtRelative(live.latestTs, live.now)}
      </Text>
    </Group>
  )
}

import { useLayoutEffect } from 'react'
import { Box, Group, Stack, Text, Tooltip } from '@mantine/core'
import { useElementSize } from '@mantine/hooks'
import { ThemeToggle } from 'basalt-ui'
import { VX } from 'basalt-ui/charts'
import { RangeSelector } from './range-selector'
import { CompactToggle } from './compact-toggle'
import { RANGE_OPTIONS, type RangeOption } from '../lib/range'
import { isStale } from '../lib/freshness'
import { fmtMs, fmtRelative } from '../lib/format'

/** The range control's tooltip, on both layout paths (`visibleFrom="sm"` and `hiddenFrom="sm"`
 * below) — one constant so the two copies can't drift, and short enough that duplicating it twice
 * in the rendered DOM still costs less than the old permanent caption did once. */
const RANGE_SCOPE_HINT = 'This window covers every figure below, except the 30-day heatmap — it says so on itself.'

/**
 * The three facts the sticky header carries while the page is scrolled — and only three.
 *
 * The strip below states the same verdict, and that repetition is the point of a sticky header: a
 * reader four sections down can see whether the line is up right now without scrolling back. What
 * keeps it from being noise is that the header and the strip say different amounts. The header says
 * the VERDICT WORD, and at wider viewports the newest internet median and its age. The strip says
 * the verdict as a sentence with its reason (when it started, how long so far, why the state is
 * unknown), BOTH readings with what each is a median OF, the loss on each, the "N of M answering"
 * partial state, and per-reading staleness. The header never states a reason and never states loss;
 * the strip never states a bare word without one.
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
 * The page's only chrome: what this is, the range control, the theme, and — new — live status.
 *
 * Sticky, because the range control is the one input on a page that is several screens tall and
 * scoped entirely by it. Unsticky, deciding to look at the last 7 days from the Path section meant
 * scrolling to the top, changing the range, and scrolling back — and the reader who does that twice
 * stops changing the range.
 *
 * It used to also state, permanently, that the range governed everything below — one sentence,
 * visible from `md` up, never changing. That was a caption restating a control the reader could
 * already see, occupying the one row of a sticky bar that persists across the whole scroll. What
 * replaced it is a verdict the reader cannot see once they have scrolled past `NowStrip`: whether
 * the line is up right now. `LiveChip` degrades by shedding the least load-bearing evidence first
 * (age, then ping) but never drops the word itself — see that component's own docblock.
 */
export function PageHeader({
  range,
  onRangeChange,
  version,
  live,
}: {
  range: RangeOption
  onRangeChange: (range: RangeOption) => void
  version: string
  /** `null` while `GET /api/status` has not resolved. The chip renders a dash, never "Up" — an
   * unanswered status query is not evidence the line is working, which is the same rule
   * `NowStrip`'s verdict column enforces and the reason `reporting` gates green there. */
  live: HeaderLive | null
}) {
  const { ref, height } = useElementSize()

  useLayoutEffect(() => {
    // `section.tsx` clears the sticky header with `scrollMarginTop`, and that offset was a hardcoded
    // 72 — right for the one-row desktop header and ~24px short of the two-row mobile one, so every
    // "See the Uptime section ↓" jump on a phone landed the heading underneath the bar this margin
    // exists to clear. It is a measurement now, published on the root element because the two
    // components are siblings and there is no other seam between them.
    //
    // `height > 0` guards the mount pass: `useElementSize`'s ResizeObserver has not fired yet on
    // first render, so `height` is `0` — and a CSS var written as `0px` is not "unset", so
    // `section.tsx`'s `var(--lw-header-h, 96px)` fallback never applies. A fragment scroll resolved
    // in that window (a `#section-uptime` deep link on cold load) landed the heading fully under the
    // sticky bar — the exact landing this whole mechanism exists to prevent. Skipping the zero write
    // leaves the CSS fallback in force until the observer reports a real measurement.
    if (height <= 0) return
    document.documentElement.style.setProperty('--lw-header-h', `${Math.round(height)}px`)
  }, [height])

  return (
    <Box
      ref={ref}
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 3,
        background: 'var(--mantine-color-body)',
        borderBottom: '1px solid var(--mantine-color-default-border)',
      }}
      py="xs"
      // No `mb`. This header is the first child of the page's own `Stack`, so its gap already
      // separates it from the bar below — a margin here was added on top of that gap, not instead
      // of it, putting 38px of nothing under a sticky header on a page whose whole brief is
      // density.
      // Full-bleed across the root Container's gutters. Without it the sticky background stops at
      // the content box and the page scrolls visibly through the 13px strips either side of it.
      mx={{ base: 'calc(-1 * var(--mantine-spacing-sm))', sm: 'calc(-1 * var(--mantine-spacing-lg))' }}
      px={{ base: 'sm', sm: 'lg' }}
    >
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Group gap="xs" align="baseline" style={{ minWidth: 0 }}>
            <Text fw={700} size="lg">
              linewatch
            </Text>
            <Text size="xs" c="dimmed" ff="monospace" visibleFrom="sm">
              {version}
            </Text>
          </Group>
          <Group gap="sm" wrap="nowrap">
            {/* Above `sm` the selector rides this row, beside the live chip and the toggle — see the
                `hiddenFrom="sm"` row below for why it moves below `sm` instead. */}
            <Box visibleFrom="sm">
              <Tooltip
                label={RANGE_SCOPE_HINT}
                multiline
                w={280}
                withArrow
                events={{ hover: true, focus: true, touch: true }}
              >
                <Box>
                  <RangeSelector value={range} options={RANGE_OPTIONS} onChange={onRangeChange} />
                </Box>
              </Tooltip>
            </Box>
            <LiveChip live={live} />
            <CompactToggle />
            <ThemeToggle />
          </Group>
        </Group>
        {/* The range control gets its own row below `sm`. Letting flex-wrap decide put it there
            anyway — at 390px the two groups measure ~394px against 364px — but at an unpredictable
            height, which is what silently broke every verdict anchor's 72px scroll offset. */}
        <Box hiddenFrom="sm">
          <Tooltip
            label={RANGE_SCOPE_HINT}
            multiline
            w={280}
            withArrow
            events={{ hover: true, focus: true, touch: true }}
          >
            <Box>
              <RangeSelector value={range} options={RANGE_OPTIONS} onChange={onRangeChange} fullWidth />
            </Box>
          </Tooltip>
        </Box>
      </Stack>
    </Box>
  )
}

/**
 * The verdict, one word, plus as much evidence as the viewport can hold.
 *
 * It sheds from the least load-bearing end: the age goes first (below `md`), then the ping (below
 * `sm`), and the coloured dot with its word is what is left at 360px. The verdict is never dropped —
 * a header that hides whether the line is up on the viewport that can see the least of the page at
 * once is the wrong thing to save 60px on.
 *
 * **`reporting` is checked before `openOutages`, not after.** `openOutages > 0` used to win
 * outright, so a collector that died mid-outage kept the chip red "Outage" forever off a frozen
 * `live.internetMs` — the header's own version of the container-ICMP failure mode: a stale reading
 * rendered as a current one. `NowStrip` (the strip directly below this chip) already treats these as
 * two separate facts and renders both — a yellow "not reporting" line AND a red outage line at once.
 * This compact chip has room for one word, so it can't literally do that, but it still has to say
 * "this is stale" rather than silently keep asserting "Outage" as though the read were live: `!
 * reporting` downgrades the colour to the same warn yellow `NowStrip` uses for its own not-reporting
 * state, while the word stays "Outage"/"N outages" — the last fact this dashboard actually has,
 * carried at the honest (uncertain) tone rather than the confident (still-happening) one.
 */
function LiveChip({ live }: { live: HeaderLive | null }) {
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
        : // `VX.status.good` is the one place green is allowed in this header — it is verdict text,
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
        style={{ /* theme-allow: circular dot, not a card/panel corner */ borderRadius: '50%', background: state.color, flexShrink: 0 }}
      />
      <Text size="sm" fw={600} c={state.color} style={{ whiteSpace: 'nowrap' }}>
        {state.word}
      </Text>
      {/* Struck through and dimmed once stale — the same treatment `now-strip.tsx`'s `Reading`
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

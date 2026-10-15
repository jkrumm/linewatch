// MIGRATION-STUB(w6): the MultiLine speed chart (download/upload traces, reference lines, ref legend)
import { ChartCard } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'

/**
 * A horizontal reference at a rate the line is measured against — the host's negotiated link speed,
 * the carrier's sync rate.
 *
 * `label` is supplied by the caller and must be derived from the live reading it marks. This
 * component authors no sentence about what a reference means, because any such sentence names a
 * link speed that stops being true the moment the NIC renegotiates — which on this host
 * demonstrably happens. A caller with a null or stale input passes no ref line at all rather than
 * a stale one.
 */
export type SpeedRefLine = {
  value: number
  label: string
  color: string
}

/**
 * Every speed-test run in the window, download against upload.
 *
 * **Titled for its own section, which is the rule now: a chart's title is its section's word.**
 * "Speed" here, "Throughput" a screen down, "Ping" and "Connection health" above. That is not
 * redundancy with the heading — in compact the heading is gone and this title is the only label the
 * card has, so it has to carry the section's meaning on its own.
 *
 * The hazard the old title ("Speed test runs") was avoiding is still avoided, and it is worth
 * restating because the fix looks superficially like the bug: this chart was once called
 * "Throughput", the name of a DIFFERENT section measuring a different thing — what the line
 * actually carried, from the interface counters, rather than what it managed when asked to
 * saturate. One word for two measurements a screen apart is the confusion the Speed/Throughput
 * split exists to prevent. Each chart now takes its OWN section's word, so no word is used twice.
 */
export function SpeedChart(_props: {
  tests: SpeedTest[]
  refLines?: SpeedRefLine[]
  /**
   * True while the speed-tests query is in flight.
   *
   * `tests ?? []` drew an axis with no points on it — which on a run-series chart is the claim
   * "no speed test ran in this window", not "nobody has asked yet".
   *
   * Handed straight to `MultiLine` now. It used to be branched here, onto an app-side
   * `PendingChart`, because the kind sat inside this chart's own `ResponsiveChart` and its
   * `ChartFrame` therefore never mounted until a `ResizeObserver` had fired — invisible to the
   * server-rendered guard. `ChartFrame` floors its plot rect at `minWidth` (200px) as of 1.15.0,
   * so it renders `ChartPending` whether or not anything has been measured, and the app-side
   * scaffolding is gone.
   *
   * The ref-line legend below is this app's own rather than `ChartFrame`'s, so it still needs
   * suppressing explicitly: a dashed "Host link 1000 Mbit" caption over a plot with no runs on it
   * names a ceiling for measurements that are not on screen.
   */
  isPending?: boolean
}) {
  return <ChartCard state={{ empty: 'Migrating to basalt-ui 2.0' }} />
}

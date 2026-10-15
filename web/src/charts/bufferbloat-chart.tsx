// MIGRATION-STUB(w6): the MultiLine idle/loaded latency chart
import { ChartCard } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'

/** Idle vs loaded latency, per DESIGN.md's "Speed" view ("loaded-vs-idle latency"). The chart
 * plots the three stored measurements and names none of them a verdict: whether the gap between
 * them is a problem, and on which leg, is the verdict layer's sentence to write from the numbers,
 * not a literal authored here. */
export function BufferbloatChart(_props: {
  tests: SpeedTest[]
  /** True while the speed-tests query is in flight, handed straight to `MultiLine` — see
   * `speed-chart.tsx`'s docblock for why this stopped being an app-side branch in 1.15.0. An empty
   * run series here draws three named latency lines with nothing under them, which reads as three
   * measurements that came back empty. */
  isPending?: boolean
}) {
  return <ChartCard state={{ empty: 'Migrating to basalt-ui 2.0' }} />
}

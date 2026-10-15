// MIGRATION-STUB(w7): the hourly speed heatmap (CategoryGrid cells, legend, tooltips)
import { ChartCard } from 'basalt-ui/charts'
import type { SpeedTest } from '../lib/types'

/** Hourly "when is the line slow" heatmap, per DESIGN.md's "Speed" view.
 *
 * Three cell states, because a failed run used to be dropped by a bare `return []` and so became
 * pixel-identical to an hour nothing ran in: measured, hatched-warn for an hour whose only runs
 * errored, and hatched-neutral for an hour with no run at all. */
export function SpeedHeatmap(_props: {
  tests: SpeedTest[]
  from: number
  to: number
  /**
   * True while the speed-tests query behind this grid is in flight.
   *
   * `tests ?? []` produced an empty run list, which is not an empty grid: every cell became
   * `absent` and every tooltip read "No run · Not measured", so the pending state rendered as a
   * flat claim that thirty days of hourly speed tests had never fired. The legend said it too —
   * "No successful run", derived from a `fastest` of `null`. Three separate assertions about the
   * line, all of them over a question nobody had answered yet.
   */
  isPending?: boolean
}) {
  return <ChartCard state={{ empty: 'Migrating to basalt-ui 2.0' }} />
}

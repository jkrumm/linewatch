// MIGRATION-STUB(w7): the 30-day hourly availability heatmap (CategoryGrid cells, legend, tooltips)
import { ChartCard } from 'basalt-ui/charts'
import type { ProbeBucket } from '../lib/types'

/**
 * The bucket size this grid is a grid OF. Exported so the route's query and the chart cannot
 * disagree: one cell is one hour, and any other bucket size would put two readings in one cell.
 */
export const AVAILABILITY_BUCKET_SECONDS = 3_600

/** Day × hour availability grid, per DESIGN.md's "Uptime" view. Always the trailing 30 days
 * regardless of the outage list's own range filter — the two answer different questions ("when,
 * over the recent past, did the line dip" vs "list every outage in this period").
 *
 * Rows and columns come from the requested window, not from the returned buckets. A day nothing
 * was recorded on never entered the old `rows` array at all, so the calendar quietly closed up and
 * 30 days of history could render as three — with every drawn cell true and the picture false.
 *
 * Intensity is the bucket's aggregate `lossPct`, not `maxLossPct`: a single lost cycle in an hour
 * is ~0.03% of that hour, and colouring the cell by the worst cycle painted the whole hour as
 * fully down. The worst cycle and the fully-down count stay in the tooltip, where they inform
 * rather than mislead.
 *
 * **`isPending` guards the same fabrication `ThroughputChart` had to be given its own for.** The
 * heatmap's query is not in the route loader either, so on the pattern view's first render
 * `heatmapData?.buckets ?? []` densified to every cell hatched-absent and every tooltip reading "0
 * of 30 expected cycles" — a claim, over a window nobody had asked about, that thirty days of
 * measurement came back empty. Hatching happens to be the conservative reading here (it never
 * claims the line was up), which is the one thing that kept this milder than `ThroughputChart`'s
 * version of the same bug — but it is the same class, and the fix is the same `isPending` prop. */
export function AvailabilityHeatmap(_props: {
  buckets: ProbeBucket[]
  from: number
  to: number
  /** True while the probe-buckets query behind this grid is in flight — see the component docblock. */
  isPending?: boolean
}) {
  return <ChartCard state={{ empty: 'Migrating to basalt-ui 2.0' }} />
}

import { MultiLine, ResponsiveChart, VX } from 'basalt-ui/charts'
import type { LatencyComparePoint } from '../lib/aggregate'
import { fmtMs } from '../lib/format'
import { AXIS_LABEL_PX, fitTickCount } from '../lib/axis'

/**
 * The LAN and the internet on one axis — the comparison the four stacked per-target charts made
 * the reader perform by eye.
 *
 * Only medians, and deliberately no p5–p95 band: four overlapping bands on one axis is mud, and
 * the band is exactly what the per-target view still draws in full. This chart answers "which side
 * of the router is it" and hands off; it is not a replacement for the per-target detail and must
 * never grow into one.
 *
 * The two hues are `VX.accent`/`VX.line` — the same pair `SpeedChart` uses for its two series.
 * Not `VX.line`/`VX.line2`: both resolve to plain greys (`--vx-line`/`--vx-line2`) that read as
 * one indistinct hue against the dark panel background. A categorical palette proper would mean
 * registering a series map and emitting its CSS (`buildPaletteCss`), which this dashboard has
 * never needed; two series do not justify it.
 */
export function LatencyCompareChart({ points }: { points: LatencyComparePoint[] }) {
  // `MultiLine` measures its own width but exposes only a tick *count* (`numTicksX`), so the count
  // has to be derived from a width measured out here. A fixed count cannot work: eight ticks are
  // comfortable at 1130px and overlap three times over at 390px.
  return (
    <ResponsiveChart height={COMPARE_HEIGHT}>
      {({ width }) => (
        <CompareLines
          points={points}
          numTicksX={fitTickCount(points.length, Math.max(2, Math.floor(width / AXIS_LABEL_PX)), width)}
        />
      )}
    </ResponsiveChart>
  )
}

const COMPARE_HEIGHT = 280

function CompareLines({ points, numTicksX }: { points: LatencyComparePoint[]; numTicksX: number }) {
  return (
    <MultiLine
      data={points}
      chartId="latency-compare"
      numTicksX={numTicksX}
      // `label`, not `key`. `MultiLine` renders its x-axis through `basalt-ui`'s `fmtAxisDate` and
      // forwards no `tickFormat`, and that formatter reduces any ISO string to `DD.MM` — so keying
      // on `key` drew a 24 h window as `31.07` repeated a dozen times. `fmtAxisDate` passes a
      // non-ISO string through untouched, so the pre-formatted label reaches the axis intact. It is
      // unique per bucket by construction (`bucketAxisLabel`), which the band scale requires.
      getX={(p) => p.label}
      series={[
        {
          key: 'gateway',
          label: 'Router',
          color: VX.line,
          mark: 'line',
          getValue: (p) => p.gatewayMs,
          // A bucket that lost packets gets a dot on both lines. The value is still the median of
          // what came back, and a median over a lossy bucket looks identical to a clean one — the
          // marker is the only thing that says the reading is thinner than it appears.
          getMarker: (p) => (p.worstLossPct > 0 ? { color: VX.status.bad } : null),
        },
        {
          key: 'wan',
          label: 'Internet (median of 3)',
          color: VX.accent,
          mark: 'line',
          getValue: (p) => p.wanMs,
          getMarker: (p) => (p.worstLossPct > 0 ? { color: VX.status.bad } : null),
        },
      ]}
      yDomain="auto"
      formatValue={fmtMs}
      height={COMPARE_HEIGHT}
      // States the WAN line's own basis at every point it is read. A three-anchor median and a
      // one-anchor median are different claims and the line cannot show which it is drawing; a
      // bucket where two anchors went missing would otherwise read as an ordinary WAN reading.
      renderExtraTooltipRows={(p) => (
        <span style={{ color: VX.tooltipMuted, fontSize: VX.text.micro }}>
          {p.wanAnchors === 0
            ? 'No internet anchor answered in this bucket'
            : `Internet median over ${p.wanAnchors} of 3 anchors${p.worstLossPct > 0 ? ` · worst loss ${p.worstLossPct.toFixed(1)}%` : ''}`}
        </span>
      )}
    />
  )
}

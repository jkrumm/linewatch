---
name: basalt-charts
description: Add or extend a chart in a basalt-ui app — pick a shipped kind or compose CartesianChart, register series colors, verify.
when_to_use: User wants to add or restyle a chart, introduce a metric and its color, or extract a repeated chart shape. Companion to /basalt-design.
---

Procedure only; the contract is `.claude/rules/basalt-charts.md`.

## Steps

1. Pick the path: a shipped kind fits (`Lines`, `Bars`, `Sparkline`, `StackedArea`, `DualPanel`, `MirroredBars`, `BandStrip`, `Donut`, `Heatmap`) → use it. A second chart of a shape with no kind → extract a kind and migrate both call sites. Otherwise compose `CartesianChart` in the page's own chart file.
2. Register each new series color in the app's one series file (exempt from `check-theme`): `groupTokens('health', defineSeries({ hrv: { light, dark } }))` from `basalt-ui/tokens` (lighter on dark, deeper on light), then pass the group as `<BasaltProvider paletteOptions={{ groups: [SERIES] }} />` (or `buildPaletteCss` for SSR).
3. Compose the chart; import marks from the allowed `@tanstack/charts/*` subpaths:

```tsx
import { lineY } from '@tanstack/charts/line'
import { rect } from '@tanstack/charts/rect'

const [RAIL_PX, Y_MIN, Y_MAX] = [3, 0, 100] // px along the top of a [Y_MIN, Y_MAX] plot
const railTop = (plotHeight: number) => Y_MAX - (RAIL_PX * (Y_MAX - Y_MIN)) / plotHeight
;<CartesianChart
  ariaLabel="HRV"
  data={data}
  x={(d) => d.date}
  series={[{ key: 'hrv', label: 'HRV', color: SERIES.hrv, getValue: (d) => d.hrv }]}
  marks={(plot) => [
    ...plot.visible.map((s) => lineY(plot.rows(s.key), { x: 'x', y: 'y', stroke: s.color })),
    // `plot.plotHeight` is the plot (`plot.height` the frame); `plot.data` is every raw row; `fillOpacity`
    // is one number per mark, so bucket a measured opacity: one mark per step.
    ...[...Map.groupBy(plot.data, (d) => Math.round(d.loss * 20) / 20)].map(([o, r]) =>
      rect(r, { x1: 'at', y1: railTop(plot.plotHeight), y2: Y_MAX, fillOpacity: o }),
    ),
  ]}
/>
```

4. Wrap it in `ChartCard`; pass `state={{ pending, error, empty }}` from the query. A `cursorValue` series colours its cursor dot per datum with `getMarker: (d) => ({ color })`.
5. Run the repo's own gate (e.g. `make check`), which runs lint, the theme guard and typecheck; fix every finding at its source.
6. Check both color schemes and a pending query.

---
name: basalt-charts
description: Add or extend a chart in a basalt-ui app — pick a shipped kind or compose CartesianChart, register series colors, verify.
when_to_use: User wants to add or restyle a chart, introduce a metric and its color, or extract a repeated chart shape. Companion to /basalt-design.
---

Procedure only; the contract is `.claude/rules/basalt-charts.md`.

## Steps

1. Pick the path: a shipped kind fits (`Lines`, `Bars`, `Sparkline`, `StackedArea`, `DualPanel`, `MirroredBars`, `BandStrip`, `Donut`, `Heatmap`) → use it. A second chart of a shape with no kind → extract a kind and migrate both call sites. Otherwise compose `CartesianChart` in the page's own chart file.
2. Register each new series color in the app's one series file (exempt from `check-theme`):

```ts
import { defineSeries, groupTokens } from 'basalt-ui/tokens'

const HEALTH = defineSeries({ hrv: { light: '…', dark: '…' } }) // lighter on dark, deeper on light
export const SERIES = groupTokens('health', HEALTH)
```

3. Pass the group as `<BasaltProvider paletteOptions={{ groups: [SERIES] }} />` (or `buildPaletteCss` for SSR) so its vars are declared.
4. Compose the chart; import marks from the allowed `@tanstack/charts/*` subpaths:

```tsx
import { lineY } from '@tanstack/charts/line'

;<CartesianChart
  ariaLabel="HRV"
  data={data}
  x={(d) => d.date}
  series={[{ key: 'hrv', label: 'HRV', color: SERIES.hrv, getValue: (d) => d.hrv }]}
  marks={(plot) =>
    plot.visible.map((s) => lineY(plot.rows(s.key), { x: 'x', y: 'y', stroke: s.color }))
  }
/>
```

5. Wrap it in `ChartCard`; pass `state={{ pending, error, empty }}` from the query.
6. Run the repo's own gate (e.g. `make check`), which runs lint, the theme guard and typecheck; fix every finding at its source.
7. Check both color schemes and a pending query.

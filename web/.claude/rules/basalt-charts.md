---
source: basalt-ui
description: Charts on TanStack Charts — compose CartesianChart or a shipped kind, never the engine host.
paths:
  - 'src/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `bun scripts/check-coverage.ts --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — raw-color-fn, raw-hex · oxlint rules — basalt/chart-engine-boundary, basalt/chart-in-raw-surface -->
<!-- not guarded: — -->
<!-- /basalt:coverage -->

# Basalt Charts

Every cartesian chart is `CartesianChart` or a kind built on it; props are in the shipped types.

## Composition

- Use a shipped kind (`Lines`, `Bars`, `Sparkline`, …) when one fits; otherwise compose `CartesianChart` with `marks`. [type CartesianChart]
- `ariaLabel` is required on every chart. [type CartesianChartProps]
- `marks(plot)` returns engine marks and nothing else; margins, scales, axes, grid, cursor, legend and tooltip are the host's. [type ChartMarks]
- Supply `series` once; legend entries and tooltip rows derive from it. [type ChartSeries]
- Draw `plot.rows(key)` and `plot.visible`, never the `series` prop, so a legend toggle hides the mark; `plot.data` is for bucket-level marks only, and a px size reads `plot.plotHeight`, never the frame `plot.height`. [type PlotContext]
- A second axis is `y2` with a series `axis: 'right'`; there is no margin prop. [type CartesianChartProps]
- Size is `height` (a number or per container class); the host measures the width. [type ResponsiveChartHeight]
- A pending, failed or empty query is `state={{ pending, error, empty }}`, never `data ?? []`; a streamed chart's `<Suspense>` fallback is the same chart with `state={{ pending: true }}`, which fills the final box; inside a `ChartCard` the card owns `state` (header kept, body swapped), the kind only when bare. [type ChartState] [type ChartCardProps]
- Zones, thresholds and reference lines are `zones`, `xZones` and `refLines` data; charts sharing a cursor over different extents pass one `xDomain` (time/number x only; a band or string x ignores it). [type ZoneSpec]
- Extra tooltip rows are `tooltip.rows` data, never markup. [type ChartTooltipConfig]
- Charts share one cursor by default; `cursorGroup` isolates one, `chartCursor(group?)` reads it. [type chartCursor]

## Boundaries

- `@visx/*` is banned. [basalt/chart-engine-boundary]
- Import engine marks only from `@tanstack/charts/{line,area,area-x,bar,rect,rule,dot,tick,text,vector,link,arrow,difference,stack,scales/*,transform/*,mark/decorative,d3/shape,types}`; the bare root and `@tanstack/charts/react` are errors. [basalt/chart-engine-boundary]
- Wrap a chart kind in `ChartCard`, never a raw `Card` or `Paper`; its headline figure and period go in `facts`, not a filler `subtitle`. [basalt/chart-in-raw-surface] [type ChartCardProps]
- Series colors are `{ light, dark }` pairs from the app's series file (`defineSeries`); write no hex or `rgba()` in a chart file. [check-theme raw-hex] [check-theme raw-color-fn]

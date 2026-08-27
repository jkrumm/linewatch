---
name: basalt-charts
description: Add or extend a chart in a basalt-ui app — the procedure: pick a shipped kind vs extract one vs stay bespoke (Rule of Three), register the consumer series with defineSeries/groupTokens, compose CartesianChart (or ChartFrame for a non-single-plot shape), then verify against the guards. Use when adding a chart, a new metric/series color, or extracting a repeated chart shape.
when_to_use: User wants to add a chart, restyle one structurally, introduce a new metric/series and its color, extract a recurring chart shape into a reusable kind, or asks where chart series colors live and how to register them. The how-to companion to /basalt-design, which owns the aesthetic law.
---

`/basalt-charts` is the HOW. `.claude/rules/basalt-charts.md` is the contract everything below
assumes, and `/basalt-design` owns the aesthetic law — read both before writing chart code. The
props themselves are in the shipped types and `llms.txt` at the install directory.

## 1. Pick the path (Rule of Three)

1. **A shipped kind fits** → use it. `ZonedLine`, `Bars`, `StackedArea`, `MultiLine`, `DualPanel`,
   `Heatmap`, `Donut`, `BandStrip`, `MirroredBars`. Read their props before assuming a gap: dual
   axis, zones, thresholds, refLines, per-point markers, folding, per-series formatting and
   `isPending` are all declarative already.
2. **This is the SECOND instance of a shape with no kind** → extract a kind and migrate both call
   sites. Not on the first, not past the third.
3. **Genuinely unique** → stay bespoke in the page's own chart file, composing the primitive
   directly. Not in a shared kinds directory.

**Extracting a kind? Prove it by porting.** Move real call sites onto it and ship the list of what
it could NOT express. A demo page is written against the API that already exists, so it proves
nothing.

## 2. Register the series (this is consumer data)

`VX.series` does not exist in the framework — which metric owns which hue is domain data, declared
in ONE guard-exempt file per app:

```ts
// src/lib/series.ts — the one file exempt from check-theme, because it IS the palette source
import { buildPaletteCss, defineSeries, groupTokens, seriesTokens } from 'basalt-ui/tokens'

const HEALTH = defineSeries({ hrv: { light: '…', dark: '…' } }) // lighter on dark, deeper on light
export const SERIES = { ...seriesTokens(HEALTH), walking: groupTokens('walking', WALKING) }
export const PALETTE_CSS = buildPaletteCss({ groups: { '': HEALTH, 'walking-': WALKING } })
```

`seriesTokens`/`groupTokens` are exact-keyed, so a stale or typo'd key fails `tsc`. Feed the SAME
maps to `buildPaletteCss` (or `BasaltProvider`'s `paletteOptions.groups`, keyed by var PREFIX — the
trailing dash matters) or the refs point at variables nothing declares.

## 3. Compose the primitive

A single-plot chart composes `CartesianChart` and draws only marks in the render prop — margins,
scales, axes, grid, the shared cursor, crosshair, dots and tooltip are already done:

```tsx
<CartesianChart data={data} chartId="hrv" getX={(d) => d.date} series={HRV} y={{ domain: 'auto' }} height={240}>
  {({ xScale, yScale, visible }) =>
    visible.map((s) => <LinePath key={s.key} data={data} x={…} y={…} stroke={s.color} />)
  }
</CartesianChart>
```

- **Draw `visible`, never the `series` prop** — otherwise a legend toggle hides nothing.
- **Dual axis is `y2`**, not a flag; a series opts in with `axis: 'right'`.
- **A multi-pane, radial or matrix shape composes `ChartFrame`** + `useChartCursor` + `autoMargin` +
  `ChartTooltipFloat` and declares itself with `theme-allow-file hand-rolled-plot — <why>`.
- **Size is `height` / `aspectRatio` / `fill`** — one of the three, nothing else. Charts measure
  themselves.
- Never substitute a raw visx axis, a hand-written legend array, a `@visx/tooltip` import, an
  `rgba()` fill or a hex.

## 4. Verify

- `oxlint .` green — no `basalt/hand-rolled-plot`, no `basalt/chart-legend-literal`, no
  `basalt/chart-in-raw-surface`, no `@visx/*` import outside a `charts/` segment.
- `basalt-ui check-theme` green — no raw hex, no raw axis, every chart entry point has an
  `ariaLabel`.
- Every new color is a `{ light, dark }` pair in the series file and wired into the palette CSS.
- Tooltip rows and the legend are DERIVED from `series`; the plot draws `visible`.
- Checked in both schemes, and with a pending query (`isPending`, not `data ?? []`).

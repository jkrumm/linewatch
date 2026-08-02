---
source: basalt-ui
description: visx chart conventions — compose basalt-ui primitives/kinds and keep all color in `--vx-*` tokens. Enforced by the oxlint `@visx` ban.
paths:
  - 'src/**/charts/**'
  - 'apps/**/charts/**'
  - 'packages/**/charts/**'
---

# Basalt Charts — visx Conventions

basalt-ui owns the chart doctrine. Charts are built from low-level [visx](https://airbnb.io/visx)
primitives so we can build exactly the chart we want; the trade-off is that every chart duplicates
structure unless we compose shared building blocks. **The primitives + a small kind set are the
contract, not optional polish.**

## The boundary (lint-enforced)

The shipped oxlint preset (`basalt-ui/configs/oxlint.json`) enforces two hard rules — they hold in
downstream apps too:

- **`@visx/*` may only be imported inside a `charts/` directory** (`basalt/visx-boundary`).
  Everywhere else, compose basalt-ui chart primitives/kinds. If you need a raw visx primitive for a
  bespoke chart, import it from `basalt-ui/charts` (it re-exports `Group`, `LinePath`, `Bar`,
  `AreaClosed`, `scaleLinear`, `curveMonotoneX`, …) — keep the dependency declared in one place, and
  keep your own bespoke chart file under a `charts/` directory so it stays on the right side of the
  boundary.
- **`@visx/tooltip` is banned everywhere** (`basalt/visx-tooltip`). Use `ChartTooltip` +
  `TooltipHeader`/`TooltipRow`/`TooltipBody` from `basalt-ui/charts`.

`basalt-ui/charts` is itself Mantine-free (`basalt/token-layer-boundary`, enforced only inside
basalt-ui's own repo) — that keeps the token layer it reads from upstream of Mantine
(`cssVariablesResolver` reads `--vx-*` tokens to bind Mantine's surfaces to them, so a chart
importing `@mantine/*` directly would fork chrome and charts apart instead of sharing one source),
AND it means `basalt-ui/charts`/`basalt-ui/tokens` resolve and render with no `@mantine/*`
installed (real, CI-tested — `scripts/pack-test.sh`'s "charts/tokens-only (no-Mantine) resolution +
render" step). Neither is something a consumer app maintains: there is no local chart-primitives
tree to keep Mantine-free and no bridge file to own — `BasaltProvider` already bridges the Mantine
color scheme to the `--vx-*` CSS variables charts read internally. Just compose the shipped
primitives/kinds and pull color from `VX.*`/`alpha()` (`basalt-ui/tokens`).

`check-theme`'s `inline-display` and `raw-html-layout` guards don't fire inside a chart file
either — both remedies point at a Mantine layout primitive (`Flex`/`Grid`/`Group`/`Box`), which the
Mantine-free boundary above already forbids there, so the finding would be unactionable. Reach for
`ChartCenter` (below, under "Pending state") when a chart file needs to center something.

## Every chart has

1. **ChartCard** wrapper — gives title + info-tooltip + extra slot, consistent margin.
2. **ChartLegend** — never hand-rolled legend markup. Supports `line | bar | split | splitLine`
   shapes and optional highlight state.
3. **ChartTooltip** + `TooltipHeader` + `TooltipRow` + `TooltipBody` — never `@visx/tooltip` directly.
   Portals to `document.body` (SSR-guarded: renders nothing when `document` is undefined), so it
   can be authored anywhere in the tree, including inside an `<svg>`. A plain `<div>` there used to
   mount in the SVG namespace — accepting every prop, throwing nothing, typechecking, passing lint
   — and never paint; one consumer shipped eight authored tooltip rows no one had ever seen. The
   portal also un-breaks `position: fixed` under a transformed ancestor.
4. **AxisLeftNumeric** / **AxisRightNumeric** + **AxisBottomDate** — never raw `<AxisLeft>`/`<AxisBottom>`/`<AxisRight>`
   (they miss theme tokens + smart ticks). Enforced by `basalt-ui check-theme` (`raw-visx-axis` guard
   fails the build on a raw axis in a `/charts/` file; escape via `theme-allow`), not just convention.
   `AxisBottomDate` takes an optional `tickFormat` (`TickFormatter<string>`, defaults to
   `fmtAxisDate` — `DD.MM`) — the only supported exit for a sub-day window, where the default
   collapses every tick to the same label and a raw `<AxisBottom>` isn't an option.
5. **HoverOverlay** for pointer capture (mouse + touch + pen — `touch-action: pan-y` lets vertical
   page scroll pass through while a horizontal drag scrubs the chart), **HoverContext** for
   cross-chart crosshair sync, **useChartTooltip** for tip state, **useHoverSync** for the shared
   cursor. Wrap a group of date-aligned charts in **ChartHoverSync** (from `basalt-ui/charts`) to
   activate cross-chart sync — hovering one chart casts a ghost crosshair on all siblings; without
   it `useHoverSync` runs per-chart only and logs a dev warning:

   ```tsx
   <ChartHoverSync>
     <ChartCard>…</ChartCard>
     <ChartCard>…</ChartCard>
   </ChartHoverSync>
   ```

   Sync is exact string match on the broadcast key by default, so two charts share a cursor only
   when they emit identical key strings. A chart that folds/downsamples its domain for a narrow
   viewport stops owning most of the keys its unfolded siblings broadcast — the shared crosshair
   then lands on roughly one hover in three, worse than no shared cursor at all. Pass
   `useHoverSync`'s `resolveKey` to map a foreign key onto whichever of this chart's own points
   swallowed it; it only affects reading a SIBLING's broadcast key, never this chart's own hover:

   ```tsx
   useHoverSync({
     data: foldedData,
     chartId: 'load-mobile',
     getKey: (d) => d.bucketKey,
     xScale,
     marginLeft,
     // ~288 daily buckets folded into ~97 columns at this width — map an unfolded sibling's key
     // onto the folded bucket that swallowed it.
     resolveKey: (key) => pointByKey.get(foldKey(key)) ?? null,
   })
   ```

6. **Theme-aware colors** via `VX.*` tokens + `alpha()`. **Never** a raw hex literal in a chart file.
   **Never** `localStorage.getItem('theme')` — the scheme resolves via CSS vars (see Dark/light below).

**Exemption:** sparklines (`LineSparkline`, `BarSparkline` — tiny inline charts with no legend/tooltip)
don't have to compose ChartCard/ChartLegend/ChartTooltip — but still use `VX.*` tokens.

## Pending state (`isPending`)

"Nothing to draw" is three states, not two: **measured-and-empty**, **measured-and-absent** (a
genuine coverage gap), and **not-asked-yet** (the query hasn't resolved). The `data ?? []` idiom
collapses the third into the second — an in-flight query renders as a fully-hatched "not measured"
window, a positive claim the series was watched and carried nothing. Pass `isPending` instead of
faking an empty array:

```tsx
import { Bars } from 'basalt-ui/charts'
;<Bars
  data={data ?? []}
  isPending={query.isPending}
  chartId="load"
  getX={(d) => d.date}
  getY={(d) => d.load}
/>
```

All seven kinds accept `isPending` and forward it to `ChartFrame` (`Heatmap` handles it locally —
it composes no `ChartFrame`, taking `width`/`height` directly rather than measuring). `ChartFrame`
with `isPending` renders `ChartPending` over the plot rect in place of `children`, suppresses the
legend entirely (a legend naming a series with nothing yet to point at is its own small lie), and
sets `aria-busy="true"` on the outer container.

`ChartPending` reserves the plot's exact footprint and draws **nothing** that could be mistaken for
a measurement — no axes, no gridlines, no hatching, no marks, no animation (the motion doctrine
bans idle pulsing) — just a faint, static, centered label (`ChartPendingProps.label`, default
`'Loading…'`).

`ChartCenter` (also exported from `./charts`) is the centering primitive `ChartPending` is built
on — it exists only because chart files can't import Mantine's `Center`/`Flex`. Reach for it
directly in a bespoke chart file the same way; it's deliberately minimal (`width`, `height`,
`children`, nothing else), not a general layout system.

## Kinds — the recurring shapes

basalt-ui ships these kinds (declarative props, generic over your point type via `getX`/`getY`):

- **`ZonedLine`** — a line with zone bands, thresholds, and reference lines.
- **`Bars`** — bars with optional overlaid line, zones, ref lines, dual-axis config.
- **`StackedArea`** — opaque stacked bands.
- **`Donut`** — proportional donut.
- **`MultiLine`** — N series on a shared y-axis: legend-hover dimming, per-series synced dots,
  dashed companion (MA) lines, per-point markers (PR stars / status dots), zones + refLines, fixed
  or auto domain (covers z-score/σ via a fixed symmetric domain + zero refLine).
- **`DualPanel`** — top line-pane + bottom signed-histogram pane sharing one x-scale and one cursor;
  optional fill-between two top lines, zones, refLines.
- **`Heatmap`** — category×category intensity grid (`color-mix` alpha), per-cell tooltip, optional
  gradient legend strip.

How to add a chart:

1. **Fits an existing kind?** Use it. Pass `data`, `width`, `height`, `chartId`, accessors, and the
   declarative zones/thresholds/refLines arrays.
2. **Second instance of a new recurring shape?** Extract a kind and migrate both call sites
   (Rule of Three: don't extract on the first, don't wait past the third). Bespoke escape hatches
   (`renderExtraTooltipRows`, etc.) are fine but must not grow into god-object configs.
3. **Genuinely unique (e.g. a dual-panel MACD)?** Stay bespoke — compose the primitives + the raw
   visx re-exports directly. Keep it in the page's chart file, not in a shared kind.

**Anti-pattern:** a single `<Chart type="..." config={...} />` that switches by kind. Prefer N small kinds.

## Series color

App-specific series colors are _your_ domain data, not framework data. Declare them once:

```ts
import { defineSeries, groupTokens } from 'basalt-ui/tokens'

const SERIES = defineSeries({
  load: { light: '#…', dark: '#…' },
  recovery: { light: '#…', dark: '#…' },
})
const tokens = groupTokens('series', SERIES) // → { load: 'var(--vx-series-load)', ... }
```

Emit the CSS via `buildPaletteCss({ groups: { 'series-': SERIES } })`. A hue keeps its identity but
shifts shade across schemes — that's why each entry is a `{ light, dark }` pair, not a single value.
**Adding a new color** means adding a pair to your series map and rebuilding the palette CSS — never
inline a hex in a chart.

## Dark/light mode

Theme reactivity is **pure CSS**: the `--vx-*` variables are redeclared under the light/dark color
scheme, so toggling the scheme restyles every chart with no React re-render. Charts read `VX.*` (var
refs) directly. Don't branch on color scheme in JS; never read `localStorage.getItem('theme')`.

## Area gradients

Use the `AreaGradient` primitive (a vertical `<linearGradient>` of `color-mix` stops over a `--vx-*`
color) with the global strength knobs (`--vx-area-top` / `--vx-area-bottom`). Default the fill **on**
for plain metric lines, **off** when the chart already carries zone/threshold fills (avoid double-fill
clutter). Keep stacked-area bands opaque — fading them leaks lower bands.

## Responsive sizing

Use `ResponsiveChart` (render-prop container) or `useChartSize` (hook) from `basalt-ui/charts` —
both are backed by `@visx/responsive`'s `useParentSize` and keep the `@visx/*` import inside a
`charts/` directory per `basalt/visx-boundary`. Never reach for `@visx/responsive` directly or
`useElementSize` from `@mantine/hooks` in a chart file.

```tsx
import { ResponsiveChart, Bars } from 'basalt-ui/charts'

// Preferred: render prop, renders nothing until the first measurement
<ResponsiveChart height={320}>
  {({ width, height }) => (
    <Bars width={width} height={height} data={data} chartId="load" getX={…} getY={…} />
  )}
</ResponsiveChart>

// aspectRatio variant: height = width / ratio
<ResponsiveChart aspectRatio={16 / 9}>
  {({ width, height }) => <MyChart width={width} height={height} />}
</ResponsiveChart>
```

Use `useChartSize` directly when you need the `ref` on a custom container:

```ts
import { useChartSize } from 'basalt-ui/charts'

const { ref, width, height } = useChartSize()
// attach ref to your container div; width/height update via ResizeObserver
```

`ResponsiveChartProps`: `height` (default 240), `aspectRatio`, `debounceMs` (default 0), `children`.
`UseChartSizeResult`: `{ ref, width, height }`.

## Migrating from pre-1.0 (`@argo/charts` era)

Three silent renames/behavior changes trip up a consumer migrating off the pre-1.0 in-house charts
package — all typecheck-clean only in a strict setup, so they're easy to miss in a quick port:

- **`HoverCtx.date` → `HoverCtx.key`.** The hover context's cross-chart cursor field is generic
  now (not date-only) — rename the field, not just the type.
- **`useHoverSync({ getX })` → `useHoverSync({ getKey })`.** Same generalization — pass an accessor
  returning the series key, not an x/date value.
- **`legend.maxRows` renders a `+N more` chip** instead of silently truncating. A consumer that
  previously hand-rolled `.slice(0, N)` on its legend items gets a visible UX diff (a real overflow
  indicator) — drop the manual slice and let `maxRows` own it.

## Rule of thumb

> If the new chart doesn't fit the primitives, add a kind — don't loosen the primitives.

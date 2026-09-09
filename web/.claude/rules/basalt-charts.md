---
source: basalt-ui
description: visx chart doctrine — compose CartesianChart (or ChartFrame for a non-single-plot shape), derive legends and tooltip rows from `series`, keep every color in `--vx-*`. Enforced by basalt/hand-rolled-plot, basalt/chart-legend-literal, basalt/chart-in-raw-surface and the two @visx boundary rules.
paths:
  - '**/charts/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `bun scripts/check-coverage.ts --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — chart-missing-aria-label, raw-color-fn, raw-hex, raw-visx-axis · oxlint rules — basalt/chart-in-raw-surface, basalt/chart-legend-literal, basalt/hand-rolled-plot, basalt/visx-boundary, basalt/visx-tooltip -->
<!-- not guarded: — -->
<!-- /basalt:coverage -->

# Basalt Charts — the primitive contract

basalt-ui owns the chart doctrine: charts are assembled from low-level visx primitives, so without a
shared assembly every chart drifts from every other one. **This file is the contract; the API is not
here** — read the shipped types and JSDoc, and `llms.txt` at the install directory, for props.

## The one mandatory primitive

**Every single-plot cartesian chart composes `CartesianChart`, and composes nothing else from its job
list by hand.** It owns the measured margins, both y scales and their domains, the x scale and tick
thinning, the grid, zones, the axes, the page-shared cursor, the crosshair and its per-series dots,
the hover/keyboard overlay and the derived tooltip. The caller supplies `series` and a `children`
render prop that draws **only marks**.

Reaching past it for an axis, a tooltip or a margin means the chart has drifted. `basalt/hand-rolled-plot`
enforces this per NODE, waived one node at a time with `theme-allow hand-rolled-plot — <why>`.

**Five shipped shapes are the declared exceptions**, by shape, not preference: `DualPanel` (two
panes), `MirroredBars` (two bar panes, one baseline), `BandStrip` (no y dimension), `Donut`
(radial), `Heatmap` (matrix). They compose `ChartFrame` + `useChartCursor` + `autoMargin` +
`ChartTooltipFloat` directly. The first three carry `theme-allow-file hand-rolled-plot — <why>`;
`Donut`/`Heatmap` render no assembly primitive, so nothing fires. A bespoke non-single-plot shape
declares itself the same way. `CartesianChart`'s own defining module is exempt definitionally.

**A documented limit:** the rule keys on visx primitives, so a DOM- or hand-`<svg>`-drawn chart is
structurally invisible to it. Compose the primitive because it's the contract, not because lint
catches you.

## `series` is the single source of truth

Legend entries and tooltip rows are **DERIVED** from `series` (`deriveLegend` / `deriveTooltipRows`,
or just let `ChartFrame`/`CartesianChart` do it), so a chart cannot show a row or a key it does not
draw. A hand-written array literal passed to `ChartLegend`'s `items` — or a `.map()` over some OTHER
array, because deriving from AN array is not deriving from THE series — is
`basalt/chart-legend-literal`.

**Corollary for mark renderers: draw `ctx.visible`, never the `series` prop.** `visible` is `series`
minus whatever the legend has toggled off, and the legend toggles by default at two or more entries
— hiding a series drops it from the plot, the tooltip AND the auto y-domain together. Drawing
`series` repaints the mark the reader just hid.

## Boundaries (three independent rules, no escape hatch)

- **`@visx/*` only inside a `charts/` path segment** (`basalt/visx-boundary`, shipped AND
  repo-local) — import a raw visx primitive from `basalt-ui/charts`'s curated re-export instead.
- **`@visx/tooltip` is banned everywhere**, charts included (`basalt/visx-tooltip`) — use
  `ChartTooltipFloat` + `TooltipHeader`/`TooltipRow`/`TooltipBody`. A plain `<div>` inside an
  `<svg>` mounts in the SVG namespace, typechecks, lints, and never paints.
- **basalt's own `charts/`+`tokens/` import zero `@mantine/*`** (`basalt/token-layer-boundary`,
  repo-local — a framework invariant, not an obligation on your app's own `charts/`-named dir). It
  keeps the token layer upstream of Mantine and lets both subpaths resolve with no Mantine
  installed.
- Mantine layout primitives are unreachable in a chart file, so `inline-display`/`raw-html-layout`
  deliberately don't fire there — raw `<div>` is fine, `VX.*` tokens still mandatory
  (`ChartCenter` to center).
- **Maps are not charts** — no map library is `@visx/*`, basalt ships no map kind; build one where
  the rest of the app's non-chart UI lives, styled with `--vx-*`.

## Color, scheme and margins

- **Never a raw hex in a chart file**, never `localStorage.getItem('theme')`. Theme reactivity is
  **pure CSS**: `--vx-*` redeclares per scheme, so toggling restyles every chart with no React
  re-render.
- **Series color is consumer domain data** — one guard-exempt file per app, `defineSeries` →
  `seriesTokens`/`groupTokens` → `buildPaletteCss` (basalt-tokens.md), each entry a `{light,dark}`
  pair.
- **Margins are MEASURED, not hand-picked** — every axis's tick labels run through
  `autoMargin`/`measureText` before layout, so `VX.margin` is a floor. Passing `y2` is what makes a
  chart dual-axis; `margin={{ side: n }}` overrides last. Derive constants from `VX.margin` rather
  than copying a number into three files.
- **Never fake an empty dataset for a pending query** — `data ?? []` collapses "not asked yet" into
  "measured and absent". Pass `isPending`; every kind forwards it to one pending renderer.
- **`ChartFrame`'s container is `role="group"`, never `role="img"`** — every descendant of a
  `role="img"` element is presentational, which would erase the hover overlay's `role="slider"`
  from the accessibility tree silently (jsdom doesn't implement the pruning, so no test catches it).

## Adding a chart

1. **Fits a shipped kind?** Use it — declarative props (`data`, `chartId`, `getX`, `series`, one
   `AxisConfig` per axis, zones/thresholds/refLines as plain arrays).
2. **Second instance of a shape with no kind?** Extract a kind (Rule of Three), migrating both call
   sites; prove it by porting real call sites, ship the "still cannot express" list with it.
3. **Genuinely unique?** Stay bespoke, composing `CartesianChart`/`ChartFrame` directly in the
   page's chart file, not in a shared kinds directory.

Sparklines are the one exemption (no legend, no tooltip, no `CartesianChart`) — still `VX.*` only.
**Anti-pattern:** a single `<Chart type="…" config={…} />` switching by kind — add a kind, don't
loosen the primitives.

## The x axis is categorical, and the API does not say so

`CartesianChart` builds x as a point scale over domain KEYS — N evenly spaced positions whatever
the values behind them. Wrong for an event-shaped series: a shared crosshair marks the wrong screen
x against a regularly-sampled sibling, and two events at the same instant collapse onto one
position. `getX` returning a date string reads like a time axis and is not one.

The cursor is **shared page-wide by default**, resolved domain-aware (nearest parsed date/number
within a chart's own step). `ChartCursorScope` ISOLATES a subtree — opts out of sharing, never in.

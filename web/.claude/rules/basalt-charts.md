---
source: basalt-ui
description: visx chart doctrine — compose CartesianChart (or ChartFrame for a non-single-plot shape), derive legends and tooltip rows from `series`, keep every color in `--vx-*`. Enforced by basalt/hand-rolled-plot, basalt/chart-legend-literal, basalt/chart-in-raw-surface and the two @visx boundary rules.
paths:
  - '**/charts/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `basalt-ui check-coverage --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — chart-missing-aria-label, raw-color-fn, raw-hex, raw-visx-axis, unframed-chart · oxlint rules — basalt/chart-in-raw-surface, basalt/chart-legend-literal, basalt/hand-rolled-plot, basalt/visx-boundary, basalt/visx-tooltip -->
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
enforces this per NODE: a chart-assembly primitive rendered in a file that does not compose
`CartesianChart` is a finding, waived one node at a time with `theme-allow hand-rolled-plot — <why>`.

**Five shipped shapes are the declared exceptions**, by shape, not by preference: `DualPanel` (two
panes), `MirroredBars` (two bar panes on one baseline), `BandStrip` (no y dimension at all), `Donut`
(radial) and `Heatmap` (a matrix). They compose `ChartFrame` + `useChartCursor` + `autoMargin` +
`ChartTooltipFloat` directly. The first three carry a `theme-allow-file hand-rolled-plot — <why>`
declaration; `Donut` and `Heatmap` render no assembly primitive, so nothing fires and there is
nothing to waive. A genuinely non-single-plot bespoke shape declares itself the same way — file
scope, spelled, with a reason. The module that DEFINES `CartesianChart` is exempt definitionally: a
rule saying "compose X" cannot fire inside X.

**A documented limit:** the rule keys on those visx primitives, so a chart drawn with DOM nodes or a
hand-assembled `<svg>` is structurally invisible to it. Compose the primitive because it is the
contract, not because lint will catch you.

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

- **`@visx/*` only inside a `charts/` path segment** (`basalt/visx-boundary`, shipped AND repo-local).
  Need a raw visx primitive? Import it from `basalt-ui/charts`, which re-exports the curated set, and
  keep your bespoke chart file under a `charts/` directory.
- **`@visx/tooltip` is banned everywhere**, charts included (`basalt/visx-tooltip`) — use
  `ChartTooltipFloat` + `TooltipHeader`/`TooltipRow`/`TooltipBody`. It portals to `document.body`, so
  it can be authored anywhere including inside an `<svg>`; a plain `<div>` there mounts in the SVG
  namespace, typechecks, lints, throws nothing, and never paints.
- **basalt's own `charts/` and `tokens/` import zero `@mantine/*`** (`basalt/token-layer-boundary`,
  repo-local by design). That is a framework invariant, not an obligation on your app's own
  `charts/`-named directory: it keeps the token layer upstream of Mantine and lets
  `basalt-ui/charts` + `basalt-ui/tokens` resolve with no Mantine installed.
- Because Mantine layout primitives are unreachable inside a chart file, `inline-display` and
  `raw-html-layout` deliberately do NOT fire there — the finding would be unactionable. Raw `<div>`
  is fine in a chart file; `VX.*` tokens are still mandatory. Reach for `ChartCenter` to center.
- **Maps are not charts.** No map library is a `@visx/*` package, basalt ships no map kind, and the
  boundary says nothing about one — build it wherever the rest of the app's non-chart UI lives, and
  style its chrome with `--vx-*` so it matches.

## Color, scheme and margins

- **Never a raw hex in a chart file**, and never `localStorage.getItem('theme')`. Theme reactivity is
  **pure CSS**: the `--vx-*` variables are redeclared per scheme, so toggling restyles every chart
  with no React re-render. Don't branch on the color scheme in JS.
- **Series color is consumer domain data** — one guard-exempt file per app, `defineSeries` →
  `seriesTokens`/`groupTokens` → `buildPaletteCss` (basalt-tokens.md). A hue keeps its identity and
  shifts shade across schemes, which is why every entry is a `{ light, dark }` pair.
- **Margins are MEASURED, not hand-picked.** Every configured axis's tick labels run through
  `autoMargin`/`measureText` before layout, so `VX.margin` is a floor and a wide label widens its own
  gutter. Passing `y2` is what makes a chart dual-axis — the right margin widens by measurement, with
  no manual nudge. `margin={{ side: n }}` is the per-side override, applied last.
- **Derive constants from `VX.margin`** rather than copying a number into three chart files — those
  are three silent-drift sites the moment the density scale is retuned.
- **Never fake an empty dataset for a pending query.** "Nothing to draw" is three states, and
  `data ?? []` collapses "not asked yet" into "measured and absent", which is a positive claim about
  data nobody fetched. Pass `isPending`; every kind forwards it to one pending renderer that reserves
  the plot's footprint and draws nothing that could be mistaken for a measurement.
- **`ChartFrame`'s container is `role="group"`, never `role="img"`.** Every descendant of a
  `role="img"` element is presentational, which erases the hover overlay's `role="slider"` from the
  accessibility tree — silently, and jsdom does not implement the pruning, so no `getByRole` test can
  catch the regression. Do not "simplify" it back.

## Adding a chart

1. **Fits a shipped kind?** Use it. The kinds are declarative — `data`, `chartId`, `getX`, `series`,
   one `AxisConfig` per axis, zones/thresholds/refLines as plain arrays.
2. **Second instance of a shape with no kind?** Extract a kind and migrate both call sites (Rule of
   Three: not on the first, not past the third). **Prove a new kind by porting real call sites** and
   shipping the "still cannot express" list with it — a demo page is written against the API that
   already exists.
3. **Genuinely unique?** Stay bespoke, composing `CartesianChart` (or `ChartFrame`) directly in the
   page's chart file, not in a shared kinds directory.

Sparklines are the one exemption from the composition contract (no legend, no tooltip, no
`CartesianChart`) — they still read `VX.*`.

**Anti-pattern:** a single `<Chart type="…" config={…} />` that switches by kind. Prefer N small
kinds, and if a chart doesn't fit the primitives, **add a kind — don't loosen the primitives.**

## The x axis is categorical, and the API does not say so

`CartesianChart` builds x as a point scale over domain KEYS: N points are N evenly spaced positions
whatever the values behind them. Correct and invisible for a regular grid; wrong for an event-shaped
series, where two consequences are silent — equal spacing means a shared crosshair marks the right
point at a different screen x than a regularly-sampled sibling, and two events at the same instant
collapse onto one position with one of them dropped. `getX` returning a date string reads like a time
axis and is not one. A chart whose x is a measured quantity needs a file declaration today.

The cursor is likewise **shared page-wide by default** with no provider, resolved domain-aware
(nearest parsed date/number within a chart's own step, not string equality) so a chart that folds its
domain still tracks a sibling's hover. `ChartCursorScope` ISOLATES a subtree — it opts out of
sharing, never into it.

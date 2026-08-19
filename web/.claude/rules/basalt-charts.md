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
structure unless we compose shared building blocks. **`CartesianChart` plus a small kind set are
the contract, not optional polish** — composing `CartesianChart` (single-plot) or `ChartFrame`
directly (multi-pane/radial/matrix) is mandatory for every chart, mechanically enforced by
`basalt/hand-rolled-plot` (see "Mechanical enforcement" below). `docs/CHARTS-SPEC.md` is the ground
truth this doc reflects.

## The boundary (lint-enforced)

The shipped oxlint preset (`basalt-ui/configs/oxlint.json`) enforces two hard rules — they hold in
downstream apps too:

- **`@visx/*` may only be imported inside a `charts/` directory** (`basalt/visx-boundary`).
  Everywhere else, compose basalt-ui chart primitives/kinds. If you need a raw visx primitive for a
  bespoke chart, import it from `basalt-ui/charts` (it re-exports `Group`, `LinePath`, `Bar`,
  `AreaClosed`, `scaleLinear`, `curveMonotoneX`, …) — keep the dependency declared in one place, and
  keep your own bespoke chart file under a `charts/` directory so it stays on the right side of the
  boundary.
- **`@visx/tooltip` is banned everywhere** (`basalt/visx-tooltip`). Use `ChartTooltipFloat` +
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

## The contract is mandatory (lint-enforced)

Composing `CartesianChart` for a single-plot chart, or `ChartFrame` directly for a multi-pane/
radial/matrix shape, is not optional — two `basalt` oxlint plugin rules
(`packages/basalt-ui/configs/oxlint-plugin.js`) make it a lint failure to bypass:

- **`basalt/hand-rolled-plot`** — rendering a chart-assembly primitive (`AxisLeftNumeric`,
  `AxisRightNumeric`, `AxisBottomDate`, `HoverOverlay`, `Crosshair`) in a file that does not
  compose `CartesianChart` fails the build. Escape: a `theme-allow` comment on the first such
  site — that is how a genuinely non-single-plot shape (multi-pane, radial, matrix) declares
  itself; `DualPanel` carries the repo's one such comment. The file that DEFINES `CartesianChart`
  is exempt definitionally (detected by declaration, not by path), since a rule saying "compose X"
  cannot fire inside X.
- **`basalt/chart-legend-literal`** — passing a hand-written array literal to `ChartLegend`'s
  `items` fails the build; the legend must be derived from the same `series` array the chart draws
  (`deriveLegend`, or just let `ChartFrame`/`CartesianChart` do it), so it cannot go stale and keep
  naming a series the plot no longer draws.

Both ship at `warn` in the consumer preset (`configs/oxlint.json`) for one minor and `error`
repo-local, per the "Shipping a stricter guard — the grace minor" doctrine in
`packages/basalt-ui/CLAUDE.md`. They promote to `error` in the next minor.

## Maps are not charts

Neither `@visx/geo` nor any map library is among the 9 exact-pinned `@visx/*` peers, and basalt
ships no map kind.

- **Maps are consumer territory.** A map is a MapLibre/Leaflet/deck.gl component in the consumer's
  own tree, not a visx chart — build it wherever the rest of that consumer's non-chart UI lives.
- **The `basalt/visx-boundary` rule doesn't apply.** It constrains `@visx/*` imports only. A map
  library is not `@visx/*`, so a map component needs no `charts/` path segment and no exemption.
- **Want `@visx/geo` anyway?** Install it yourself — basalt doesn't pin it — and keep it under a
  `charts/` segment like every other visx import, same as any bespoke chart.
- **Style map chrome with `--vx-*` tokens** (`VX.*`/`alpha()`) so it matches the rest of the app.
- **The guard trap:** `check-theme`'s `inline-spacing` kind is a per-line regex over raw source, not
  an AST pass — it flags any `padding:`/`gap:`/`margin:` followed by a number in _any_ object
  literal, in any file. A map's pixel geometry (`fitBounds({ padding: 48 })`, marker offsets) trips
  it even though it isn't spacing, and hoisting the value to a module-scope const doesn't help — the
  regex sees the line, not the binding. Use a `theme-allow` line comment; that's the sanctioned
  answer, not a bug to file.

## Every chart has

1. **`CartesianChart`** — the primitive every single-plot cartesian chart composes, and composes
   NOTHING else from this list by hand. `ZonedLine`, `Bars`, `StackedArea`, and `MultiLine` all
   compose it; a bespoke single-plot chart should too. It owns measured margins, both y scales +
   domains, the x scale + tick thinning, grid, zones, axes, the shared cursor, the crosshair + its
   per-series dots, the hover/keyboard overlay, and the derived tooltip. The caller supplies
   `series` (the single source of truth — see #3) and a `children` render prop that draws ONLY
   marks:

   ```tsx
   <CartesianChart
     data={data} chartId="sessions" getX={(d) => d.date} series={SERIES}
     y={{ domain: 'auto', format: fmtInt }}
     height={260}
   >
     {({ xScale, yScale, visible }) => visible.map((s) => <LinePath key={s.key} … />)}
   </CartesianChart>
   ```

   Reaching past it for an axis, a tooltip, or a margin means the chart has drifted from every
   other chart. `DualPanel`, `Heatmap`, and `Donut` are the deliberate exception, by shape: they
   compose `ChartFrame` + `useChartCursor` + `autoMargin` + `ChartTooltipFloat` directly instead —
   same machinery, different assembly, because their contract isn't a single plot rect with one or
   two numeric y axes.

2. **ChartCard** wrapper — never a raw `<Card>`. Gives title + info-tooltip + extra slot, consistent
   margin.
3. **`series` is the single source of truth.** Legend entries and tooltip rows are DERIVED from it
   (`deriveLegend` / `deriveTooltipRows`) — a chart cannot show a row or a legend key it doesn't
   draw. Never hand-author a legend or a tooltip row in parallel. Corollary for mark renderers: draw
   `ctx.visible` (the `PlotContext` field), never the `series` prop directly — `visible` is `series`
   minus whatever the legend has toggled off, so drawing `series` would repaint a mark the reader
   just hid.
4. **`ChartTooltipFloat`** + `TooltipHeader` + `TooltipRow` + `TooltipBody` — never `@visx/tooltip`
   directly. `CartesianChart` wires this internally for a single-plot chart; a non-cartesian shape
   composes it directly (see #1). Portals to `document.body` (SSR-guarded: renders nothing when
   `document` is undefined), so it can be authored anywhere in the tree, including inside an
   `<svg>`. A plain `<div>` there mounts in the SVG namespace — accepting every prop,
   throwing nothing, typechecking, passing lint — and never paint; one consumer shipped eight
   authored tooltip rows no one had ever seen. The portal also un-breaks `position: fixed` under a
   transformed ancestor.
5. **AxisLeftNumeric** / **AxisRightNumeric** + **AxisBottomDate** — never raw
   `<AxisLeft>`/`<AxisBottom>`/`<AxisRight>` (they miss theme tokens + smart ticks). Enforced by
   `basalt-ui check-theme` (`raw-visx-axis` guard fails the build on a raw axis in a `/charts/`
   file; escape via `theme-allow`), not just convention. `AxisBottomDate` takes an optional
   `tickFormat` (`TickFormatter<string>`, defaults to `fmtAxisDate` — `DD.MM`) — the only supported
   exit for a sub-day window, where the default collapses every tick to the same label and a raw
   `<AxisBottom>` isn't an option. `CartesianChart`'s own `formatX` prop is the higher-level way to
   set this without touching the axis component at all — and every cartesian kind (`Bars`/
   `MultiLine`/`StackedArea`/`ZonedLine`/`DualPanel`) forwards its own `formatX?: (key) => string`
   now too, not just `CartesianChart` itself. Without it, the only route to a custom x label was
   pre-formatting it into the domain key, which makes one string serve as display value, scale
   identity, AND cursor key simultaneously — and a truncating formatter then collapses two points
   onto one domain value, silently dropping one from the plot (see #6 below for why that's the
   cursor's problem too). `Heatmap` is deliberately excluded: its existing `colLabel`/`rowLabel`
   already are that seam, and a second prop over one concern would fork them.
6. **The cursor is shared by default.** No provider needed — `useChartCursor` reads a module-level
   external store (`useSyncExternalStore`), so every `CartesianChart`/`ChartFrame`-composed chart on
   the page shares one cursor out of the box. `ChartCursorScope` **isolates** a subtree onto a
   private store instead: it opts a subtree OUT of sharing, never into it. Reach for it only when a
   group must not follow the rest of the page.

   ```tsx
   <ChartCursorScope>
     <ChartCard>…</ChartCard>
     <ChartCard>…</ChartCard>
   </ChartCursorScope>
   ```

   **Resolution is domain-aware, not string-equal**, which is what makes sharing safe as a default.
   Exact-string matching would desync any chart that folds or downsamples its own domain: it stops
   owning most of the keys its siblings broadcast, so the shared crosshair lands on some hovers and
   not others, with no rule a reader can infer — worse than no shared cursor at all.
   `useChartCursor` resolves a broadcast key against a chart's own points by, in order: exact
   match → nearest parsed-numeric/date match within the chart's own step → `null`. A chart that folds its calendar
   into weekly buckets still tracks a hover from a sibling plotting daily points, with no extra
   wiring — `resolveKey` no longer exists because there is nothing left for it to patch.

   `CursorResolution = 'nearest' | 'leading'` (exported from `basalt-ui/charts`) picks WHICH own
   point wins that resolution, reachable as `cursorResolution` on `CartesianChart`/every cartesian
   kind/`DualPanel` and as `useChartCursor`'s `resolution` option — default `'nearest'`, unchanged.
   Reach for `'leading'` when `getX` returns a bucket's LEADING EDGE (a weekly series keyed by its
   Monday, a monthly series keyed by its 1st): under `'nearest'`, a hover landing in the back half
   of a bucket resolves to the FOLLOWING bucket instead of the one it's actually inside, so the
   shared crosshair sits one column right of the data being pointed at — reproducibly, for every
   back-half hover.

7. **Keyboard-operable by construction.** The hover overlay `CartesianChart` renders is focusable;
   `←`/`→` scrub the shared cursor one point at a time, `Escape` clears it. The tooltip is
   `aria-live="polite"`. This comes for free from composing `CartesianChart`/`ChartFrame` — nothing
   to wire per chart. That's exactly why `ChartFrame`'s outer container uses `role="group"` on its
   `ariaLabel`, **never** `role="img"`: per the ARIA spec every descendant of a `role="img"`
   element is presentational, which would erase the hover overlay's `role="slider"` from the
   accessibility tree entirely — the label still announces, but the keyboard-scrubbable control
   underneath it becomes unreachable, silently, with no error anywhere. jsdom does not implement
   that pruning, so no `getByRole` test can ever catch this regression; it is a structural rule, not
   a test-covered one. Do not "simplify" `ChartFrame`'s container role back to `img` — it looks like
   a no-op refactor and it is not.
8. **Theme-aware colors** via `VX.*` tokens + `alpha()`. **Never** a raw hex literal in a chart file.
   **Never** `localStorage.getItem('theme')` — the scheme resolves via CSS vars (see Dark/light
   below).

**Exemption:** sparklines (`LineSparkline`, `BarSparkline` — tiny inline charts with no
legend/tooltip) don't have to compose ChartCard/`CartesianChart`'s legend/tooltip — but still use
`VX.*` tokens.

## Legend interaction

At ≥2 entries, the derived legend is a toggle by default: clicking an entry hides that series from
the plot, the tooltip, AND the auto y-domain, together — a stacked chart's axis actually shrinks
when a band is hidden, it doesn't just leave a dead gap. `legend={{ toggle: false }}` opts a chart
out. A single-entry legend never toggles (hiding the only series a chart draws is never useful).
This is exactly why marks must draw `ctx.visible` and never `series` (see "Every chart has" #3) —
`visible` is what actually reflects a hidden key; the raw `series` prop never changes.

## Tooltip config

`CartesianChart`'s `tooltip` prop (`CartesianTooltipConfig<T>`, or `false` to disable the tooltip
and its crosshair dots entirely):

- `label?: (d: T) => { text; color } | null` — a right-aligned badge in the header (a status label,
  a zone name).
- `prependRows?: (d: T, ctx: { visible; hidden }) => ReactNode` — rows rendered BEFORE the derived
  per-series rows (a total, a context line). `ctx` is the same `visible`/`hidden` the plot itself
  draws from, so a hand-authored row tracks legend toggling instead of desyncing from it.
- `extraRows?: (d: T, ctx: { visible; hidden }) => ReactNode` — rows appended after the derived
  rows. Same `ctx` as `prependRows`.
- `follow?: boolean` — default `true`, the tooltip tracks the pointer. `follow: false` anchors it to
  the crosshair at the plot's top edge instead, which reads better across a column of charts sharing
  one cursor (every tooltip lines up on the same x). Anchoring costs one `getBoundingClientRect` per
  hovered frame, which is why following is the default.
- `formatHeader?: (key, d) => string` — overrides the tooltip header's date text (also
  `TooltipHeader`'s own `format` prop directly, and the identical seam on `DualPanel`'s
  `formatHeader`, so the two never diverge). Default: today's `fmtTooltipDate` behavior, unchanged.
  The seam exists because `fmtTooltipDate` regexes `YYYY-MM-DD` out of the domain key and builds a
  LOCAL `Date` from it — a UTC ISO key then names a different day than `formatX`, the tooltip badge,
  and every sibling chart, all of which resolve locally; the only prior workaround was carrying a
  local-offset ISO key. Receives the raw `getX` key alongside the hovered datum.

Per-series, `SeriesStyle.tooltip: false` means "draw the mark and legend it, but never give it a
tooltip row" — it lives on the series, not on the kind. `ChartSeries.formatValue` is
`(v: number, d: T) => string` — a row can cite the hovered datum, not just the plotted number (e.g.
`97.5 kg (92.5 × 3)`). `Bars` has its own per-key version of the opt-out: `BarsBar.tooltip: false` /
`BarsLine.tooltip: false` draws and legends a bar series without ever listing it as a tooltip row.

A **stacked** chart needs `cursorValue` too: `CartesianChart`'s crosshair dot defaults to
`series.getValue(point)`, which is correct for an unstacked line but puts a stacked band's dot at
its own raw value — somewhere inside the fill, not on the edge the reader is tracking. Pass
`cursorValue={(point, series, visible) => …}` to place it at the cumulative band top instead;
`StackedArea` is the reference implementation (`kinds/StackedArea.tsx`).

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
  getValue={(d, key) => d[key]}
  positiveBars={[{ key: 'load', label: 'Load', color: VX.accent }]}
/>
```

All seven kinds accept `isPending` and forward it to `ChartFrame` — `ZonedLine`/`Bars`/
`StackedArea`/`MultiLine` forward it through `CartesianChart`, which forwards it on to `ChartFrame`
in turn; `DualPanel`/`Heatmap`/`Donut` compose `ChartFrame` directly and forward it there. Every
path lands on the same `ChartFrame`, so there's one pending renderer, not seven. `ChartFrame` with
`isPending` renders `ChartPending` over the plot rect in place of `children`, suppresses the legend
entirely (a legend naming a "not measured" series with nothing to point at is its own small lie),
and sets `aria-busy="true"` on the outer container.

`ChartPending` reserves the plot's exact footprint and draws **nothing** that could be mistaken for
a measurement — no axes, no gridlines, no hatching, no marks, no animation (the motion doctrine
bans idle pulsing) — just a faint, static, centered label (`ChartPendingProps.label`, default
`'Loading…'`).

`ChartCenter` (also exported from `./charts`) is the centering primitive `ChartPending` is built
on — it exists only because chart files can't import Mantine's `Center`/`Flex`. Reach for it
directly in a bespoke chart file the same way; it's deliberately minimal (`width`, `height`,
`children`, nothing else), not a general layout system.

## Kinds — the recurring shapes

basalt-ui ships these kinds (declarative props, generic over your point type via `getX` and
per-series `getValue` accessors on `ChartSeries<T>`):

- **`ZonedLine`** — a single-series line with zone bands, thresholds, x-zones, and reference lines.
  Composes `CartesianChart`.
- **`Bars`** — 1+ stacked positive/negative bar series, optional line overlays, zones, ref lines,
  dual-axis config. Composes `CartesianChart`.
- **`StackedArea`** — opaque stacked bands, auto cumulative-top y-domain. Composes `CartesianChart`.
- **`MultiLine`** — N series on a shared y-axis (or two, via `y2`): legend-hover dimming, per-series
  synced dots, dashed companion (MA) lines, per-point markers (PR stars / status dots), zones +
  refLines, fixed or auto domain (covers z-score/σ via a fixed symmetric domain + zero refLine).
  Composes `CartesianChart`. `ChartSeries.getMarker` returns `{ color?, r?, fillOpacity?, ring? }`
  — `ring` defaults `true` (today's punched-out stroke, unchanged), `ring: false` omits the stroke
  entirely, `fillOpacity` defaults `1`. Existed because a consumer's plain `fillOpacity: 0.7` dots
  were unreproducible after moving their chart onto the kind — the old shape had no seam for either.
- **`DualPanel`** — top line-pane + bottom signed-histogram pane sharing one x-scale and one cursor;
  optional fill-between two top lines, zones, refLines, per-point markers on the top pane
  (`ChartSeries.getMarker`). Composes `ChartFrame` directly (two panes, not one plot rect). The
  bottom pane's tooltip row is `formatBar` (separate from `formatBottom`'s tick labels); its domain
  is configurable via `bottomYDomain`/`bottomMaxAbsFloor`.
- **`Heatmap`** — category×category intensity grid (`color-mix` alpha), per-cell tooltip, optional
  gradient legend strip. Composes `ChartFrame` directly; self-measures, no separate responsive
  wrapper.
- **`Donut`** — proportional donut with an optional center-content overlay. Composes `ChartFrame`
  directly (radial, not cartesian).

`ZonedLine` and `MultiLine` also accept `xZones?: XZoneSpec[]` — the vertical counterpart to a
kind's horizontal zone bands, for marking a time window rather than a value range. Each
`{ from?, to?, fill, align? }` bound is a `getX` **domain key** (the label string the kind's
`scalePoint<string>` runs over), not a date or timestamp. An omitted bound is the plot edge; a key
absent from the scale's domain skips that band entirely rather than clamping to an edge. `align`
defaults `'center'` (a present bound resolves to the point's own center, today's behaviour);
`align: 'edge'` widens by half a step at each present bound instead — a two-key band covers both
terminal slots in full, and `from === to` renders one step wide instead of being skipped as
degenerate. An edge-aligned bound is clamped into the plot range at the first/last sample.

How to add a chart:

1. **Fits an existing kind?** Use it. Pass `data`, `chartId`, `getX`, `series` (or
   `positiveBars`/`getValue` for `Bars`), an `AxisConfig` per axis (`y`/`y2`), and the declarative
   zones/thresholds/refLines arrays.
2. **Second instance of a new recurring shape?** Extract a kind and migrate both call sites
   (Rule of Three: don't extract on the first, don't wait past the third). Bespoke escape hatches
   (`tooltip.extraRows`, etc.) are fine but must not grow into god-object configs.
3. **Genuinely unique (e.g. a dual-panel MACD, or a dual-axis line pair no kind's config surface
   covers)?** Stay bespoke — compose `CartesianChart` (single-plot) or `ChartFrame` (multi-pane/
   non-cartesian) directly, drawing only marks in the `children` render prop. Keep it in the page's
   chart file, not in a shared kind. See `apps/playground/src/demo/ChartsPage.tsx`'s
   `SessionsRevenueChart` (a dual-axis line pair via `CartesianChart` + `y`/`y2`) and
   `ChannelVolumeChart` (a role-grouped, `maxRows`-capped legend with a threshold-as-legend-entry
   trick) for two real bespoke compositions.

**Anti-pattern:** a single `<Chart type="..." config={...} />` that switches by kind. Prefer N small
kinds.

## Axis config (`AxisConfig<T>`)

One object per axis on `CartesianChart` and every kind that composes it — this collapses the
`yDomain` / `yAutoMaxFloor` / `yAutoMinCeil` / `yAutoPad` / `numTicksY` /
`formatYTick` prop soup:

```tsx
y={{
  domain: 'auto',        // 'auto' (default) | [min, max] | (data, visible) => [min, max]
  autoMaxFloor: 100,      // when 'auto': raw upper bound is at least this, clamped BEFORE padding
  autoMinCeil: 0,         // when 'auto': lower bound is at most this (Infinity = pad from raw min)
  autoPad: 1.1,           // when 'auto': padding multiplier away from the data
  ticks: 5,
  format: (v) => `${v}%`,
  grid: true,             // horizontal grid rules; default on for `y`, off for `y2`
  nice: false,            // default false — opt in to d3's scale.nice() domain rounding
}}
```

**Behavior change (2026-08-19) — the one item in this doc that can move an existing chart's
rendering:** `autoMaxFloor` now clamps the raw upper bound BEFORE padding, mirroring `autoMinCeil`,
which has always clamped first and padded second — two different laws used to live in one function.
The old order padded the raw max, then applied the floor last, so when the floor won it landed
exactly on the axis top with zero headroom: a target line sitting at precisely the floor value was
glued to the plot edge. Measured case: dataMax 3.2, pad 1.1, floor 6 → axis top was 6.0, is now
6.6. A consumer relying on the old ordering will see their axis top move — lower the floor or pin
`domain` explicitly to opt back out.

`nice` defaults `false` deliberately: flipping the default would move the domain of every
already-migrated chart, so it's opt-in per axis.

**Passing `y2` is what makes a chart dual-axis** — it draws the right axis and widens the right
margin by measurement; nothing else flips it on. A series opts into that axis with `axis: 'right'`
on its `ChartSeries` entry (`SeriesStyle.axis`, default `'left'`).

`domain` as a function is the seam a stacked chart uses: it receives `(data, visible)`, so a
domain summed from the VISIBLE series shrinks correctly when the legend toggles a band off
(`StackedArea`'s `yConfig` is the reference — summing `props.series` there instead would leave a
permanent gap above the stack once a band is hidden).

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

A series that's invisible in the plot (flat at the domain floor, filtered to zero) can still carry
an explanation: `SeriesStyle.note` (and so `LegendEntry.note`, via `deriveLegend`) renders a short
muted qualifier after the legend label — e.g. _"Low cloud — 0% all night"_. Keep it to a clause.

`SeriesStyle.strokeOpacity` dims the plotted stroke (e.g. a faint moving-average companion) — the
legend swatch honors it too, parity with `fillOpacity`. The tooltip-row swatch and the crosshair
dot deliberately do NOT honor it: a sub-1 opacity on a 12px value-readout chip reads as a rendering
bug, not as data.

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

There is exactly one responsive path now — `ChartFrame` (composed either directly, or via
`CartesianChart`, which composes it internally). `Heatmap` self-measures
the same way every other kind does, instead of taking `width`/`height` from a separate wrapper.
Every kind and `CartesianChart` itself resolve their size the same three ways, tried in this order:

```tsx
<Bars height={260} … />                 // fixed height (most common)
<Bars aspectRatio={16 / 9} … />         // height = round(measured width / ratio)
<Bars fill … />                          // fills the parent flex/grid cell's measured height
```

Reach for `useChartSize` directly only when composing `ChartFrame`/`CartesianChart` yourself in a
bespoke chart and you need the measured `{ width, height }` for something beyond what those
primitives already do with it — `ChartFrame` already calls it internally for you in the common case.
`UseChartSizeResult`: `{ ref, width, height }`; attach `ref` to the container you want measured.

## Margin

Margins are **measured**, not hand-picked. `CartesianChart` runs every configured axis's tick
labels through `autoMargin`/`measureText` (`basalt-ui/charts`) before laying out the plot, so
`VX.margin` is a **floor**, not the value — a wide tick label (a long right-axis dollar format, a
rotated x label) widens its own gutter automatically instead of clipping or needing a hand-tuned
margin. Passing `y2` to get a dual-axis chart no longer needs a manual margin nudge at all:

```tsx
// now: nothing — passing y2 is what widens the right margin, measured from what's actually painted
<CartesianChart data={data} chartId="x" getX={…} series={SERIES} y={{…}} y2={{…}} />
```

The escape hatch is `margin={{ left: n }}` (`Partial<ChartMargin>`) on `CartesianChart` — a per-side
override applied LAST, after measurement, so it always wins.

`chartMargin(opts?)` (`basalt-ui/tokens`, also re-exported from `basalt-ui/charts`) still exists,
but only matters for a bespoke chart that composes `ChartFrame` directly (not `CartesianChart`) and
needs a right-axis-sized margin without running its own measurement pass — `DualPanel` and `Heatmap`
don't use it today (neither renders a measured dual numeric axis), so treat it as a fallback, not the
default path. It returns `VX.margin` widened for `{ rightAxis: true }`, or any side overridden
directly; returns a new object per call, so memoize it at the call site if you do reach for it.

## Rule of thumb

> If the new chart doesn't fit the primitives, add a kind — don't loosen the primitives.

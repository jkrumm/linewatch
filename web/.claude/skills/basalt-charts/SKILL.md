---
name: basalt-charts
description: Add or extend a chart in a basalt-ui app — pick a kind vs go bespoke (Rule of Three), register a consumer series with defineSeries/groupTokens (since VX.series is app-side, not shipped), compose CartesianChart (or ChartFrame directly for a non-single-plot shape), and respect the @visx-only-in-charts + Mantine-free boundary. Use when adding a new chart, a new metric/series color, or extracting a repeated chart shape into a kind.
when_to_use: User wants to add a chart, restyle an existing one structurally, introduce a new metric/series and its color, extract a recurring chart shape into a reusable kind, or asks where chart series colors live / how to register them. The how-to companion to /basalt-design (which owns the aesthetic law).
---

`/basalt-charts` is the how-to for the chart system. `/basalt-design` owns the aesthetic law
(palette, restraint, the theme-lab loop) and the DESIGN.md precedence — read it for "what color /
how should this look". This skill answers "how do I wire it" with basalt-ui's `./charts` and
`./tokens` surfaces. `docs/CHARTS-SPEC.md` is the ground truth for the chart-primitive contract
everything below assumes — composing `CartesianChart` (single-plot) or `ChartFrame` directly
(multi-pane/radial/matrix) is mandatory, mechanically enforced (see "Respect the boundary" below).

## The decision: kind vs bespoke (Rule of Three)

Before writing chart code, decide which of three paths you are on:

1. **Reuse a shipped kind.** basalt-ui ships `ZonedLine`, `Bars`, `StackedArea`, `MultiLine`,
   `DualPanel`, `Heatmap`, `Donut`. If the shape matches, use it — props are declarative (`data`,
   `chartId`, `getX`, `series`/`positiveBars`, one `AxisConfig` per axis, zones/thresholds/refLines
   as plain arrays). Done.
   - **`ZonedLine`** — a single-series line with zone bands, thresholds, x-zones, refLines.
   - **`Bars`** — 1+ stacked positive/negative bar series, optional line overlays, dual-axis config.
   - **`StackedArea`** — opaque stacked bands, auto cumulative-top y-domain.
   - **`MultiLine`** — N series on a shared y-axis (or two, via `y2`): legend-hover dimming,
     per-series synced dots, dashed companion (MA) lines, per-point markers (PR stars / status
     dots), zones + refLines, fixed or auto domain (also covers z-score/σ charts via a fixed
     symmetric domain + zero refLine). Replaces bespoke multi-line / relative-progression /
     training-load / strength-composite / fitness-trends.
   - **`DualPanel`** — top line-pane + bottom signed-histogram pane sharing ONE x-scale and ONE
     cursor; optional fill-between two top lines, zones, refLines. Replaces bespoke divergence /
     momentum.
   - **`Heatmap`** — category×category intensity grid (`color-mix` alpha), per-cell tooltip,
     optional gradient legend strip. Replaces bespoke time-of-day.
   - **`Donut`** — proportional donut, optional `centerContent` overlay.
2. **Extract a new kind (second instance of a pattern).** When you are about to build the _second_
   chart of a shape that has no shipped kind, extract a kind. Don't extract on the first; don't
   wait past the third. A new kind lives in the consumer's chart kinds dir (or, if generic enough
   to promote, gets contributed to basalt-ui `src/charts/kinds/`). Migrate both call sites onto it.
   A single-plot kind composes `CartesianChart`, drawing only marks; a multi-pane or non-cartesian
   kind composes `ChartFrame` directly (see "Compose the primitives" below).
3. **Stay bespoke (genuinely unique).** A one-off shape (e.g. a dual-panel MACD, or two series on
   genuinely different scales that don't fit any kind's config surface) composes `CartesianChart`
   or `ChartFrame` directly in the page's chart file — not in `kinds/`.

> Anti-pattern: a single `<Chart type="..." config={...} />` god-component that switches by kind.
> That is the Recharts trap. Prefer N small kinds. **If a chart doesn't fit the primitives, add a
> kind — don't loosen the primitives.**

A good kind's props: `data`, `chartId`, generic `getX` accessor, `height`/`aspectRatio`/`fill`,
zones / thresholds / refLines arrays, one `AxisConfig` object per axis, `series: ChartSeries<T>[]`
as the single source of truth for color/label/legend/tooltip. Bespoke escape hatches
(`tooltip.extraRows`, `tooltip.prependRows`) are fine; they must not grow into a god-object config.

`ZonedLine` and `MultiLine` also take `xZones?: XZoneSpec[]` — vertical time-window bands, the
counterpart to the horizontal zones above. `{ from?, to?, fill }` bounds are `getX` **domain keys**
(the label string, not a date/timestamp); an omitted bound is the plot edge, a key missing from the
domain skips the band rather than clamping to one.

## Register a consumer series (VX.series is app-side)

The framework ships generic primitives and the framework palette (semantic / status / neutral /
surface) — **but not a domain series tree.** `VX.series` does not exist in basalt-ui; argo's
`SERIES`/`ACTIVITY`/`USAGE_*` maps stayed app-side. Each consumer rebuilds its own series in **one
guard-exempt file** (e.g. `src/lib/series.ts`), using the shipped extensibility helpers from
`basalt-ui/tokens`:

```ts
// src/lib/series.ts  — the ONE file exempt from `basalt-ui check-theme` (it IS the palette source)
import { defineSeries, groupTokens, seriesTokens, buildPaletteCss } from 'basalt-ui/tokens'

// 1. Author the per-theme pairs (hue keeps identity, shifts shade across schemes).
const HEALTH = defineSeries({
  hrv: { light: '#634DBF', dark: '#7C6BD6' }, // violet — lighter on dark to avoid glow
  restingHr: { light: '#C22762', dark: '#E0639A' },
})
const WALKING = defineSeries({
  intensityMin: { light: '#3F7D4F', dark: '#5FA372' }, // forest green — muted status hue
})

// 2. Turn the maps into namespaced token refs (var(--vx-health-hrv), ...).
//    seriesTokens(map, prefix?) for a flat namespace; groupTokens(name, map) namespaces under name.
export const SERIES = {
  ...seriesTokens(HEALTH), // → { hrv: 'var(--vx-hrv)', restingHr: 'var(--vx-restingHr)' }
  walking: groupTokens('walking', WALKING), // → { intensityMin: 'var(--vx-walking-intensityMin)', ... }
}

// 3. Feed the same maps into the palette CSS so the vars exist in both schemes.
export const PALETTE_CSS = buildPaletteCss({
  groups: { health: HEALTH, walking: WALKING },
  derived: ['--vx-hrv-area: 12%'], // optional scheme-independent derived vars
})
```

- `seriesTokens` / `groupTokens` are **exact-keyed**: a typo or a stale key fails `tsc`, so the
  token surface can't silently drift from the palette data.
- `defineSeries` is the typed authoring entry — it returns the map (sugar; pairs feed both the CSS
  and the tokens).
- Inject `PALETTE_CSS` once (BasaltProvider injects the framework palette; the consumer appends its
  series CSS — or passes `injectPalette={false}` and head-injects both).
- Then charts read `SERIES.hrv`, never a hex. This is what keeps `basalt-ui check-theme` green.
- A series with nothing visible to point at (flat at the domain floor, all-zero) can still carry a
  qualifier: pass `note` on the series' `SeriesStyle` (flows to `LegendEntry.note` via
  `deriveLegend`) and `ChartLegend` renders it, muted, after the label.

Theme tuning of these series happens in the theme lab — pass them as `groups` to
`ThemeLabControls` (see `/basalt-design`).

## Compose the primitives (never hand-roll)

Every chart — kind or bespoke — composes `CartesianChart` for a single plot rect, or `ChartFrame`
directly for a multi-pane / non-cartesian shape (`DualPanel`'s two panes, `Heatmap`'s grid,
`Donut`'s ring). Either way the contract is the same: the primitive owns margin, scales, grid,
axes, legend, the shared cursor, and the tooltip; you supply `series` and draw ONLY marks. This is
mandatory, not a convention — `basalt/hand-rolled-plot` fails the build on a bypass (see "Respect
the boundary" below); it is easier to compose it than to work around it.

**The common case — a single-plot chart:**

```tsx
import { CartesianChart, LinePath, curveMonotoneX, VX } from 'basalt-ui/charts'
import type { ChartSeries } from 'basalt-ui/charts'
import { SERIES } from '../lib/series'

type HrvPoint = { date: string; hrv: number }

const HRV_SERIES: ChartSeries<HrvPoint>[] = [
  { key: 'hrv', label: 'HRV', color: SERIES.hrv, mark: 'line', getValue: (d) => d.hrv },
]

function HrvChart({ data }: { data: HrvPoint[] }) {
  return (
    <CartesianChart
      data={data}
      chartId="hrv"
      getX={(d) => d.date}
      series={HRV_SERIES}
      y={{ domain: 'auto', format: (v) => `${Math.round(v)} ms` }}
      height={240}
    >
      {({ xScale, yScale, visible }) =>
        visible.map((s) => (
          <LinePath<HrvPoint>
            key={s.key}
            data={data}
            x={(d) => xScale(d.date) ?? 0}
            y={(d) => yScale(s.getValue(d) ?? 0)}
            stroke={s.color}
            strokeWidth={VX.lineWidth}
            curve={curveMonotoneX}
          />
        ))
      }
    </CartesianChart>
  )
}
```

`CartesianChart` draws the grid, both axes, the shared cursor + crosshair + dots, and the derived
tooltip for you — `HrvChart` above draws nothing but the line: no hover wiring, no manual
`<AxisLeft>`/`<AxisBottom>`, no tooltip assembly.

**Dual-axis is `y2`, not a flag.** Passing `y2` is what turns on the right axis (margin widens by
measurement); a series opts in with `axis: 'right'` on its `ChartSeries` entry. See
`apps/playground/src/demo/ChartsPage.tsx`'s `SessionsRevenueChart` for a full worked example (two
series on genuinely different scales — session counts vs. `$k` revenue — composed directly from
`CartesianChart` because no shipped kind's config surface covers a dual-axis line pair).

Never substitute: hand-rolled legend markup, a raw `<AxisLeft>`/`<AxisBottom>`/`<AxisRight>`, a
direct `@visx/tooltip` import, or an `rgba()` fill. Sparklines (`charts/sparklines/`) are the one
exemption from the `CartesianChart`/legend/tooltip composition — but they still use `VX.*` tokens.

## The cursor is shared by default

No provider needed. `useChartCursor` reads a module-level external store, so every chart on the
page — kind or bespoke, `CartesianChart` or `ChartFrame` — shares one cursor out of the box, and
resolution is **domain-aware** (nearest parsed date/number within a chart's own step, not exact
string match), so a chart that folds its calendar into weekly buckets still tracks a hover from an
unfolded daily sibling.

Wrap a subtree in `ChartCursorScope` to **isolate** it onto a private cursor instead — the inverse
of the old opt-in pattern, for e.g. two independent dashboards rendered side by side over the same
calendar that must NOT sync with each other:

```tsx
import { ChartCursorScope } from 'basalt-ui/charts'
;<ChartCursorScope>
  <ChartCard>…</ChartCard>
  <ChartCard>…</ChartCard>
</ChartCursorScope>
```

## Respect the boundary (oxlint-enforced)

- **`@visx/*` may only be imported inside chart files.** The shipped consumer oxlint preset bans
  direct `@visx/*` outside `**/charts/**`. Need a raw visx primitive for a bespoke chart? Pull it
  from basalt-ui's curated re-export in `basalt-ui/charts`, or keep the chart under a charts dir.
- **basalt-ui's own `./charts` and `./tokens` are Mantine-free** — zero `@mantine/*` imports,
  keeping the token layer upstream of Mantine inside the framework itself (`cssVariablesResolver`
  reads `--vx-*` tokens to bind Mantine's surfaces to them; a chart importing `@mantine/*` directly
  would fork chrome and charts apart), AND letting `basalt-ui/charts`/`basalt-ui/tokens` resolve and
  render with no `@mantine/*` installed (real, CI-tested — `scripts/pack-test.sh`'s
  "charts/tokens-only (no-Mantine) resolution + render" step). This is a basalt-internal invariant,
  not a rule enforced on your own app code — compose the shipped primitives from
  `basalt-ui/charts`/`basalt-ui/tokens` and you inherit it for free.
- **No raw color literals** anywhere except the one guard-exempt series file (and a deliberate
  `theme-allow` line). `basalt-ui check-theme` is the teeth; run it before committing.
- **No raw visx axes.** `basalt-ui check-theme`'s `raw-visx-axis` guard fails the build on a raw
  `<AxisLeft>`/`<AxisBottom>`/`<AxisRight>` inside any `/charts/` file — use the tokenized
  `AxisLeftNumeric` / `AxisRightNumeric` / `AxisBottomDate` (escape via `theme-allow`).
- **No hand-rolled plot assembly.** `basalt/hand-rolled-plot` fails the build on a chart-assembly
  primitive (`AxisLeftNumeric`, `AxisRightNumeric`, `AxisBottomDate`, `HoverOverlay`, `Crosshair`)
  rendered in a file that doesn't compose `CartesianChart`, per NODE. Escape:
  `theme-allow hand-rolled-plot — <why>` on the one node, or `theme-allow-file hand-rolled-plot —
<why>` anywhere in the file — how a genuinely non-single-plot shape (`DualPanel`, `Heatmap`,
  `Donut`) declares itself. `-file` is the 1.20.1 spelling and it is required. The file that defines
  `CartesianChart` is exempt definitionally.
- **No hand-authored legends.** `basalt/chart-legend-literal` fails the build on a hand-written
  array literal passed to `ChartLegend`'s `items` — derive it from the same `series` the chart draws
  (`deriveLegend`, or let `ChartFrame`/`CartesianChart` do it) so it can't name a series the plot no
  longer draws.
- Both ship at `warn` in the consumer preset (`configs/oxlint.json`) for one minor and `error`
  repo-local (the "grace minor" doctrine in `packages/basalt-ui/CLAUDE.md`) — promoting to `error`
  in the next minor.

## Checklist for a new chart

- Picked the right path: reused a kind / extracted on the second instance / stayed bespoke for a
  true one-off.
- Composed `CartesianChart` (single plot) or `ChartFrame` directly (multi-pane / non-cartesian) —
  never hand-assembled margin/scales/axes/cursor/tooltip.
- Any new metric color is a `{ light, dark }` pair in the consumer series file, exposed via
  `seriesTokens`/`groupTokens`, and wired into `PALETTE_CSS` via `buildPaletteCss`.
- Charts read `SERIES.*` / `VX.*` — `basalt-ui check-theme` green, zero raw hex.
- Marks draw `ctx.visible`, never the `series` prop, so a legend toggle actually removes them.
- `@visx/*` stays inside chart files; chart code imports no `@mantine/*`.
- Tuned both schemes via the theme lab where the hue needed it (defer to `/basalt-design`).

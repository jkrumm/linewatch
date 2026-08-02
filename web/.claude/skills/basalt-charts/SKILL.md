---
name: basalt-charts
description: Add or extend a chart in a basalt-ui app — pick a kind vs go bespoke (Rule of Three), register a consumer series with defineSeries/groupTokens (since VX.series is app-side, not shipped), compose the visx primitives, and respect the @visx-only-in-charts + Mantine-free boundary. Use when adding a new chart, a new metric/series color, or extracting a repeated chart shape into a kind.
when_to_use: User wants to add a chart, restyle an existing one structurally, introduce a new metric/series and its color, extract a recurring chart shape into a reusable kind, or asks where chart series colors live / how to register them. The how-to companion to /basalt-design (which owns the aesthetic law).
---

`/basalt-charts` is the how-to for the chart system. `/basalt-design` owns the aesthetic law
(palette, restraint, the theme-lab loop) and the DESIGN.md precedence — read it for "what color /
how should this look". This skill answers "how do I wire it" with basalt-ui's `./charts` and
`./tokens` surfaces.

## The decision: kind vs bespoke (Rule of Three)

Before writing chart code, decide which of three paths you are on:

1. **Reuse a shipped kind.** basalt-ui ships `ZonedLine`, `Bars`, `StackedArea`, `Donut`,
   `MultiLine`, `DualPanel`, `Heatmap`. If the shape matches, use it — props are declarative (data,
   width/height, `getX`/`getY` accessors, zones/thresholds/refLines as plain arrays, `seriesLabel`,
   `formatValue`). Done.
   - **`MultiLine`** — N series on a shared y-axis: legend-hover dimming, per-series synced dots,
     dashed companion (MA) lines, per-point markers (PR stars / status dots), zones + refLines,
     fixed or auto domain (also covers z-score/σ charts via a fixed symmetric domain + zero
     refLine). Replaces bespoke multi-line / relative-progression / training-load /
     strength-composite / fitness-trends.
   - **`DualPanel`** — top line-pane + bottom signed-histogram pane sharing ONE x-scale and ONE
     cursor; optional fill-between two top lines, zones, refLines. Replaces bespoke divergence /
     momentum.
   - **`Heatmap`** — category×category intensity grid (`color-mix` alpha), per-cell tooltip,
     optional gradient legend strip. Replaces bespoke time-of-day.
2. **Extract a new kind (second instance of a pattern).** When you are about to build the _second_
   chart of a shape that has no shipped kind, extract a kind. Don't extract on the first; don't
   wait past the third. A new kind lives in the consumer's chart kinds dir (or, if generic enough
   to promote, gets contributed to basalt-ui `src/charts/kinds/`). Migrate both call sites onto it.
3. **Stay bespoke (genuinely unique).** A one-off dual-panel shape (e.g. MACD) composes the
   primitives directly in the page's chart file — not in `kinds/`.

> Anti-pattern: a single `<Chart type="..." config={...} />` god-component that switches by kind.
> That is the Recharts trap. Prefer N small kinds. **If a chart doesn't fit the primitives, add a
> kind — don't loosen the primitives.**

A good kind's props: `data`, `width`, `height`, `chartId`, generic `getX`/`getY` accessors, zones /
thresholds / refLines arrays, `seriesLabel`, `formatValue`, optional `tooltipLabel`. Bespoke escape
hatches (`renderExtraTooltipRows`) are fine; they must not grow into a god-object config.

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

Theme tuning of these series happens in the theme lab — pass them as `groups` to
`ThemeLabControls` (see `/basalt-design`).

## Compose the primitives (never hand-roll)

Every chart — kind or bespoke — composes the shipped primitives. The contract is social and
lint-backed; it is easier to compose them than to work around them.

```tsx
import {
  ChartCard,
  ChartLegend,
  AxisBottomDate,
  AxisLeftNumeric,
  HoverOverlay,
  AreaGradient,
  areaFillUrl,
  ChartTooltip,
  TooltipHeader,
  TooltipRow,
  useChartTooltip,
  useHoverSync,
  VX,
  alpha,
} from 'basalt-ui/charts' // ./charts re-exports the token layer too
import { SERIES } from '../lib/series'

function HrvChart({ data, width, height }: HrvChartProps) {
  const tip = useChartTooltip<HrvPoint>()
  // ... scales ...
  return (
    <ChartCard title="HRV" info="7-day rolling">
      <svg width={width} height={height}>
        <AreaGradient id="hrv" color={SERIES.hrv} />
        {/* ...LinePath fill={areaFillUrl('hrv')} stroke={SERIES.hrv}... */}
        <AxisLeftNumeric scale={yScale} /* tokenized ticks */ />
        <AxisBottomDate scale={xScale} />
        <HoverOverlay {...tip.overlayProps} />
      </svg>
      <ChartLegend entries={[{ label: 'HRV', color: SERIES.hrv, shape: 'line' }]} />
      <ChartTooltip {...tip.tooltipProps}>
        <TooltipHeader>{/* date */}</TooltipHeader>
        <TooltipRow swatch={SERIES.hrv} label="HRV" value={/* ... */} />
      </ChartTooltip>
    </ChartCard>
  )
}
```

Never substitute: hand-rolled legend markup, a raw `<AxisLeft>`/`<AxisBottom>`, a direct
`@visx/tooltip` import, or an `rgba()` fill. Use `ChartLegend`, the tokenized axes, `ChartTooltip`,
and `alpha(token, a)`. Sparklines (`charts/sparklines/`) are the one exemption from the
Card/Legend/Tooltip composition — but they still use `VX.*` tokens.

## Cross-chart cursor sync

Wrap a group of date-aligned charts in `ChartHoverSync` (from `basalt-ui/charts`) to activate
cross-chart cursor sync — hovering one chart casts a ghost crosshair on every sibling. Without the
provider, `useHoverSync` runs per-chart only (and logs a dev warning):

```tsx
import { ChartHoverSync } from 'basalt-ui/charts'
;<ChartHoverSync>
  <ChartCard>…</ChartCard>
  <ChartCard>…</ChartCard>
</ChartHoverSync>
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

## Checklist for a new chart

- Picked the right path: reused a kind / extracted on the second instance / stayed bespoke for a
  true one-off.
- Any new metric color is a `{ light, dark }` pair in the consumer series file, exposed via
  `seriesTokens`/`groupTokens`, and wired into `PALETTE_CSS` via `buildPaletteCss`.
- Charts read `SERIES.*` / `VX.*` — `basalt-ui check-theme` green, zero raw hex.
- Composed `ChartCard` / `ChartLegend` / tokenized axes / `ChartTooltip` — no hand-rolled markup,
  no direct `@visx/tooltip`.
- `@visx/*` stays inside chart files; chart code imports no `@mantine/*`.
- Tuned both schemes via the theme lab where the hue needed it (defer to `/basalt-design`).

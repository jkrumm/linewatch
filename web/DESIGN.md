# linewatch-web — Design

> Managed by basalt-ui (1.8.0). This is a **thin** instantiation — it records this
> app's **deltas only** on top of the shipped `basalt-*` rules. The universal law (earned color,
> neutral-by-default, three-tier `--vx-*` tokens, theme-is-data, the chart primitive contract, the
> elevation/density/shape doctrine) lives in those rules and the `/basalt:design` skill, and is
> **not** repeated here. Touch this file only to confirm identity, register the app's series, or
> record a genuine deviation.

## Precedence (when guidance conflicts)

This file's deltas win, then the shipped rules, then any skill:

1. **This file** (`linewatch-web` DESIGN.md) — app-specific deltas. Highest authority.
2. **`basalt-*` rules** (`.claude/rules/basalt-*.md`) — the shipped law and its enforcement.
3. **Skills** (`/basalt:design`, `/basalt:charts`, `/frontend-design`, …) — generic method, lowest.

A skill never overrides this file or the `basalt-*` rules. When a skill's instinct collides with the
law, the law wins.

## Identity

linewatch-web inherits the basalt-ui identity verbatim: modern zinc surfaces, one earned saturated
sky-blue accent, the `shadow-card` / `shadow-raised` / `shadow-overlay` depth split,
dense-by-default spacing, and the three-font system. The
law itself — every hex, role split, and enforcement rule — lives in the `basalt-tokens` and
`basalt-mantine` rules (`.claude/rules/basalt-{tokens,mantine}.md`) and `docs/DESIGN-SPEC.md` in
the basalt-ui repo; it is **not** restated here. Confirm or restate any intentional identity shift
below; **silence means "inherits the basalt-ui defaults unchanged."**

- **Accent hue:** blue (default: the saturated sky accent — `var(--vx-line)` neutral is
  still the default for single-series marks)
- **Tone deltas:** _(none — inherits)_

## Series dictionary

The framework owns the **roles** and the **available hues** (see the `basalt-tokens` rule). This
table is the app's **data dictionary** — which metric maps to which hue, as `{light,dark}` pairs,
wired through `defineSeries()`. This is the one design artifact that legitimately lives in the
consumer; keep it the single source of truth and never inline a hex elsewhere.

**Empty, and correct.** linewatch registers no app series: every mark on the dashboard is either a
single-series metric drawn neutral (`VX.line`), the one earned accent (`VX.accent`, spent on the
internet band and the download line), or a status verdict (`VX.status.*`). Nothing here needs
categorical separation, so nothing has earned a hue of its own. Add a row only when a chart draws
two or more series that must be told apart by colour — and never inline a hex to do it.

| Series name | Light hex | Dark hex | `defineSeries` key | Role / earned reason |
|-|-|-|-|-|
| _(none)_ | | | | |

```ts
// src/lib/series.ts — the app's guard-exempt series file
import { defineSeries, groupTokens } from 'basalt-ui/tokens'

const SERIES_MAP = defineSeries({
  // requests: { light: '#4f78a4', dark: '#7099c4' },
})

export const series = groupTokens('app', SERIES_MAP) // { requests: 'var(--vx-app-requests)', ... }
export const paletteGroups = { 'app-': SERIES_MAP }
// wire into the provider: <BasaltProvider paletteOptions={{ groups: paletteGroups }} .../>
// (paletteOptions takes the group map directly — not a CSS string; read `series.requests` in charts)
```

Rules for this table (from the `basalt-tokens` / `basalt-charts` rules — do not relax):
- One hue per series, drawn from the identity families only. Never raw Material/AntD/Tailwind.
- A series earns a color only for **trend**, **signal/status**, or **categorical separation**.
  A lone single-series metric stays neutral (`var(--vx-line)`).
- Light is one shade **deeper**, dark one shade **lighter** — same hue, never the same hex.

## App deviations

Genuine, intentional departures from the basalt-ui defaults — each with a one-line justification. An
empty section is the correct default; do not invent deviations to fill it.

- _(none yet)_

---
name: basalt-design
description: Design and restyle data visualizations and analytics UIs in a basalt-ui app (Mantine v9 + visx). The dataviz successor — restraint doctrine plus the live theme-lab tuning loop and the centralized, lint-enforced --vx-* token system. Use when building or restyling charts/dashboards, choosing a palette, tuning dark/light, or when charts look childish / inconsistent / over-colored.
when_to_use: User is building or restyling charts, dashboards, or metric UIs in a basalt-ui consumer; picking or tuning a palette; deciding on dark/light shades; or complaining that charts look "AI default", inconsistent across tabs, or over-saturated. Also the entry point for any "make this look professional" dataviz request in a Mantine + visx app.
---

`/basalt-design` is the design authority for a basalt-ui app. It is the **method**; the project's
doctrine is the **law**. Professional dataviz is restraint, not decoration — this skill encodes
that restraint and the concrete, lint-enforced way basalt-ui makes it impossible to bypass.

## Read the law first (strict precedence)

Before applying any generic guidance, load the doctrine in this exact order and obey the highest
one that exists. Lower layers fill gaps; they never override a higher layer.

1. **Consumer `DESIGN.md`** (repo root) — the thin, app-specific instantiation. Identity
   confirmation, the series dictionary, app deviations. **This wins on every conflict.** It is the
   Google-spec convention (YAML token front matter + Markdown prose, sibling to `CLAUDE.md`).
2. **Shipped `basalt-*` rules** (`.claude/rules/basalt-{tokens,charts,mantine,state}.md`) — the
   universal law AND its enforcement: the Basalt modern-zinc palette + saturated sky accent,
   one-hue-per-metric, neutral structure, gradient defaults, the three-tier token contract, the
   elevation/density doctrine.
3. **This skill** — only the loop and the judgment, where the above are silent.

If a consumer `DESIGN.md` does not exist yet, the app has not been scaffolded — run `/basalt-app`
(it wraps `basalt-ui init`, which writes the thin `DESIGN.md` and the `basalt-*` rules). Do not invent
a palette ad hoc.

## Restraint doctrine (decide before touching code)

This is the same restraint `frontend-design` calls for, applied to data: intentionality over
intensity. The `basalt-ui init` CLAUDE block sets a restraint override for exactly this reason — in a
dashboard the bold move is calm.

- **One muted hue family, reused everywhere.** The Basalt modern-zinc identity (below), never raw
  Material / AntD / Tailwind primaries (they read childish and clash). A small harmonious subset
  across every page so tabs feel like one app.
- **Single hue per metric.** Each metric owns ONE color, stable across all views (HRV always
  violet, bench always amber). Series colors are app-side and distinct from the UI accent — don't
  reuse the sky accent as a metric hue. Multiple colors only for genuinely categorical data
  (sleep stages, source breakdown). A line chart almost never needs more than one hue plus neutrals.
- **Neutral structure, colored signal.** Lines/axes/grids in muted neutrals; color is the data and
  status (good/warn/bad). A single neutral line with a soft tinted area reads more premium than a
  rainbow.
- **Gradients on areas, not everything.** A soft single-hue vertical gradient under a line is the
  canonical "modern" move (`AreaGradient`). Keep stacked-area bands opaque — transparency leaks
  lower bands.
- **Quiet chrome.** Hairline grids (~6–8% neutral), thin crosshairs, restrained tooltips with a
  card surface and one accent swatch per row. Generous whitespace.
- **Motion restraint (same doctrine, applied to animation).** Subtle and purposeful, never
  decorative — a state change earns a transition, idle chrome does not. Reach for the shared
  `MOTION_DURATION` / `MOTION_SPRING` tokens (`basalt-ui`'s `src/motion`) instead of inventing
  per-component durations/easings, so animated chrome feels like one identity the same way the
  `--vx-*` palette does for color. Never a looping/pulsing idle animation. Always respect
  `useReducedMotion` (`@mantine/hooks`) — an animated component needs a real unanimated code path,
  not just `duration: 0`.

## Color identity & accent restraint (the #1 lever)

The Basalt identity is **modern zinc + a saturated sky accent** — cool-neutral zinc surfaces
(Tailwind zinc family) on both schemes, a slightly darker page with panels lifting off it via depth
(a whisper shadow + 1px ring, `shadow-card` — never a bare border), and one saturated sky-blue
accent. Restraint is now about _placement_, not _saturation_ — the accent is louder than the old
muted-slate identity, so the discipline below (where it appears / where it never appears) carries
more of the weight.

**Neutrals carry the surface — cool zinc on both schemes**, never warm-neutral/off-white, never
steel-blue, never pure black/white:

- **Dark:** bg `color-mix(in srgb, #27272a 70%, #18181b)` (#232326), panel `#27272a`, panel-hover
  `color-mix(in srgb, #3f3f46 50%, #27272a)` (#333338), hairline (card ring)
  `color-mix(in srgb, #52525c 50%, #3f3f46)` (#494951), line (strong border) `#3f3f46`. Ink
  `#e5e5e5`, muted `#d4d4d4`, faint `#a1a1a1`.
- **Light:** bg `color-mix(in srgb, #f4f4f5 50%, #e4e4e7)` (#ececee), panel `#f4f4f5`, panel-hover
  `#fafafa`, hairline `#e5e5e5`, line (strong border) `color-mix(in srgb, #e4e4e7 50%, #d4d4d8)`
  (#dcdce0). Ink `#262626`, muted `#525252`, faint `#737373`.

The surface token set is `bg` (page) · `panel` (cards, controls) · `panel-hover` · `line` (strong
border) · `hairline` (card ring, lives inside `shadow-card`, never rendered as a bare `border`) ·
`divider` (layout separators).

**One accent, saturated sky-blue — split by ROLE.** As **ink** (links, active-nav icon, chart lines,
focus ring) it is read against the page, so it inverts: `#0077bd` light / `#8ec5ff` dark. As a
**filled surface** it carries a label, so it is squeezed between that label (≥4.5:1) and the page
behind it (≥3:1) — which leaves one luminance band, the same on both pages: `#0077bd` with a WHITE
label, in BOTH schemes. Fill with `--vx-accent-fill` / `--vx-fill-{family}`, never with `--vx-accent`
(a light fill cannot carry white text). Every Mantine family's fill sits in that same band, so a
filled surface always reads white. With `accent-hover` (derived from the fill) and `on-accent`
companions (NOT the old ~50%-saturation muted slate).

The accent appears on: the primary data series, active-nav **icons** and active **child** labels,
links, primary buttons, focus rings, and the leader bar in meters. It stays off: general chrome,
borders, large fills, every icon, secondary buttons. "Ink earns its color" — neutral does the
structure, the accent only points.

- **Active nav = an ink-9% tint + accent-colored icon + weight-600 ink text** — no panel fill, no
  shadow, and never a full accent fill. It's a selected row, not a raised control. The theme bakes
  this into `NavLink` for every render path — don't re-color it.
- **Buttons:** exactly one filled-accent primary CTA per view; every other action is
  `variant="default"` (neutral). Avoid colored `variant="light"` for routine actions.
- **Status:** positive deltas `color="green"` (forest), never `teal`/turquoise/saturated emerald.
- **Dark done right:** cool zinc, neutral/faint-cool, never steel-blue, never pure black; the
  dark-scheme accent (`#8ec5ff`) is lighter/less saturated than its light counterpart so it doesn't
  glow/bleed.
- **Light done right:** cool zinc page + panel lift (never warm/off-white); depth comes from
  `shadow-card`, not a bare hairline border.

### Density & surface consistency

- **Dense by default** (Linear/Notion): compact nav rows, `sm` (12px) gaps and card padding, a
  48px shell header. Separate by surface + `shadow-card`, not by large air — default to the
  tighter step.
- **All cards render identically:** Mantine `Card`/`Paper` **and** the Mantine-free `ChartCard`
  resolve to **one radius token** (`--vx-radius-card` = 7px) and **`shadow-card`** — a whisper
  shadow with the 1px ring baked into the shadow itself, **no `border` property**. Never
  inline-override a surface's `border`/`borderRadius`/`boxShadow`/`backgroundColor` — use the
  radius token + `VX.surface.*` / the shadow-card token. Mechanically enforced by
  `basalt-ui check-theme`'s `raw-surface` guard.
- **Depth splits control-vs-panel-vs-floating** — three tokens, not one. Panels holding content
  (Card/Paper/Notification/ChartCard) take `shadow-card`; anything you click or type into (Button,
  ActionIcon, inputs, chips, the search trigger) takes `shadow-raised`, whose ring is INSET so one
  value rides a fill, a tint and a panel alike; detached floating surfaces (Tooltip/Popover/Menu/
  Modal/Drawer) take `shadow-overlay`. Depth is static — nothing lifts or gains a shadow on hover,
  and emphasis is carried by fill weight, never z-height. Full doctrine in the `basalt-mantine`
  rule.
- **Strict surfaces & primitives.** The theme runs a strict surface system: Mantine components read
  raw ramp steps directly, so `cssVariablesResolver` **collapses the ramp steps onto the
  `--vx-surface-*` tokens** — one depth token per tier, one card bg, one radius across every
  component (AppShell, Table, Input, Divider, Tabs, Popover, Accordion, cards). Consumer code must
  **use Mantine layout primitives** (`Box`/`Flex`/`Grid`/`SimpleGrid`/`Stack`/`Group`/`Paper`/`Card`),
  not raw `<div>`/`<span>` with inline `style`. `check-theme` adds five guard kinds to enforce this
  (default ON, `theme-allow` escape): `off-system-surface-var` (raw ramp-step vars),
  `mantine-shade-index` (a shade-pinned color — `c="yellow.7"` is one fixed swatch in both schemes;
  use `VX.status.*` or the bare hue name), `raw-html-layout`, `inline-spacing`, `inline-display`.
  Only the Mantine-free `src/charts/**` may use raw `<div>` (still with `VX.*` tokens).
- **Reach for the shipped composite before wrapping one.** A `StatCard` carrying a threshold verdict
  takes `tone="good" | "warn" | "bad"` (an accent rail down its leading edge). Omitting `tone` is not
  the same as `"good"` — omitted means "fine, or nothing measured" and stays untinted, so `"good"` is
  a positive assertion you opt into for a value that earned it (`0 min` downtime), never a default.
  A chart goes in `ChartCard`. Wrapping
  a shipped card in a hand-positioned `Box` to add a mark it already has is how an app grows a second
  card idiom — one the guard cannot recognize as a card, and therefore cannot police. If a composite
  genuinely can't express what you need, that is a gap to report, not to route around.

**Anti-slop checklist:** no pure `#000`/`#fff`; one accent locked page-wide; neutral does the
structure, accent only points; don't flood blue; hierarchy via scale/weight/contrast/space, not
color; depth = `shadow-card` (whisper shadow + ring), never a bare hairline border on cards.

## The three-tier token system (centralize + enforce)

Aesthetics only survive if they cannot be bypassed. basalt-ui ships this as the `./tokens` and
`./charts` surfaces:

1. **Palette data** — the Basalt modern-zinc ramps + the saturated sky accent family, plus
   every semantic/status/neutral/surface entry as a per-theme `{ light, dark }` pair. Pure data: no
   React, no `@mantine/*`, no browser API.
2. **CSS variables** — `buildPaletteCss(opts)` emits the pairs as `--vx-*` custom properties under
   the light/dark color-scheme selector. Theme resolution is **pure CSS** — no JS branching, works
   in non-component files.
3. **Token refs** — `VX.*` are just `var(--vx-*)` strings (colors) plus non-color sizing constants.
   Opacity via `alpha(token, a)` (= `color-mix`), **never** `rgba()` — the hue must keep resolving
   per scheme.

Hard rules (the guard enforces these, not just prose):

- **Never a raw hex / `rgb()` / `hsl()` in chart or app source.** Route every color through
  `VX.*` / the palette. `basalt-ui check-theme` fails the build on a literal; a `theme-allow` comment
  is the only deliberate exception.
- **Never `localStorage.getItem('theme')`.** The scheme resolves via Mantine's color scheme + the
  `--vx-*` vars. The guard bans this read.
- New colors go into the palette as `{ light, dark }` pairs — never inline, never two
  `fooLight`/`fooDark` keys.

```ts
import { VX, alpha } from 'basalt-ui/tokens'
import { SERIES } from '../lib/series' // consumer-owned — see /basalt-charts

const stroke = SERIES.hrv // app-side series ref (consumer-defined — see /basalt-charts)
const fill = alpha(SERIES.hrv, 0.12) // theme-aware soft area, NOT rgba()
const grid = VX.grid // framework neutral
```

## Drive the theme-lab loop (tune by eye, then bake)

Static HTML POCs do not translate 1:1 to visx/Mantine. Tune in the **real app** with the shipped
theme lab (`basalt-ui/theme-lab`), then bake the values into the palette. The lab writes overrides
as inline `--vx-*` styles on `<html>`, which beat the stylesheet's per-scheme rules — so everything
restyles **instantly with no React re-render**.

Wire it (DEV-only) inside a dev dock popover:

```tsx
import { ThemeLabControls, applyOverrides, loadOverrides } from 'basalt-ui/theme-lab'

// At boot — re-apply a persisted tuning session (the control body does NOT do the initial apply):
applyOverrides(loadOverrides())

// In the dev dock — pass the consumer's own series groups so they're tunable too:
<ThemeLabControls
  groups={[
    ...COLOR_GROUPS,                       // framework: Semantic / Status / Neutral / Surface
    { title: 'Health', items: [{ var: '--vx-hrv', label: 'HRV' }, /* ... */] },
  ]}
  onCopy={(json) => notifications.show({ message: 'Overrides copied' })}
  copyIcon={<IconCopy size={16} />}        // framework ships no icon/notification dep
  resetIcon={<IconRefresh size={16} />}
/>
```

The loop:

1. Open the lab, adjust `--vx-*` colors and the area-gradient strength (`--vx-area-top` /
   `--vx-area-bottom`) by eye, in both schemes.
2. Toggle the Mantine color scheme and re-check: saturated mid-tones **glow/bleed on dark** — step
   one shade lighter and slightly desaturated; on light go one shade deeper for contrast. Same hue,
   different shade — **never the same hex in both**.
3. **Copy JSON** → hand the values back into the palette data as `{ light, dark }` pairs.
4. Remove the override (or "Reset to palette defaults") and confirm the baked palette matches.

The lab is a tuning sandbox, not a prod theme editor: inline overrides apply to whatever scheme is
on screen and win over both light and dark rules. It is the closing step of design, not a shipped
feature.

## Primitives + kind discipline (don't loosen, extend)

Every chart composes the shipped primitives — never hand-rolled equivalents:

- **`ChartCard`** wrapper (title + info-tooltip + extra slot, consistent margin).
- **`ChartLegend`** (`line | bar | split | splitLine` shapes) — never hand-rolled legend markup.
- **`ChartTooltipFloat`** + `TooltipHeader` / `TooltipRow` / `TooltipBody` — never import `@visx/tooltip`
  directly (oxlint bans it in chart files).
- **`AxisBottomDate`** / **`AxisLeftNumeric`** / **`AxisRightNumeric`** — never raw
  `<AxisLeft>`/`<AxisBottom>` (they miss theme tokens + smart ticks). Now lint-enforced:
  `basalt-ui check-theme`'s `raw-visx-axis` guard fails the build on a raw axis inside a `/charts/`
  file (escape via `theme-allow`).
- **The cursor is shared by default** — `CartesianChart` wires the hover overlay, crosshair, dots
  and tooltip itself, and every chart on the page tracks one cursor through a module-level store
  with no provider. Reach for `useChartCursor` only in a hand-composed non-single-plot shape, and
  for **`ChartCursorScope`** only to opt a subtree OUT of sharing.
- **`AreaGradient`** / `areaFillUrl` for the soft single-hue fill.

Shipped kinds beyond `ZonedLine` / `Bars` / `StackedArea` / `Donut`: **`MultiLine`** (N series on a
shared y-axis, legend-hover dimming, dashed MA companions, per-point markers, zones/refLines, fixed
or auto domain — also z-score/σ via a symmetric domain + zero refLine), **`DualPanel`** (line pane

- signed-histogram pane on one x-scale and cursor, optional fill-between), **`Heatmap`**
  (category×category intensity grid with per-cell tooltip + optional gradient legend strip).

> If the new chart does not fit the primitives, **add a kind — don't loosen the primitives.**
> Recurring shape → extract a kind via the Rule of Three. Genuinely unique → stay bespoke,
> composing primitives directly. New color → a `{ light, dark }` pair in the palette, wired through
> `--vx-*`, exposed as a `VX.*` ref — never an inline hex. The mechanics of all three live in
> **`/basalt-charts`** — defer to it for the "how".

The Mantine-free boundary holds here too: `./charts` and `./tokens` import zero `@mantine/*` (an
internal invariant keeping the token layer upstream of Mantine, and letting those two subpaths
resolve/render with no `@mantine/*` installed — CI-tested, repo-local only, not shipped), and
`@visx/*` is only allowed under chart files (oxlint-enforced in the shipped consumer preset too).

## Checklist before declaring a chart "done"

- Every color comes from a token (`VX.*` / palette) — `basalt-ui check-theme` green, zero raw hex.
- One hue per metric; categorical multi-color only where the data is genuinely categorical.
- Neutral line/axis/grid; soft `AreaGradient` on plain metric lines, opaque stacked-area bands.
- Tooltip = `ChartCard` / `ChartTooltipFloat` primitives, one swatch per row — no hand-rolled markup.
- Looks right in BOTH schemes (toggled and checked: glow on dark, contrast on light).
- New colors landed as `{ light, dark }` pairs in the palette, not inline.
- Nothing reads `localStorage.getItem('theme')`.

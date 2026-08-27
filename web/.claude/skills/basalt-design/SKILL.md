---
name: basalt-design
description: Design and restyle dashboards, charts and metric UIs in a basalt-ui app (Mantine v9 + visx) — the procedure: read the law, decide before coding, tune by eye in the theme lab, bake the values back into the palette. Use when building or restyling charts/dashboards, choosing or tuning a palette, or when a UI looks childish / inconsistent / over-colored.
when_to_use: User is building or restyling charts, dashboards or metric UIs in a basalt-ui consumer; picking or tuning a palette; deciding dark/light shades; or complaining that a UI looks "AI default", inconsistent across tabs or over-saturated. Also the entry point for any "make this look professional" request in a Mantine + visx app.
---

`/basalt-design` is the METHOD. The law is the `basalt-*` rules plus this app's `DESIGN.md`, and the
managed `CLAUDE.md` block states which wins — read them, do not re-derive them here. This skill is
the sequence to follow and the loop to run.

## 1. Load the law before touching code

- `.claude/rules/basalt-tokens.md` — the identity, the color/spacing/type law, `theme-allow`.
- `.claude/rules/basalt-mantine.md` — provider, shell, surfaces, depth, motion.
- `.claude/rules/basalt-controls.md` — where a control lives and what sizes it.
- `.claude/rules/basalt-charts.md` — the chart contract. `/basalt-charts` is the how-to.
- `./DESIGN.md` — this app's deltas: identity confirmation, series dictionary, deviations.

**No `DESIGN.md` means the app was never scaffolded** — run `/basalt-app` first. Never invent a
palette ad hoc.

## 2. Decide before coding

Answer these four in one pass; each one is a decision, not a preference:

1. **What earns a hue here?** Trend, signal/status, or genuine categorical separation. Everything
   else is neutral. One hue per metric, stable across every view.
2. **Where does each control live?** One home per control, and the home sets its size (law C1/C5).
3. **What is the one primary action on this view?** Exactly one filled accent; everything else
   neutral.
4. **What does this surface reuse?** Check the shipped composite FIRST — `StatCard`, `ChartCard`,
   `Section`, `BasaltDataTable`, `QueryState`, `EmptyState`. A fork by a token-fluent author passes
   every gate, so no guard will tell you; asking is the control. If a composite genuinely cannot
   express the case, that is a gap to REPORT, not to route around.

## 3. Build it

Compose Mantine primitives and shipped composites; pull every color from `VX.*` / a series token.
Let the theme carry size, radius, depth and font — a prop you did not have to pass is the point.

## 4. Tune by eye, then bake

A static POC never translates 1:1 to visx + Mantine. Tune in the REAL app with the shipped lab
(`basalt-ui/theme-lab`), which writes inline `--vx-*` overrides on `<html>` — they beat the
stylesheet, so everything restyles instantly with no React re-render.

```tsx
import { ThemeLabControls, applyOverrides, loadOverrides } from 'basalt-ui/theme-lab'

applyOverrides(loadOverrides()) // at boot — the control body does NOT do the initial apply
;<ThemeLabControls groups={[...COLOR_GROUPS, appSeriesGroup]} onCopy={notifyCopied} />
```

1. Adjust colors and the area-gradient strength by eye — in BOTH schemes.
2. Toggle the scheme and re-check: a saturated mid-tone glows on dark (step lighter, slightly
   desaturated) and washes out on light (step deeper). Same hue, different shade, **never the same
   value in both**.
3. Copy the JSON and hand the values back into the palette as `{ light, dark }` pairs — or, for the
   identity itself, into the derive config's knobs rather than a hand-picked hex.
4. Remove the override and confirm the baked palette matches.

`DeriveControls` is the identity/colour knobs (seed + the bounded levels + radius + density) and is
faithful to `createBasaltTheme`; `ThemeLabControls` is the low-level inspector for the non-derived
structural tokens. Both are DEV tools and inert in a production build — run the dev server.

## 5. Verify before calling it done

- `basalt-ui check-theme` green: zero raw hex, zero `rgba()`, nothing reading `localStorage['theme']`.
- `oxlint .` green on the `basalt/*` rules — no hand-rolled filter (in a slot) and no in-body
  `<Title order={1|2}>`. Hand-rolled section headings are NOT lint-visible (see the `not guarded`
  line in `basalt-controls.md`'s coverage header): grep the diff for `fw={600}` / `<Title order={3`
  headings by hand and replace them with `WidgetHeader` / `Section`.
- One hue per metric; neutral structure; the accent only points.
- Checked in BOTH schemes, and below `sm` as well as on a wide viewport.
- Any new color landed as a `{ light, dark }` pair in the consumer series file, never inline.
- Nothing you built duplicates a shipped composite.

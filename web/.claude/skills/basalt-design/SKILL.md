---
name: basalt-design
description: Build or restyle dashboards and metric UIs in a basalt-ui app — read the law, decide, build, tune in the theme lab, verify.
when_to_use: User is building or restyling dashboards, charts or metric UIs; tuning a palette; or says a UI looks inconsistent, over-colored or "AI default". Entry point for "make this look professional".
---

Method only; the law is `.claude/rules/basalt-*.md` and `./DESIGN.md`.

## Steps

1. Read `./DESIGN.md` and the rules `basalt-tokens.md`, `basalt-mantine.md`, `basalt-controls.md`, `basalt-charts.md`. No `DESIGN.md`: run `/basalt-app` first.
2. Decide before coding: which metrics earn a hue (trend, status, separation; the rest neutral), the one primary action per view, each control's home (a `SettingsRow` preference: `const [unit, setUnit] = prefs.field.unit.use()` from `createLocalStore`, then `control={<Select value={unit} onChange={(v) => v && setUnit(v)} />}`, never `useState`).
3. Check the shipped composites first: `StatCard`, `ChartCard`, `Section`, `WidgetHeader`, `BasaltDataTable`, `EmptyState`. A gap is reported, not routed around.
4. Build with Mantine primitives and the composites; take every color from `VX.*` or a series token.
5. Tune by eye in the running app: open the theme lab with the `dev.theme` Spotlight command (dev only) and adjust in both color schemes.
6. Bake the values back: identity changes go into the `derive` knobs of `createBasaltTheme`, series colors into `src/lib/series.ts` as `{ light, dark }` pairs. Clear the lab overrides and confirm the baked result matches.
7. Run the repo's own gate (e.g. `make check`), which runs lint, the theme guard and typecheck; fix every finding at its source.
8. Check both schemes, and below and above the `sm` breakpoint.

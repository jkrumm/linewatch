# linewatch/web — Agent Instructions

The dashboard is a **basalt-ui** app (Mantine v9 + TanStack Charts). The guard rules below
are this repo's; the page and its store are in [`src/routes/AGENTS.md`](src/routes/AGENTS.md),
the charts in [`src/charts/AGENTS.md`](src/charts/AGENTS.md).

## The dashboard runs on basalt-ui, and the guards are the contract

The stack, the token rule, the local-bin rule and the rule precedence are stated once, in the
managed block below — this section holds only what is specific to this repo. The enforcement
layer was inert for most of this project's life (no `init`, no lint, no hook, no CI) and the
dashboard grew **two card idioms** before anything could say they disagreed; the guards below
exist so that cannot happen silently again.

- **`cd web && bun run lint` is the gate** — `oxlint . && basalt-ui check-theme`.
  It runs pre-commit (root `lefthook.yml`) and in CI (`.github/workflows/check.yml`).
  Both configs live at the **repo root**, not in `web/`: `basalt-ui init` seeds them
  into the package directory, which is a directory neither GitHub nor lefthook reads.
- **No shade-pinned Mantine colours** (`c="yellow.7"` is one fixed swatch in both
  schemes, so a step legible on dark is the one that fails contrast on light) — use
  `VX.status.*` or a bare hue.
- **One card idiom: bare `<Card>` (the theme owns the 12/16 inset; `basalt/card-inset` rejects `p`/`px`/`py`).** Never `withBorder` — card depth is
  `--vx-shadow-card`, which already bakes a 1px ring into the shadow, so `withBorder`
  draws a second real edge on top of it. Never an explicit `radius` or `padding`; the
  theme pins both.
- **Reach for the shipped prop before wrapping a shipped component.** `StatCard.tone`
  draws the threshold rail this repo used to hand-roll as a 35-line positioned `Box`
  — and adds the `VisuallyHidden` label the hand-rolled one never had, so the verdict
  was colour-only. A wrapper around a design-system component is how the second idiom
  starts.
- **`components/status-bar.tsx` is the one standing deviation from the one-card-idiom
  rule.** `StatCard` cannot render its own header at bar density (six cells, ~230px
  each), so its cells are hand-rolled — but they still reproduce `StatCard.tone`'s 3px
  rail, its `VisuallyHidden` threshold sentence and a `WidgetHeader tier="widget"` label
  per cell, pinned by `status-bar.render.test.tsx`. The bar is still one card; the
  deviation is the cell markup, never the accessible surface. History:
  [`docs/dashboard-charts.md`](../docs/dashboard-charts.md).
- **After a `basalt-ui` upgrade, run `./node_modules/.bin/basalt-ui sync`** — `sync --check`
  gates the drift in CI and pre-commit. The hook and the workflow both call the local bin
  (never `bunx`, see the managed block below). Since 1.23.0 the CLI also resolves the package from
  the **repo root**, so `./web/node_modules/.bin/basalt-ui doctor` from the git root answers
  for `web/`.
- **`web/DESIGN.md` is this app's thin delta** on the managed `web/.claude/rules/basalt-*.md`
  (its series dictionary and any deliberate deviation) — it is **not**
  [`docs/DESIGN.md`](../docs/DESIGN.md), which is the collector and data design and has nothing
  to do with the visual system.
- **A guard finding is fixed at the source, not silenced.** `theme-allow <rule-id> —
  <reason>` waives that node/line only; `theme-allow-file <rule-id> — <reason>`
  waives the whole file. A bare comment waives everything but reports
  `theme-allow-unscoped`; a typo in the id slot waives **nothing** (fails closed).
  The annotation must **start** its comment and reaches the first **code** line
  below it — inside `{cond && (…)}` that means `//`, since `{/* */}` there is a
  syntax error. Nothing here uses `theme-allow-file`; every waiver is node-scoped.
  `./node_modules/.bin/basalt-ui check-theme --audit-allows` exits 1 on a dead waiver.
- **The dashboard's `<head>` is `basaltAppPlugin`'s, not `index.html`'s.**
  `basaltAppPlugin` (`web/vite.config.ts`) resolves `theme-color` from `SURFACE.bg`
  so it tracks a retune; `manifest` stays off (tailnet dashboard) and the one icon is
  `web/public/favicon.svg`, named in `icons` with `rel: 'icon'` so the plugin owns the `<link>` —
  the browser then never asks for `/favicon.ico`, which the server correctly 404s (a bare `curl` still sees 404). `check-theme` reads `index.html` as of 1.20.0, so a hex put back
  there fails the build.
- **The dashboard's fetch layer has a single `USE_MOCK` switch.** Keep it working;
  it is how the UI is developed before real data accumulates. **The mock must not
  be more generous than the API** — it once returned a `title` on every verdict
  that the server has never sent, so the whole verdict band shipped with empty
  headlines and the client's own type said the field was required.

## Design system — read DESIGN.md

Before UI work, read [`DESIGN.md`](DESIGN.md) — this app's delta on the shipped
`basalt-*` rules in `.claude/rules/`. The basalt-ui managed block (stack, token rule,
local-bin rule, precedence) sits at the end of this file, written by `basalt-ui sync`.

<!-- basalt:begin 2.29.0 -->

## basalt-ui (managed — do not hand-edit)

Placed by `basalt-ui init`, refreshed by `basalt-ui sync` (`--check` gates drift in CI); edit `DESIGN.md`, not this block.

**Stack:** React 19 + Mantine v9 via `basalt-ui` (`BasaltProvider`, `BasaltShell`), TanStack Router and
Query, TanStack Charts via `basalt-ui/charts`, Bun, oxlint + oxfmt, no Tailwind. Color is `VX.*` or a
series token, never a literal.

**Precedence** (highest wins): consumer `DESIGN.md` > the six shipped `basalt-*` rules in
`.claude/rules/` > the `basalt-*` skills. Each rule bullet ends in the lint rule, guard kind or type
that enforces it; skills are procedure, not law.

**Run the local bin** (`./node_modules/.bin/basalt-ui` or a package script), never `bunx`; `init` is
the one exception. In a workspace: the app package's `node_modules/.bin/basalt-ui`.

**Before guessing an import, read the installed `llms.txt`** at the install directory (in a workspace,
under the depending package; `basalt-ui doctor` prints where; a fresh worktree needs `bun install` first).

**Skills and subagent** (installed in `.claude/`; invoke by name):

- `/basalt-app`: scaffold, wire, upgrade or verify the app (`init`, `doctor`, `sync`).
- `/basalt-design`: build or restyle a screen — scenario, `basalt-ui shot` rounds, review, revise; routes to its `references/` on demand.
- `/basalt-charts`: add or extend a chart, register its series colors.
- `basalt-design-reviewer` (subagent): scores a `basalt-ui shot` out dir per component; run it after every shot round, never on your own work.

@./DESIGN.md

**Restraint override (supersedes `/frontend-design`).** This is a calm, data-dense professional
surface: no "bold aesthetic direction", gradient meshes, grain or dramatic motion. Neutral by default,
the single accent spent only when earned.

**Chart override.** `/basalt-design`, `/basalt-charts` and the `basalt-charts` rule supersede any global chart rule and
the bundled `/dataviz` skill (its palette, marks, forms yield to basalt's tokens, catalogue, guards): compose `CartesianChart`.

<!-- basalt:end -->

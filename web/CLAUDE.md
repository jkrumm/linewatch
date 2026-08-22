<!-- basalt:begin 1.24.0 -->

## basalt-ui (managed — do not hand-edit)

Scaffolded by `bunx basalt-ui init` (the one command that legitimately predates the install) and
refreshed by the locally installed `basalt-ui sync` after every upgrade; `basalt-ui sync --check`
gates drift in CI. This block is framework-owned — edit `DESIGN.md`
or the `basalt-*` rules instead; manual changes here are overwritten on the next sync.

**Stack:** React 19 + Mantine v9, themed by `basalt-ui` (`BasaltProvider` + `createBasaltTheme`).
Colors come from the three-tier `--vx-*` token system — read `VX.*` / a `defineSeries` token,
never a raw hex/`rgb()`/`hsl()`. Charts are visx via `basalt-ui/charts`: every single-plot chart
composes `CartesianChart` (owns margins, scales, axes, grid, cursor, tooltip — draw only marks);
legends/tooltip rows are DERIVED from `series`, never hand-authored (`basalt/hand-rolled-plot` +
`basalt/chart-legend-literal` enforce both); `DualPanel`/`BandStrip`/`MirroredBars` declare
themselves exceptions, and `Donut`/`Heatmap` render no plot-assembly element so the rule never
fires on them. Add a kind on the third repeat, don't loosen the primitives. `basalt-ui/charts` and
`basalt-ui/tokens` are Mantine-free internally (a framework invariant, not something your own app
code must follow) — never import `@visx/*` outside a `charts/` directory (oxlint-enforced).
Toolchain is oxlint + oxfmt (no ESLint/Biome/Prettier) and `basalt-ui check-theme` guards the
palette. Runtime is Bun.

**Before guessing an import, read the installed package's machine docs — `llms.txt` (per-subpath
import map) and `AGENTS.md`, at the install directory.** That is `./node_modules/basalt-ui` only on
a single-package app. In a workspace, basalt resolves under the package that depends on it
(`packages/<name>/node_modules/basalt-ui`), and the repo root may have no copy at all. Run
`basalt-ui doctor` — its `basalt-resolves` line prints the resolved install dir and version; read
the two files there. Invoke the CLI through the **locally installed** bin (the `lint:basalt` script
seeded by `init` shows the path); `bunx basalt-ui` fetches a second copy from npm and can answer
for a different version than the one you are building against.

**DESIGN.md is law.** `./DESIGN.md` (imported below) records this app's palette identity and series
dictionary. Precedence: **DESIGN.md > `basalt-*` rules > skills.** When building or restyling any
UI, that law wins over habit, over library defaults, and over a skill's instinct. The design/charts
workflows are the managed skills in `.claude/skills/` (`/basalt-design`, `/basalt-charts`) — they
defer to DESIGN.md.

@./DESIGN.md

**Restraint override (supersedes `/frontend-design`).** This app is a calm, data-dense,
dark-first professional surface — not a showcase. Ignore `/frontend-design`'s push toward a "BOLD
aesthetic direction", gradient meshes, noise/grain, and dramatic motion. Here: the shipped
three-font system (Nunito Sans body, Hubot Sans condensed headings, JetBrains Mono for every
numeral/micro-label), depth via a whisper shadow + 1px ring (`shadow-card` on panels,
`shadow-raised` on controls — never a decorative drop shadow, never a hover lift), neutral
zinc-by-default with the single saturated accent spent only when earned (trend /
signal / categorical separation). Restraint **is** the identity.

<!-- basalt:end -->

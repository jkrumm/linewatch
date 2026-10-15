# linewatch/web — Agent Instructions

The dashboard is a **basalt-ui** app (Mantine v9 + visx). The repo-specific guard rules
live in the root [`AGENTS.md`](../AGENTS.md) ("The dashboard runs on basalt-ui").

## Design system — read DESIGN.md

Before UI work, read [`DESIGN.md`](DESIGN.md) — this app's delta on the shipped
`basalt-*` rules in `.claude/rules/`. The basalt-ui managed block (stack, token rule,
local-bin rule, precedence) sits at the end of this file, written by `basalt-ui sync`.

<!-- basalt:begin 2.9.1 -->

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

@./DESIGN.md

**Restraint override (supersedes `/frontend-design`).** This is a calm, data-dense professional
surface: no "bold aesthetic direction", gradient meshes, grain or dramatic motion. Neutral by default,
the single accent spent only when earned.

**Chart override.** The `basalt-charts` rule supersedes any global visx or chart rule: compose
`CartesianChart`.

<!-- basalt:end -->

<!-- basalt:begin 1.27.0 -->

## basalt-ui (managed — do not hand-edit)

Placed by `bunx basalt-ui init` and refreshed by `basalt-ui sync` after every upgrade
(`sync --check` gates drift in CI). Framework-owned: edit `DESIGN.md` or your own files instead —
changes here are overwritten on the next sync.

**Stack:** React 19 + Mantine v9, themed by `basalt-ui` (`BasaltProvider` + `createBasaltTheme`), Bun
runtime, oxlint + oxfmt (no ESLint/Biome/Prettier), no Tailwind. Color comes from the three-tier
`--vx-*` token system — read `VX.*` or a series token, never a raw hex/`rgb()`/`hsl()`. Charts are
visx via `basalt-ui/charts`. `basalt-ui check-theme` plus the `basalt/*` oxlint rules are the teeth.

**Precedence — the only statement of it.** Highest wins; a lower layer fills gaps and never
overrides a higher one:

> consumer `DESIGN.md` (app deltas) > the six shipped `basalt-*` rules > the `basalt-*` skills

**All six rules are law** — `basalt-tokens`, `basalt-mantine`, `basalt-charts`, `basalt-state`,
`basalt-controls`, `basalt-batteries` in `.claude/rules/`, each carrying a generated
`<!-- basalt:coverage -->` header naming what enforces it and what is only advisory. The skills
(`/basalt-app`, `/basalt-design`, `/basalt-charts`) are the METHOD that obeys them, never law.

**Run the LOCAL bin, not `bunx`** — `./node_modules/.bin/basalt-ui`, or a `package.json` script.
`bunx` does not re-resolve a cached package, so it can answer for a version you upgraded away from;
`init` is the one legitimate `bunx` invocation, because nothing is installed yet.

**Before guessing an import, read the installed package's machine docs** — `llms.txt` (per-subpath
import map) and `AGENTS.md`, at the install directory. In a workspace that is under the package that
depends on basalt, not the repo root; `basalt-ui doctor`'s `basalt-resolves` line prints where.

@./DESIGN.md

**Restraint override (supersedes `/frontend-design`).** This app is a calm, data-dense professional
surface, not a showcase. Ignore the push toward a "BOLD aesthetic direction", gradient meshes,
noise/grain and dramatic motion. Here: the shipped three-font system, depth from a whisper shadow
with a 1px ring, neutral-by-default with the single accent spent only when earned — trend, signal,
or genuine categorical separation. Restraint **is** the identity.

<!-- basalt:end -->

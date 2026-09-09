<!-- basalt:begin 1.29.2 -->

## basalt-ui (managed — do not hand-edit)

Placed by `bunx basalt-ui init`, refreshed by `basalt-ui sync` (`sync --check` gates drift in CI).
Framework-owned: edit `DESIGN.md` or your own files — this block is overwritten on the next sync.

**Stack:** React 19 + Mantine v9 themed by `basalt-ui` (`BasaltProvider` + `createBasaltTheme`), Bun,
oxlint + oxfmt (no ESLint/Biome/Prettier), no Tailwind. Color is the three-tier `--vx-*` token system —
`VX.*` or a series token, never a raw hex. Charts are visx via `basalt-ui/charts`; `check-theme` + the
`basalt/*` oxlint rules are the teeth.

**Precedence — the only statement of it.** Highest wins; a lower layer fills gaps and never
overrides a higher one:

> consumer `DESIGN.md` (app deltas) > the six shipped `basalt-*` rules > the `basalt-*` skills

**All six rules are law** — `basalt-{tokens,mantine,charts,state,controls,batteries}` in
`.claude/rules/`, each with a generated `<!-- basalt:coverage -->` header naming what enforces it and
what is only advisory. The skills (`/basalt-app`, `/basalt-design`, `/basalt-charts`) are METHOD, never law.

**Run the LOCAL bin, not `bunx`** — `./node_modules/.bin/basalt-ui`, or a `package.json` script.
`bunx` does not re-resolve a cached package, so it can answer for a version you upgraded away from;
`init` is the one legitimate `bunx` invocation, because nothing is installed yet.

**Before guessing an import, read the installed package's `llms.txt` and `AGENTS.md`** — at the
install directory (in a workspace, under the depending package; `basalt-ui doctor` prints where).

@./DESIGN.md

**Restraint override (supersedes `/frontend-design`).** This app is a calm, data-dense professional
surface, not a showcase. Ignore the push toward a "BOLD aesthetic direction", gradient meshes,
noise/grain and dramatic motion. Here: the shipped three-font system, depth from a whisper shadow
with a 1px ring, neutral-by-default with the single accent spent only when earned — trend, signal,
or genuine categorical separation. Restraint **is** the identity.

**Chart-doctrine override.** A global `visx-charts` rule auto-loading on `**/charts/**` is generic
non-basalt discipline; here `basalt-charts` supersedes it — compose `CartesianChart`.

<!-- basalt:end -->

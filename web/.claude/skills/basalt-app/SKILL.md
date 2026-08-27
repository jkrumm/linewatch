---
name: basalt-app
description: Scaffold or refresh a basalt-ui app — the procedure around `basalt-ui init` (first-time scaffold) and `basalt-ui sync` (drift-managed refresh), plus the runtime wiring neither of them does for you (provider, shell, vite, CSS order). Use when setting up basalt-ui in a new or existing app, after upgrading it, or when the shipped doctrine seems missing.
when_to_use: User is adding basalt-ui to a new or existing app, asks how to set it up or scaffold it, wants to wire BasaltProvider / BasaltShell / the vite preset, refresh the shipped rules after an upgrade, or wire a freshness check in CI. Also when /basalt-design reports no consumer DESIGN.md.
---

`/basalt-app` gets a consumer scaffolded and keeps its shipped doctrine fresh. Everything — the
components, the toolchain presets, the rules, the skills, the templates — ships in the one npm
package; `init` places it and `sync` refreshes it.

## 1. Install and scaffold

```bash
bun add basalt-ui
bunx basalt-ui init                        # the ONE command that legitimately predates the install
./node_modules/.bin/basalt-ui --version    # every command after it: the LOCAL bin
```

`init` writes the managed doctrine (`.claude/rules/basalt-*.md`, `.claude/skills/basalt-*/SKILL.md`,
the `CLAUDE.md` block), the seeds you then own (`DESIGN.md`, `.oxlintrc.json`, `.oxfmtrc.json`,
`lefthook.yml`, CI, optional scaffolds), and `.basalt/manifest.json` — a sha256 per managed unit so
`sync` can three-way diff. It also patches `basalt.roots` and a `lint:basalt` script.

Two modes, decided by one question — **does Claude read this file?** Managed files are
framework-owned and meant to be overwritten (the sync diff is the review gate); seeds are written
once and yours forever. Claude Code cannot load rules or skills out of `node_modules`, which is the
only reason anything is copied at all; everything a MACHINE reads is an `extends` reference into
`node_modules/basalt-ui/configs/`, so the toolchain auto-updates with the package.

**`init` on an existing app is a lint-debt event, not a no-op** — read
`.claude/rules/basalt-batteries.md` § "App bootstrapping" for what it turns on and what keeping your
own `.oxlintrc.json` costs.

## 2. Wire the runtime (the CLI scaffolds files, not your app's composition)

```tsx
// main.tsx — CSS order is load-bearing: every @mantine/*/styles.layer.css, THEN basalt's
import '@mantine/core/styles.layer.css'
import 'basalt-ui/styles.css'
import { BasaltProvider, createBasaltTheme } from 'basalt-ui'
import { BasaltOverlays } from 'basalt-ui/commands'
;<BasaltProvider theme={createBasaltTheme(/* app deltas only */)} defaultColorScheme="dark">
  <BasaltOverlays>{/* data layer, then the router */}</BasaltOverlays>
</BasaltProvider>
```

```ts
// vite.config.ts — the preset is config-only; the plugin half is spread into your own plugins
export default defineConfig({
  ...basaltViteConfig({ port: 5173, apiTarget: 'http://localhost:3000' }),
  plugins: [react(), ...basaltAppPlugin({ name: 'MyApp', description: '…' })],
})
```

Then `BasaltShell` with a `useNav(NAV)` spread (basalt-state.md), `PageBar` per page
(basalt-controls.md), and `<first basalt.root>/lib/series.ts` as the app's one guard-exempt series
source (`/basalt-charts`). There is no Tailwind.

## 3. Verify the wiring took

```bash
./node_modules/.bin/basalt-ui doctor      # read it to the LAST line
bun run lint:basalt                       # oxlint . && basalt-ui check-theme
```

`SKIPPED` is a third outcome beside pass/warn/fail and **exits non-zero on its own** — a check that
could not run is not a check that passed. Expect doctor to go red where an older basalt was green;
that is the point. Then triage `oxlint .` before the next commit.

## 4. Refresh after every upgrade

```bash
./node_modules/.bin/basalt-ui sync        # --check in CI, --force to overwrite local edits
```

- Unchanged since basalt wrote it → overwritten. Locally edited → diffed and SKIPPED. Missing →
  recreated. **Retired upstream → deleted**, and named in the output; a rule file basalt stopped
  shipping is doctrine your agent would otherwise keep reading.
- `sync --check` makes no writes and exits non-zero on any of that — wire it as the freshness gate.
- Run it anywhere in the repo: it resolves the project the way `check-theme` and `doctor` do,
  announces a relocation, refreshes a PARENT install from a sub-package, and still refuses to
  scaffold a second consumer (that stays `init`'s decision).
- Seeds are never reconciled or reported. They are yours.

## 5. Not a React app?

```bash
bunx basalt-ui tokens:css --out src/tokens.css   # no install to resolve, so bunx is right here
bunx basalt-ui fonts:css --out src/fonts.css
```

Both carry the two-line `@generated basalt-ui` header the guard skips, and both take `--check` as a
CI drift gate that ignores the provenance version — so a basalt bump alone never forces a no-op
commit. Declare `"basalt": { "profile": "tokens-only" }` by hand; `check-theme` never infers it.

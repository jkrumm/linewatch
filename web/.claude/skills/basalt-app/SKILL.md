---
name: basalt-app
description: Scaffold or refresh a basalt-ui app — guided wrapper around 'basalt-ui init' (first-time scaffold) and 'basalt-ui sync' (drift-managed refresh). The whole agentic layer ships in the npm package — init places the skills, rules, CLAUDE block, and DESIGN.md; sync keeps the managed half fresh. Use when setting up basalt-ui in a new/existing app, wiring the provider/shell/vite preset, or when the doctrine feels missing.
when_to_use: User is adding basalt-ui to a new or existing app, asks how to set it up / scaffold it, wants to wire BasaltProvider / BasaltShell / the vite preset, refresh the shipped rules and DESIGN.md, or run a freshness check in CI. Also when /basalt-design reports no consumer DESIGN.md (the app isn't scaffolded yet).
---

`/basalt-app` scaffolds a basalt-ui consumer and keeps its shipped doctrine fresh. It wraps the two
CLI subcommands — `basalt-ui init` (first run) and `basalt-ui sync` (refresh) — and explains the
wiring they don't do for you (provider, shell, vite). All of it via `bunx basalt-ui` (Bun runtime).

## One package, one command, one version

Everything ships in the `basalt-ui` npm package — components, toolchain presets, rules, skills,
templates. Becoming a consumer is exactly two steps:

```
bun add basalt-ui
bunx basalt-ui init
```

There is no plugin and no marketplace. `init`/`sync` place every file with one of two modes, and
which mode a file gets answers a single question — **does Claude read it?**

| Mode        | Files                                                                                                             | Lifecycle                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **managed** | `.claude/rules/basalt-*.md`, `.claude/skills/basalt-*/SKILL.md`, the `CLAUDE.md` block                            | basalt owns it; `sync` refreshes it; a local edit is skipped and reported (`--force` overwrites); the sync diff is the review gate |
| **seed**    | `DESIGN.md`, `.oxlintrc.json`, `.oxfmtrc.json`, `lefthook.yml`, `.github/workflows/check.yml`, optional scaffolds | written once, then yours forever; `sync` recreates it only when missing and never reports it                                       |

Claude Code cannot load rules or skills from `node_modules` — that platform limit is the only
reason anything is copied. Everything a machine reads is a **reference** instead: the seeded
`.oxlintrc.json` and `lefthook.yml` just `extends` the presets inside
`node_modules/basalt-ui/configs/`, so the toolchain auto-updates with the package while you still
own the files.

## First-time scaffold: `bunx basalt-ui init`

`init` writes the repo-side doctrine and toolchain into a consumer (monorepo globs supported):

- `.claude/rules/basalt-*.md` — the thirteen shipped rules (`basalt-tokens`, `basalt-charts`,
  `basalt-mantine`, `basalt-router`, `basalt-query`, `basalt-state`, `basalt-forms`,
  `basalt-notifications`, `basalt-commands`, `basalt-data`, `basalt-agent`, `basalt-content`,
  `basalt-app`), managed verbatim.
- `.claude/skills/basalt-{app,charts,design}/SKILL.md` — the three skills (`/basalt-app`,
  `/basalt-charts`, `/basalt-design`), managed verbatim, same path the rules take.
- A managed `<!-- basalt:begin --> ... <!-- basalt:end -->` block in `CLAUDE.md`: stack facts, the
  **DESIGN.md-is-law** pointer, and the **frontend-design restraint override** (in a dashboard, the
  bold move is calm — defer to `/basalt-design`, not generic "make it striking" instincts).
- A **thin** `DESIGN.md` seed (deltas only on top of the `basalt-*` rules): identity confirmation,
  the series dictionary, app deviations. The CLAUDE block `@`-imports it, so it auto-loads.
- Toolchain seeds: `.oxlintrc.json` and `lefthook.yml` are `extends` stubs pointing into
  `node_modules/basalt-ui/configs/`; `.oxfmtrc.json` is a starting copy (oxfmt has no `extends`);
  `.github/workflows/check.yml` is a starting workflow. All four are yours after the first write.
- `.basalt/manifest.json` — a sha256 per managed file + the basalt-ui version that wrote it, so
  `sync` can three-way diff and `doctor` can spot a stale install.

After `init`, do the runtime wiring (the CLI scaffolds files, not your app's composition):

```tsx
// Provider — wraps MantineProvider, injects the --vx-* palette, bridges the Vx tokens
import { BasaltProvider } from 'basalt-ui'
;<BasaltProvider>{/* app */}</BasaltProvider>

// Shell — sidebar / mobile-nav / breadcrumbs / page-header; router-agnostic
import { BasaltShell, NavCountBadge, ThemeToggle } from 'basalt-ui'
// <ThemeToggle /> in globalActions — cycles light/dark/system on click, hover/focus reveals
// a direct-select popover. Animated (motion) sun/moon glyph, never a computer/monitor icon.

// Theme — start from the base, override deltas only
import { createBasaltTheme } from 'basalt-ui'
const theme = createBasaltTheme({
  /* app deltas */
})
```

```ts
// vite.config.ts — basaltViteConfig (dedupe react + @mantine/*, strictPort, /api proxy,
// BASALT_LOCAL alias) composed with basaltAppPlugin (PWA head, manifest, icon metadata)
import react from '@vitejs/plugin-react'
import { basaltAppPlugin, basaltViteConfig } from 'basalt-ui/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  ...basaltViteConfig({ port: 5173, apiTarget: 'http://localhost:3000' }),
  plugins: [react(), ...basaltAppPlugin({ name: 'MyApp', description: '…' })],
})
```

`basaltViteConfig` stays config-only (no `plugins`) by contract; `basaltAppPlugin` is the plugin
half — spread it into your own `plugins` array. See `agent/rules/basalt-app.md` for plugin
ordering (e.g. alongside `@content-collections/vite`) and the full head/PWA/manifest surface.

```js
// Tailwind era is over — there is no Tailwind. Styles come from:
import 'basalt-ui/styles.css' // @layer basalt base styles, iOS input safety net, font stack
```

Lint wires as `oxlint . && basalt-ui check-theme` — the theme guard is the teeth behind the token
doctrine. The consumer series file (`<first basalt.root>/lib/series.ts` by default — so `src/lib/series.ts`
on a plain app, `apps/web/src/lib/series.ts` on a monorepo; override via `basalt.seriesModulePath`) is the
single guard-exempt palette source — see `/basalt-charts`.

## Refresh: `bunx basalt-ui sync`

`sync` re-applies shipped doctrine after a basalt-ui upgrade, three-way against
`.basalt/manifest.json`:

- **Unchanged since last write** → overwrite with the new version.
- **Locally edited** → show a diff and **skip** (preserves your edits) unless `--force`.
- **Missing** → recreate.
- `sync --check` makes no changes and exits non-zero on drift — wire it as a CI freshness gate so a
  consumer can't silently fall behind the shipped rules.

Seeds (`DESIGN.md`, the toolchain files, the scaffolds) are never reconciled or drift-reported —
they are yours. The managed files (rules, skills, the CLAUDE block) are framework-owned and meant
to be overwritten; the sync diff is where you review a doctrine change before committing it.

## Precedence the scaffold establishes

After scaffolding, the doctrine resolves in this order (highest wins):

> consumer `DESIGN.md` (deltas) > shipped `basalt-*` rules > skills

So an app deviation goes in `DESIGN.md`; the universal law and its enforcement live in the
`basalt-*` rules; and the skills (`/basalt-design`, `/basalt-charts`) are the method that obeys
both.

## Checklist

- Ran `bun add basalt-ui && bunx basalt-ui init` — rules, skills, CLAUDE block, DESIGN.md all
  present from the one package.
- `BasaltProvider` wraps the app; `createBasaltTheme` used for theme deltas; `basalt-ui/styles.css`
  imported.
- `basaltViteConfig` adopted; `oxlint . && basalt-ui check-theme` is the lint command.
- `basaltAppPlugin` composed into `plugins` (see the vite.config.ts snippet above); icon files
  (`favicon.ico`, `favicon.svg`, `favicon-96x96.png`, `apple-touch-icon.png`,
  `web-app-manifest-192x192.png`, `web-app-manifest-512x512.png`) generated and placed under
  `public/` — `basalt-ui doctor` warns if any are missing.
- `site.webmanifest` is emitted by `basaltAppPlugin` — no manual manifest file needed unless
  `manifest: false` was passed.
- A thin `DESIGN.md` (deltas) + the thirteen `basalt-*` rules + the managed CLAUDE block are present.
- `<first basalt.root>/lib/series.ts` exists as the one guard-exempt series source (for any app metric colors).
- `basalt-ui sync --check` wired in CI (recommended) to catch drift on future upgrades.

## Notes

- `init`, `sync`, and `check-theme` are all **real**. `sync` reconciles via a sha256 three-way diff
  (`--check` is a CI drift gate, `--force` overwrites local edits); `check-theme` is the palette
  guard; `doctor` verifies the installed basalt-ui version against the manifest. All via
  `bunx basalt-ui …`.
- The framework ships **no** icon or notification dep — pass icons as `ReactNode` and wire toasts
  yourself (e.g. `ThemeLabControls`' `copyIcon` / `onCopy`).
- The framework DOES ship `motion` (motion.dev, formerly framer-motion) as a bundled dependency —
  animated chrome (`ThemeToggle` today) comes for free, no consumer dependency needed. Reach for
  the shared `MOTION_DURATION` / `MOTION_SPRING` tokens for any new animated interaction rather
  than inventing ad hoc durations/easings or a competing animation library.
- `vite-plugin-pwa` (`^1.3.0`) is an OPTIONAL peer, only needed when `basaltAppPlugin`'s
  `serviceWorker` option is truthy — omit it entirely for apps that don't want an installable/
  offline-capable app. See `agent/rules/basalt-app.md` for the full head/PWA/manifest/icons
  surface `basaltAppPlugin` owns.

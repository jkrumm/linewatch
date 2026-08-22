---
source: basalt-ui
description: App bootstrapping for basalt-ui consumers — composing basaltViteConfig + basaltAppPlugin in vite.config.ts, plugin ordering, the required Mantine CSS layer order, and the PWA/favicon/manifest surface (bring-your-own icons, opt-in serviceWorker).
paths:
  - 'vite.config.ts'
  - 'apps/**/vite.config.ts'
  - 'index.html'
  - 'apps/**/index.html'
  - 'src/main.tsx'
  - 'apps/**/src/main.tsx'
---

# Basalt App — Bootstrapping & Vite Config

`basalt-ui/vite` ships two entry points with a deliberate split: `basaltViteConfig` is **config
only**, `basaltAppPlugin` is the **plugin** half. This rule covers composing them, where
`basaltAppPlugin` sits relative to other plugins, and the head/PWA/manifest surface it generates.

## Composing the vite config

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { basaltAppPlugin, basaltViteConfig } from 'basalt-ui/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  ...basaltViteConfig({ port: 5173, apiTarget: 'http://localhost:3000' }),
  plugins: [react(), ...basaltAppPlugin({ name: 'MyApp', description: '…' })],
})
```

`basaltAppPlugin(opts)` returns `PluginOption[]` (a Vite plugin array, not a single plugin) — spread
it into your own `plugins` array with `...basaltAppPlugin({...})`, same as any other Vite plugin
that ships more than one plugin instance.

`basaltViteConfig` **never returns `plugins`** and never will — it stays config-only by contract.
Plugins carry app-specific concerns (router codegen, PWA, `react-compiler` babel options) that don't
belong in a shared, app-agnostic spine; keeping them out of `basaltViteConfig` means adopting the
preset never silently injects a plugin you didn't ask for, and `basaltAppPlugin` can be adopted (or
skipped) independently of the rest of the preset.

## Plugin ordering

`basaltAppPlugin`'s hooks (`transformIndexHtml`, `generateBundle`, `configureServer`) don't
generate a virtual module another plugin resolves against — unlike
`@content-collections/vite`, whose plugin-ordering rule (agent/rules/basalt-content.md) requires
`contentCollections()` to run FIRST because it generates the virtual `content-collections` module
other plugins/transforms may depend on. `basaltAppPlugin` has no equivalent requirement, so when
composing both:

```ts
plugins: [
  contentCollections(), // FIRST — see basalt-content.md
  react(), // or tanstackStart()
  ...basaltAppPlugin({ name: 'MyApp' }), // position is free — see below
]
```

Position is a readability convention here, not a correctness requirement — including with
`serviceWorker` enabled. `vite-plugin-pwa` expands to five plugins that **self-order** via
`enforce` (`vite-plugin-pwa` is `enforce: 'pre'`; `:build`, `:info` and `:pwa-assets` are
`enforce: 'post'`), and Vite sorts by `enforce` before array position. Its precache manifest is
built in `closeBundle`, where `workbox-build` globs the **output directory on disk** — every other
plugin's transforms and emits have already landed there. So no ordering relationship exists between
`basaltAppPlugin` and `react()`/`tanstackStart()`.

The one real caveat is a plugin that **emits files from its own `closeBundle`**: if it runs after
`vite-plugin-pwa`'s, those files are written too late to be precached (the `rollup-plugin-copy`
class of bug). `vite-plugin-pwa` exposes `integration.closeBundleOrder` to sequence against it.

## What `basalt-ui init` writes into `package.json`

`init` is not only a file-scaffolder. It also patches two keys, and on an existing app it is a
**lint-debt event, not a no-op** — the shipped preset switches on whole oxlint plugins the repo was
never linted against, so previously-clean code lands with real findings on the first run. `init`
prints the plugin list; run `oxlint .` and triage it before your next commit rather than
blanket-disabling a plugin.

- **`basalt.roots`** — inferred from the real layout (workspace packages depending on basalt or
  Mantine, else every workspace `src/`, else `src`). Everything derives from it: `check-theme`'s
  scan, the seeded CI `oxfmt` globs, the default scan exemption. Correct it if your sources live
  elsewhere; without it a workspace repo scaffolds a guard that scans zero files.
- **`scripts["lint:basalt"]`** — `oxlint . && basalt-ui check-theme`. Previously the docs told you
  to wire this and nothing wrote it.
- **`basalt.profile: 'tokens-only'`** — for a consumer on the `--vx-*` layer with no Mantine. It
  must be DECLARED (or passed as `--tokens-only`); `check-theme` deliberately never infers it,
  because inferring from a missing `@mantine/core` would silence 17 kinds on any repo that keeps
  Mantine in a different workspace package. `doctor` does infer it, because its profile only changes
  which ADVICE it prints and never what it enforces — and it names the key to write down.

`init` keeps an existing `.oxlintrc.json` rather than clobbering it, and now names what keeping it
costs (the whole basalt lint half stays off). `--merge-lint` splices the preset's `extends` in; it
refuses on a commented config rather than deleting the comments.

Run `basalt-ui doctor` afterwards to confirm the wiring took. A check that cannot RUN is reported as
`SKIPPED` and exits non-zero on its own — "All checks passed" is only printable when every check ran.

## `index.html` and `public/` are scanned

`check-theme` resolves `.html` / `.webmanifest` / `.json` as markup (colour kinds only), and each
`basalt.roots` entry's PARENT contributes its `index.html` and its `public/` tree — exactly the Vite
layout above. So a raw hex in a `theme-color` meta or a webmanifest's `background_color` is a
finding now; those are the two colours nothing re-derives on a scheme change. Nothing else in the
parent is walked, and `.json` is never blanket-scanned — name one in `basalt.include`.

## `__APP_VERSION__`

`basaltViteConfig` injects the `__APP_VERSION__` define, and since 1.20.0 ships the ambient
declaration with it (`src/register.ts` → `dist/register.d.ts`, re-exported by the root barrel). An
app that imports anything from `basalt-ui` has it in scope — delete your hand-written ambient block
and its `oxlint-disable`. A subpath-only consumer does not get it, which is the same set as the
consumers not on this Vite preset anyway.

## CSS layer order (Mantine)

`basalt-ui/styles.css` must load AFTER every `@mantine/*/styles.layer.css` bundle — the layered
bundles order `@layer mantine, basalt` so basalt's rules (including the iOS 16px input floor) win;
an unlayered Mantine import outranks `@layer basalt` regardless of specificity. In `main.tsx`:

```ts
import '@mantine/core/styles.layer.css'
// ...other @mantine/*/styles.layer.css bundles for any batteries you install
import 'basalt-ui/styles.css'
```

## Head, manifest, and icons — bring your own

`basaltAppPlugin` injects dual `theme-color` tags (light/dark media queries) and an anti-FOUC inline
`<style>` background, both resolved from the `SURFACE.bg` token — never hand-compute these hexes,
they track the palette automatically. It also injects the `apple-mobile-web-app-*` /
`mobile-web-app-capable` meta set, a `darkreader-lock` meta (default on), a viewport tag with
`viewport-fit=cover` (skipped when the consumer's own `index.html` already declares one), and
site-wide OG/Twitter defaults from `options.seo`.

Icons are **bring-your-own** — basalt-ui takes no `sharp`/image-processing dependency. The plugin
expects these filenames under `public/` (or `icons.dir` if customized):

```text
favicon.ico
favicon.svg
favicon-96x96.png
apple-touch-icon.png
web-app-manifest-192x192.png
web-app-manifest-512x512.png
```

Generate the set with `@vite-pwa/assets-generator` (or realfavicongenerator.net) from a single
source image — it lives in the CONSUMER's own devDependencies, not basalt-ui's. `basalt-ui doctor`
warns (does not fail) when `public/` exists but is missing one of these files.

`basaltAppPlugin` also emits `site.webmanifest` (served in dev too) with explicit `id`/`scope`/
`start_url` — pass `manifest: false` to skip it, or `icons: false` to skip the icon `<link>` tags
without touching the manifest.

## Service worker (opt-in)

`serviceWorker` defaults to `false` — no service worker unless you ask for it. `true` composes the
optional peer `vite-plugin-pwa` with argo-derived workbox defaults (`autoUpdate` registration,
`cleanupOutdatedCaches`, a `/index.html` navigate fallback that denies `/api/*`); pass an object to
deep-merge overrides on top. When the peer (plus its own peers `workbox-build`/`workbox-window`) is
not installed, the plugin degrades to a one-line console warning — no service worker, no throw:

```bash
bun add -D vite-plugin-pwa workbox-build workbox-window
```

`basaltAppPlugin` always emits its own `site.webmanifest` — `serviceWorker`'s `manifest: false` is
baked into the defaults so `vite-plugin-pwa` never emits a competing one.

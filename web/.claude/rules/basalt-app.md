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

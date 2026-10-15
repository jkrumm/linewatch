---
source: basalt-ui
description: Where state lives — search stores over typed fields, nav links by reference, defineNav, persisted state.
paths:
  - 'src/**'
  - 'apps/**/src/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `bun scripts/check-coverage.ts --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — localstorage-theme · oxlint rules — basalt/search-literal-link, basalt/use-search-from-literal -->
<!-- not guarded: — -->
<!-- /basalt:coverage -->

# Basalt State

State a control reads or writes is a field on a store; the URL wins over localStorage over the fallback.

## Stores

- Define filters, tabs, ranges and pagination as fields of `createSearchStore` (URL) or `createLocalStore` (no router), with `field.range|multi|enum|boolean`. [type createSearchStore]
- Never `useState` for a filter, tab, range or view; a basalt control takes a `field` and has no `value` or `onChange`. A value another store owns (a zustand slice) binds as `externalField({ values, fallback, labels, store: { get, set, subscribe } })`, no lane, `clear()` writes the fallback. [check-theme raw-selection-control]
- Declare lanes once at definition: `{ url, persist, history }`; `url: false` is local-only, `persist: false` is URL-only. [type field]
- Option labels come from `.labels()` at definition, never a control prop. [type createSearchStore]
- Route `validateSearch` is `store.validateSearch`; a wider search shape spreads `...store.validateSearch(raw)`. [type createSearchStore]
- Read with `store.useValues()` or take the value as a prop; never `useSearch({ from: '<literal>' })`. [basalt/use-search-from-literal]
- A handle's `use()` returns `[value, setValue]`; the setter owns the navigate and the persist; on a `createLocalStore` field a prop-derived default is `store.field.x.withFallback(value)`, passed to `use()` and to any control as `field=` (unset only, never persisted, a reset returns to it, `isDefault` follows it; search stores lack it, a derived handle does not derive again), never a store rebuilt per prop. [type field]
- Count active filters and reset them with the store's `useActiveCount()` and `useReset()`; a reset unsets, it does not write the fallback. [type createSearchStore]
- A color scheme is `useMantineColorScheme()`, never a store or `localStorage['theme']`. [check-theme localstorage-theme]
- A preference that must survive navigation but is not URL-worthy uses `createPersistedState`, called once at module scope. [type createPersistedState]

## Nav

- Declare the whole navigation once with `defineNav` and `navGroup`. [type defineNav]
- Pass it as `<BasaltShell nav={NAV} />`; use `navTarget(NAV, id)` for a `<Link>`, `navigate()` or `redirect()`. [type navTarget]
- Route options sit under `link: linkOptions({ ... })`, never flat on the item. [type defineNav]
- Link a store-backed route with `search: store.linkSearch`, by reference; never call it or inline `{ range: '30d' }`. [basalt/search-literal-link]
- Declare `interface Register { router: typeof router }` in `main.tsx`, or `to` is not checked; never silence a nav type error with `as never`. [type defineNav]
- Turn nav into other surfaces (Spotlight) with `flattenNav`. [type flattenNav]

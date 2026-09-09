---
source: basalt-ui
description: Where each kind of state lives in a basalt-ui app — createSearchStore over typed fields (URL > localStorage > fallback), the lanes, FieldHandle, linkSearch by reference, defineNav/useNav, createPersistedState. Partly enforced by basalt/search-literal-link, basalt/use-search-from-literal and the localstorage-theme guard kind.
paths:
  - 'src/**'
  - 'apps/**/src/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `bun scripts/check-coverage.ts --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — localstorage-theme · oxlint rules — basalt/search-literal-link, basalt/use-search-from-literal -->
<!-- not guarded: — -->
<!-- /basalt:coverage -->

# Basalt State — stores, lanes, nav

A store is defined wherever the feature lives (`src/lib/`, `src/features/…`), not only under
`src/routes/**` — which is why this rule loads across the whole source tree.

## Where state goes

| Kind                                                                | Home                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| server data                                                         | TanStack Query (basalt-batteries.md)                                     |
| anything a control reads or writes — filter, tab, range, pagination | a **field** on `createSearchStore` / `createLocalStore`                  |
| color scheme                                                        | `useMantineColorScheme()` — never a store, never `localStorage['theme']` |
| a preference that must survive navigation but is not URL-worthy     | `createPersistedState` (`basalt-ui/state`)                               |
| network status                                                      | `useConnectivity()` — auto-mounted by `BasaltProvider`                   |

**Never `useState` for a filter, a tab, a range or a view** (law C3). It resets on navigation, it
cannot be linked, and it is the state a basalt control refuses to take (`value`/`onChange` do not
exist on one). Reach for a third-party store only for genuinely shared mutable state with no owning
component; basalt ships and depends on none.

## `createSearchStore` — one factory over typed fields

```ts
import { createSearchStore, field } from 'basalt-ui/router-tanstack'

export const analytics = createSearchStore({
  key: 'analytics',
  fields: {
    range: field.range({ presets: ['7d', '30d', '90d'], fallback: '30d', custom: true }),
    channels: field.multi(CHANNELS, []),
    tab: field.enum(['overview', 'detail'], 'overview', { persist: false }),
    compact: field.boolean(false, { url: false }),
  },
}).labels({ range: { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days' } })
```

- **The URL is the truth; the localStorage mirror is a fallback UNDER it.** Every field resolves
  URL ⊳ localStorage ⊳ fallback, identically for every field kind (law C4) — a deep link wins over
  the mirror.
- **Lanes are declared once, at definition**: `{ url, persist, history }`. `url: false` is
  local-only (a per-card select); `persist: false` is URL-only (pagination, a tab that shouldn't
  follow you elsewhere). `createLocalStore` is the same field vocabulary with no router.
- **Option LABELS come from `.labels()`, once, at definition** — never a per-control prop.
- **`validateSearch: store.validateSearch`** on the route, function form — it returns every
  URL-lane param unconditionally. A route with a wider search shape COMPOSES the store instead
  (`{ ...store.validateSearch(raw), ...rest }`) — there is no schema-backed store variant.
- **A write from outside the owning route persists only**; `validateSearch` picks it up next visit.
- **`field.range` keeps its three URL params** (preset + from/to); `handle.toWindow(value)` is the
  projection into query params — never a hand-written `presetToParams`.

## Reading and writing

- **A page reads `store.useValues()`, or takes the value as a PROP.** Never
  `useSearch({ from: '<literal>' })` (`basalt/use-search-from-literal`) — a sibling/child route
  fails that `from`. Basalt controls read through `FieldHandle`, which uses the non-strict search
  internally.
- **A `FieldHandle` is the whole read/write surface**: `use()` returns `[value, setValue]` and the
  setter owns the navigate AND the persist — a control never receives `value`/`onChange` (law C2).
  Hand-writing a navigate (a route with its own search shape) uses the reducer form,
  `navigate({ search: (prev) => ({ ...prev, … }) })`, so unrelated params survive.
- **`useActiveCount()`/`useReset()`** back a `Filters (n)` pill and its `Reset all` — never
  hand-count either.
- **A reset UNSETS.** `useReset()`/`field.clear()` DELETE the persisted key, never write
  `fallback` (which would pin a thunk fallback as a value nobody chose).
- **`set(next, { patch })`** merges sibling params the store does NOT own into the same navigate; a
  key another field of the same store owns throws in dev.

## Nav links carry the store BY REFERENCE

```ts
link: linkOptions({ to: '/dashboard', search: analytics.linkSearch })
```

**Pass the function, never call it, never inline an object.** It is a click-time thunk, so arriving
from anywhere restores the last selection; a module-scope literal (`search: { range: '30d' }`)
pins the fallback on every click — `basalt/search-literal-link` catches it. `search: true` is a
type error against a store-backed route.

## The typed nav definition

The whole navigation — desktop sidebar and mobile bar — is declared ONCE with `defineNav` /
`navGroup` in a **leaf** module (`src/lib/nav.tsx`) that never imports `routeTree.gen` or
`__root.tsx`, so palettes and redirects can import it without closing a cycle. `useNav(NAV)` resolves
it against the live router and returns `{ sections, mobileNav }` — both `BasaltShell` props, so
spread it. `navTarget(NAV, id)` is one destination's link options, typed per id, for a `<Link>`, a
`navigate()` or a `redirect()`. `flattenNav` is the leaf every other surface reads (e.g. projecting
the nav into Spotlight in one `.map()`).

- **Route options live under `link:`, wrapped in TanStack's own `linkOptions`** — never spread flat
  onto the item (a flat shape validates `to` by assignability, no excess-property checking, so a
  typo'd metadata key compiles silently). `id`/`label`/`short`/`icon`/`mobile`/`disabled`/`exact`
  ride outside `link`.
- **Nesting is `children`**; `mobile` places the destination on the bar (basalt-mantine.md).
- **Without the `Register` module augmentation, `defineNav` validates NOTHING and reports zero
  errors** — `RegisteredRouter` falls back to `AnyRouter`, every `to` widens to `string`. Verify
  once by changing a `to` to garbage and confirming the compile error. **Never reach for
  `as never`** to quiet one — the checking is the entire point.
- `staticData` (`title`/`icon`/`navSection`) drives `useRouterBreadcrumbs` and needs the generated
  route tree.

## `createPersistedState` — the localStorage primitive

Call it once at module scope; use the returned hook anywhere, no provider. SSR-safe, cross-tab via
the `storage` event, versioned (bump `version` on a shape change, stale values fall back to
`initial`). Keys are namespaced `basalt:<key>` automatically; `readPersistedValue(key, v)` is the
non-React read. Every basalt module that persists — shell collapse, `Section` fold, a sidebar
block, a form draft, notification history — goes through this one primitive.

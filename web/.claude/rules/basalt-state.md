---
source: basalt-ui
description: Where each kind of state lives in a basalt-ui app — createSearchStore over typed fields (URL > localStorage > fallback), the lanes, FieldHandle, linkSearch by reference, defineNav/useNav, createPersistedState. Partly enforced by basalt/search-literal-link, basalt/use-search-from-literal and the localstorage-theme guard kind.
paths:
  - 'src/**'
  - 'apps/**/src/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `basalt-ui check-coverage --write`. Do not hand-edit. -->
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
  URL ⊳ localStorage ⊳ fallback, identically for every field kind (law C4). A deep link therefore
  wins over the mirror — that is the whole difference from the enum-only pair it replaced, whose
  reader WAS the localStorage state, so a shared link opened on the wrong window.
- **Lanes are declared once, at definition**: `{ url, persist, history }`. `url: false` is the
  local-only lane (a per-card select, a compact toggle); `persist: false` is the URL-only lane
  (pagination, a tab that should not follow you to another feature). `createLocalStore`
  (`basalt-ui/state`) is the same field vocabulary with no router at all.
- **Option LABELS come from `.labels()`, once, at definition** — never a per-control prop and never a
  lookup table in the page.
- **`validateSearch: store.validateSearch`** on the route, in the function form. It returns every
  URL-lane param unconditionally, which is what makes the store's "does this route own the field"
  check exact. A route with a genuinely wider search shape hand-writes `validateSearch` and COMPOSES
  the store into it (`{ ...store.validateSearch(raw), ...rest }`) — there is no schema-backed store
  variant, and none is coming.
- **A write from outside the owning route persists only**, and `validateSearch` picks it up on the
  next visit. Two different stores using one param name on overlapping routes read as one owner;
  presence in the search is all a store can see without the router naming the declarer.
- **`field.range` keeps its three URL params** (preset + from/to, renamable) so existing loaders and
  deep links keep their shape; `handle.toWindow(value)` is the projection into query params — never a
  hand-written `presetToParams`.

## Reading and writing

- **A page reads `store.useValues()`, or takes the value as a PROP.** Never
  `useSearch({ from: '<literal>' })` — a sibling or child route fails that `from`, and it is
  `basalt/use-search-from-literal`. Basalt's own controls read through the `FieldHandle`, which uses
  the non-strict search internally, so a control renders on any matched route with no `from` at all.
- **A `FieldHandle` is the whole read/write surface** a control needs: `use()` returns
  `[value, setValue]` and the setter owns the navigate AND the persist. So a control never receives
  `value`/`onChange` (law C2) and a page never writes a navigate for a store field. Where you DO hand-write
  one — a route with its own search shape — use the reducer form, `navigate({ search: (prev) => ({ ...prev, … }) })`,
  so unrelated params survive.
- **`useActiveCount()` / `useReset()`** are what a `Filters (n)` pill and its `Reset all` derive
  from. Never hand-count either.
- **A reset UNSETS.** `useReset()` and `field.clear()` DELETE the persisted key; they never write
  `fallback`, which would pin a thunk fallback (`() => todayIso()`) as a value nobody chose. A
  hand-rolled reset calls `field.clear()`, never `setValue(field.fallback)`.
- **`set(next, { patch })`** merges sibling params the store does NOT own into the same navigate. A
  key another field of the same store owns throws in dev — write it through that field's setter.

## Nav links carry the store BY REFERENCE

```ts
link: linkOptions({ to: '/dashboard', search: analytics.linkSearch })
```

**Pass the function, never call it, never inline an object.** It is a click-time thunk, so arriving
from anywhere restores the last selection; a module-scope literal (`search: { range: '30d' }`) pins
the fallback on every click and is why one consumer's reader had zero call sites while every
individual piece looked correct. `search: true` is a type error against a store-backed route.
`basalt/search-literal-link` catches the literal, and in dev `validateSearch` warns once when the URL
pins the fallback, something else is persisted, and no reader has ever been called.

## The typed nav definition

The whole navigation — desktop sidebar and mobile bar — is declared ONCE with `defineNav` /
`navGroup` in a **leaf** module (`src/lib/nav.tsx`) that never imports `routeTree.gen` or
`__root.tsx`, so palettes and redirects can import it without closing a cycle. `useNav(NAV)` resolves
it against the live router and returns `{ sections, mobileNav }` — both `BasaltShell` props, so
spread it. `navTarget(NAV, id)` is one destination's link options, typed per id, for a `<Link>`, a
`navigate()` or a `redirect()`. `flattenNav` is the leaf every other surface reads (e.g. projecting
the nav into Spotlight in one `.map()`).

- **Route options live under `link:`, wrapped in TanStack's own `linkOptions`** — never spread flat
  onto the item. A flat shape validates `to` by assignability, which does no excess-property
  checking, so a typo'd metadata key compiles silently. `id`/`label`/`short`/`icon`/`mobile`/
  `disabled`/`exact` ride outside `link`.
- **Nesting is `children`**; `mobile` places the destination on the bar (basalt-mantine.md).
- **Without the `Register` module augmentation, `defineNav` validates NOTHING and reports zero
  errors** — `RegisteredRouter` falls back to `AnyRouter`, every `to` widens to `string`, and the API
  looks like it is working while catching nothing. Verify it once by changing a `to` to garbage and
  confirming the compile error lists the real route paths. The router's errors here are large; read
  the union for the intended path and fix the string. **Never reach for `as never`** to quiet one —
  the checking is the entire point.
- Whether a MISSING `search` is caught depends on the schema's OUTPUT type: with every key required
  (what a store or a defaulted Zod object produces) TanStack raises and the compiler catches it. With
  every key optional, a forgotten `search` compiles — diff the target table by hand there.
- `staticData` (`title` / `icon` / `navSection`) drives `useRouterBreadcrumbs` and needs the
  generated route tree; everything else in the bridge works against a hand-written router.

## `createPersistedState` — the localStorage primitive

Call it once at module scope; use the returned hook anywhere, with no provider. SSR-safe, cross-tab
through the `storage` event, versioned — bump `version` when the shape changes and stale values fall
back to `initial`. Keys are namespaced `basalt:<key>` automatically, and `readPersistedValue(key, v)`
is the non-React read (how you mirror the shell's own collapse state). Pass a Standard Schema to
validate what comes back. Every basalt module that persists — the shell's collapse, a `Section`
fold, a sidebar block, a form draft, the notification history — persists through this one primitive.

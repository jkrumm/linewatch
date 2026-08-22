---
source: basalt-ui
description: TanStack Router conventions for basalt-ui apps — file-based routes, typed search params, loader/query coupling, and the one typed nav definition that drives both the desktop sidebar and the mobile bar. Advisory (ships an optional ./router-tanstack adapter).
paths:
  - 'src/routes/**'
  - 'apps/**/src/routes/**'
---

# Basalt Router — TanStack Router Conventions

basalt-ui is **router-agnostic** — the shell renders every pixel of nav chrome and hosts the
consumer's router component through one seam, `SidebarItem.Anchor` (a **`NavAnchor`**). With
TanStack Router you never write that seam by hand: **`defineNav`** declares the whole navigation
once and **`useNav`** resolves it against the live router, returning the two props `BasaltShell`
needs. Breadcrumbs come from **`useRouterBreadcrumbs`**, ad-hoc active checks from
**`useBasaltNav`**. This rule is the recommended opinion layer when you use TanStack Router (the
basalt-ui default). It is **advisory** — adopt it for consistency; nothing in the framework
enforces it.

## Adding a page

1. Create `src/routes/<page-name>.tsx`.
2. Export `Route` via `createFileRoute('/<page-name>')`.
3. Add `validateSearch` with a Zod schema parsed via a function — not the schema passed directly.
4. Define `loaderDeps` to forward search params to the loader (required for search-param-driven queries).
5. Add a `loader` that calls `ensureQueryData` for each query the page needs.
6. Register the page in your `defineNav` definition (see "One typed nav definition" below).

## Route structure

```ts
import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from 'basalt-ui/query'
import { z } from 'zod'
import { resourceQueries } from '../lib/queries/resource'

const SearchSchema = z.object({
  window: z.enum(['7d', '30d', '90d', 'all']).default('30d'),
  from: z.string().optional(),
  to: z.string().optional(),
})
type SearchParams = z.infer<typeof SearchSchema>

export const Route = createFileRoute('/resource')({
  validateSearch: (raw: Record<string, unknown>) => SearchSchema.parse(raw),
  loaderDeps: ({ search }: { search: SearchParams }) => ({
    window: search.window,
    from: search.from,
    to: search.to,
  }),
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(resourceQueries.summary(deps)),
      context.queryClient.ensureQueryData(resourceQueries.series(deps)),
    ]),
  component: ResourcePage,
})

function ResourcePage() {
  const search = Route.useSearch()
  const { data } = useSuspenseQuery(resourceQueries.summary(search))
  // render — charts read VX.* tokens; chrome uses Mantine
}
```

## validateSearch

**Scope of the `createSearchParamStore` mandate — read this before reaching for the store.**
`createSearchParamStore` covers ONE param whose values are a string enum
(`{ key, param, values, fallback }`); `createMultiSearchParamStore` is the multi-select of the same
shape. Where that fits — a range picker, a tab, a single filter — it is **mandatory**: use it, don't
hand-roll persistence.

Where it doesn't fit, it doesn't apply. A route whose `validateSearch` is a real Zod object (10+
keys, nested shapes, cross-field defaults) cannot be expressed through the store at all — three
consumers hit that wall. **Hand-write `validateSearch` there**, per the rules below. There is no
schema-backed store: `createSearchSchemaStore` is planned and **not shipped** — do not write code
against it.

- Always parse with the schema-function form: `(raw) => SearchSchema.parse(raw)`.
- Default values live in the schema (`.default()`), not in the component.
- Access via `const search = Route.useSearch()`.
- Update via `navigate({ search: { window: 'all', from: undefined, to: undefined } })` — prefer plain
  objects over reducers to avoid `| undefined` assignability errors when the schema has defaults.

### Wire the reader, or the store does nothing (1.20.1)

`validateSearch` is only half the store. It restores the value when you arrive with **no** param —
it cannot do anything about a nav link that declares the param itself, and a link written
`search: { window: '30d' }` at module scope pins the fallback on every click. That is not
hypothetical: the reference consumer adopted the store in three features, hand-rolled the
persistence in all three, and its reader had **zero** call sites. "Remember my window" had never
once worked, with every individual piece looking correct.

`store.linkSearch` is the fix, and it is on the object the factory already returns:

```ts
const dashboardRange = createSearchParamStore({
  key: 'dashboard-range',
  param: 'range',
  values: ['1d', '7d', '30d'] as const,
  fallback: '30d',
})
// → { validateSearch, useStore, readStored, linkSearch }

link: linkOptions({ to: '/dashboard', search: dashboardRange.linkSearch })
```

**Pass it by reference, never call it.** It is the click-time thunk
(`() => ({ [param]: readStored() ?? fallback })`); `<Link>` re-evaluates it on every click, so
arriving from outside the sub-tree restores the last selection. A value computed once at module
scope goes stale immediately. Hand-rolling the thunk over `readStored()` still works and is what
you need when the link carries other params too.

In dev, `validateSearch` warns once per store when the URL pins the fallback, a different value is
persisted, and neither public reader has ever been called — the one combination that has exactly
this cause. Silent in production, silent on a deliberate deep link.
`createMultiSearchParamStore` gets `linkSearch` but no warning: an empty array in the URL is
indistinguishable from an absent param, so a literal link there still restores correctly.

## loaderDeps

- Define `loaderDeps` whenever the loader depends on search params. Without it, search-param changes do
  not re-trigger the loader.
- The `deps` object is forwarded to the loader and should be passed directly to the `ensureQueryData`
  query factories.

## Loaders

- Use `ensureQueryData` (not `fetchQuery`) so cached data is reused.
- The loader receives `context: { queryClient }` — wire it in your router config.
- Loaders do not return data to the component — components read via `useSuspenseQuery`.
- When a redirect from another route points here, include the required `search` params or TypeScript
  raises `MakeRequiredSearchParams`.

## Route tree

`src/routeTree.gen.ts` is auto-generated by the Vite plugin — never edit it. Regenerated by
`tsr generate` (also during `typecheck`). File names starting with `__` are reserved; only `__root.tsx`
is valid.

The shipped oxlint preset does **not** ban `react-router` or `react-router-dom` — basalt is
router-agnostic and imposes no mechanical guard. TanStack Router is the recommended/idiomatic
choice (this rule documents its conventions, and the `./router-tanstack` adapter targets it), but
using `react-router` is an advisory preference, not an enforced restriction.

## ./router-tanstack adapter

The optional `./router-tanstack` subpath ships a headless (Mantine-free) TanStack Router bridge.
Install `@tanstack/react-router` as a peer, then import from `basalt-ui/router-tanstack`.

**Prerequisites:**

- **The only hard prerequisite is the `Register` module augmentation** (see "The prerequisite that
  makes all of this real" below). `defineNav` / `navGroup` / `navTarget` / `flattenNav` / `useNav` /
  `createSearchParamStore` all work against a hand-written `createRouter({ routeTree })` with
  code-defined routes, no Vite plugin and no generated tree — verified end-to-end in a consumer,
  including that a bad `to` still prints the real route-path union.
- **`@tanstack/router-plugin/vite` + `tsr generate` are needed only for `staticData`** — that is,
  for `useRouterBreadcrumbs` and any nav metadata read off the route tree. The
  `StaticDataRouteOption` augmentation takes effect once `src/routeTree.gen.ts` exists. In CI and
  after adding routes, run `tsr generate` (or `bun run typecheck`, which triggers it) before relying
  on breadcrumb data.
- The loader's `context.queryClient` requires `createRootRouteWithContext<{ queryClient: QueryClient }>()`.
  Run `basalt-ui init` to scaffold a `query-client.ts` + `__root.tsx` seed that wires the TanStack
  Router + Query context correctly — the generated `__root.tsx` uses
  `createRootRouteWithContext<{ queryClient }>()` and passes the client through `RouterProvider`.

**StaticDataRouteOption augmentation** — declare on any route to drive the adapter:

```ts
export const Route = createFileRoute('/reports')({
  staticData: { title: 'Reports', navSection: 'Insights' },
  component: ReportsPage,
})
```

Augmented fields: `title?: string`, `icon?: ReactNode`, `navSection?: string` (all optional — any
route remains valid without them).

**useBasaltNav** — reactive active-state resolution:

```ts
import { useBasaltNav } from 'basalt-ui/router-tanstack'

const { currentPath, isActive } = useBasaltNav()
isActive('/reports') // prefix match (active on /reports/42 too)
isActive('/reports', { exact: true }) // exact match only
isActive('/') // always exact (root is never a prefix match)
```

**useRouterBreadcrumbs** — ancestor→deepest breadcrumb trail from `staticData.title`:

```ts
import { useRouterBreadcrumbs } from 'basalt-ui/router-tanstack'

function AppBreadcrumbs() {
  const crumbs = useRouterBreadcrumbs()
  return <nav>{crumbs.map((c) => <a key={c.href} href={c.href}>{c.title}</a>)}</nav>
}
```

**One typed nav definition** — `defineNav` / `navGroup` / `navTarget` / `useNav`.

The whole navigation — desktop sidebar and mobile bar — is declared once in a **leaf** module
(`src/lib/nav.tsx`), which imports `@tanstack/react-router` and `basalt-ui/router-tanstack` and
**never** `routeTree.gen` or `__root.tsx`, so command palettes and redirects can import it without
closing a cycle.

```tsx
import { linkOptions } from '@tanstack/react-router'
import { defineNav, navGroup } from 'basalt-ui/router-tanstack'
import { garminWindow } from './search-params' // a createSearchParamStore

const ICON = 18

export const NAV = defineNav({
  groups: [
    navGroup({ id: 'health', label: 'Health', icon: <IconHeartbeat size={ICON} /> }, [
      {
        id: 'garmin',
        label: 'Garmin Health',
        short: 'Garmin', // bar/menu label — keep it ≤ 10 chars
        mobile: 'tab', // give this destination its own slot on the mobile bar
        icon: <IconHeartbeat size={ICON} />,
        // NOT `search: { window: '30d' }` — a module-scope literal pins the fallback on
        // every click and silently overrides the store. Pass the reader by reference.
        link: linkOptions({ to: '/garmin-health', search: garminWindow.linkSearch }),
      },
      {
        id: 'reading',
        label: 'Reading',
        icon: <IconBook size={ICON} />,
        link: linkOptions({ to: '/reading' }),
        children: [
          {
            id: 'reading-stats',
            label: 'Stats',
            icon: <IconChartBar size={ICON} />,
            link: linkOptions({ to: '/reading/stats' }),
          },
        ],
      },
    ]),
  ],
})
```

Rules that are not stylistic:

- **Route options live under `link:`, wrapped in TanStack's own `linkOptions`** — never spread flat
  onto the item. `to` / `search` / `params` get the router's full validation there, while `id`,
  `label`, `short`, `icon`, `mobile`, `disabled` and `exact` ride outside it. A flat shape
  (`{ id, label, to }`) validates `to` by ASSIGNABILITY, which does no excess-property checking, so
  a typo'd metadata key would compile silently. A top-level `to:` is a compile error by design.
- **`search` may be a thunk, and for a store-backed param it MUST be** —
  `search: () => ({ date: format(new Date(), 'yyyy-MM-dd') })` compiles without `as const` and
  re-evaluates at click time, so "today" never goes stale in a long-lived tab. A param backed by
  `createSearchParamStore` takes the store's own `linkSearch` (see "validateSearch" above); a
  literal there is the one shape that defeats the store.
- **Nesting is `children`**, and nested destinations are indexed by id just like top-level ones.
- **`NavItemMeta`**'s `mobile` field places the destination on the bar: `'tab'` (own slot),
  `'more'` (the default — reachable through the More overlay) or `'hidden'`. A group claims a slot
  of its own with `mobile: { tab: true }`, and leaves mobile entirely with `mobile: false`.

```tsx
// __root.tsx — four lines replace a hand-written sections array, two render callbacks,
// a NAV_TARGETS table and one useMatchRoute call per destination.
import { useNav } from 'basalt-ui/router-tanstack'
import { NAV } from '../lib/nav'

const nav = useNav(NAV, { badges: { calendar: unread } }) // keys autocomplete; a typo is an error
return (
  <BasaltShell brand={brand} {...nav}>
    {children}
  </BasaltShell>
)
```

**`useNav`** returns `{ sections, mobileNav }` — both are `BasaltShell` props, so spread it. It
resolves `active` per destination through `useMatchRoute` (prefix match by default, exact when the
item sets `exact: true`, and always exact for `'/'`), and builds each destination's **`NavAnchor`**
so `preload="intent"`, middle-click and back/forward keep working. `badges` values that are
`number` become `SidebarItem.count` (a desktop **`NavCountBadge`** plus an accent dot on the mobile
slot); anything else becomes `SidebarItem.badge`, which is desktop-only because a count glyph is
unreadable in a 56px tab.

**`navTarget`** returns one destination's link options, typed per id — spread it into `<Link>`,
`router.navigate()` or `redirect()` instead of restating the route and its default search:

```ts
throw redirect(navTarget(NAV, 'garmin')) // exactly { to: '/garmin-health', search: garminWindow.linkSearch }
```

**`flattenNav`** walks the definition depth-first (parent, then children), tagging each destination
with `groupId` / `groupLabel` — the leaf every other surface reads, e.g. projecting the whole nav
into Spotlight commands in one `.map()`.

### The prerequisite that makes all of this real

**Without the `Register` module augmentation, `defineNav` validates NOTHING and reports zero
errors.** `RegisteredRouter` falls back to `AnyRouter` when the consumer has not written:

```ts
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
```

With that missing, every `to` widens to `string`, a nonexistent route path compiles, a missing
required `search` compiles, and the API looks like it is working while catching nothing. This is
the single highest-value thing to verify when adopting the config: change one `to` to a garbage
path and confirm you get a compile error listing the real route paths. If you don't, the
augmentation is missing (or, on a file-route setup, `tsr generate` has not run).

Second thing to know before you migrate: whether a missing `search` is caught depends on the
schema's OUTPUT type, not on the `validateSearch` signature. If every key of `T` is required —
which is what a Zod object with defaults produces, since defaults apply on parse and the output has
no optionals — TanStack raises `MakeRequiredSearchParams` and the compiler catches it. Two routes in
one consumer had been shipping nav links with no search params behind a `to={target.to as never}`
cast; removing the callback surfaced both immediately.

**The caveat holds only when `T` has no required keys** (every key optional, or the validator
returns a partial). There, a forgotten `search` compiles — diff the old target table against the new
definition by hand, key by key. Everywhere else, trust the error.

Error messages here are the router's own and they are large: one wrong `to` prints the whole
route-path union plus a `RouterCore<…>` blob, because TanStack's `Constrain` falls back to the
whole constraint. That is not misuse — read the union for the intended path and fix the string.
**Do not reach for `as never` to make it quiet**; the checking is the entire point of the config.

Navigation itself (`.navigate()`, `<Link to={…}>`) stays the consumer's typed concern — the adapter
still exposes no `navigate()` helper, so TanStack's route-tree types remain authoritative. What
`navTarget` hands back is the ARGUMENT to those calls, never the call.

---
source: basalt-ui
description: TanStack Query conventions for basalt-ui apps — query factories, Suspense reads, and mutation/invalidation. basalt-ui ships ./query (createBasaltQueryClient + unwrap + devtools); this rule covers the advisory consumer patterns on top.
paths:
  - 'src/lib/queries/**'
  - 'apps/**/src/lib/queries/**'
  - 'src/routes/**'
  - 'apps/**/src/routes/**'
---

# Basalt Query — TanStack Query Conventions

basalt-ui ships `./query` — a thin TanStack Query adapter providing `createBasaltQueryClient`,
`unwrap`, `BasaltQueryDevtools`, and convenience re-exports (`QueryClientProvider`,
`QueryErrorResetBoundary`, `useQueryErrorResetBoundary`). @tanstack/react-query is a **required**
peer — `BasaltProvider` hard-requires it at build time.

`./query` also re-exports the primary fetch hooks so consumers never need to dual-import from both
`basalt-ui/query` and `@tanstack/react-query`:

```ts
import {
  useQuery,
  useSuspenseQuery,
  useMutation,
  useQueryClient,
  useInfiniteQuery,
  queryOptions,
} from 'basalt-ui/query'
```

This rule covers the advisory consumer patterns on top of that adapter. Nothing in the framework
enforces these conventions beyond the `unwrap` seam.

## Query factories

Each resource has a factory in `src/lib/queries/<resource>.ts`:

```ts
import { queryOptions, useSuspenseQuery } from 'basalt-ui/query'
import { unwrap } from 'basalt-ui/query'
import { api } from '../api-client'

export const resourceQueries = {
  list: (params: ListParams) =>
    queryOptions({
      queryKey: ['resource', 'list', params],
      queryFn: () => unwrap(api.resource.get({ query: params })),
    }),
  summary: () =>
    queryOptions({
      queryKey: ['resource', 'summary'],
      queryFn: () => unwrap(api.resource.summary.get()),
    }),
}
```

- Key hierarchy: `[resource, action, ...params]`.
- `queryOptions` and all hooks import from `basalt-ui/query` — do not dual-import from
  `@tanstack/react-query` directly.
- `queryFn` unwraps typed responses via `unwrap()` — throws on the error branch so failures surface
  to the nearest error boundary or TanStack Query's error state. Also throws when `data` is `null`
  with no error (e.g. a 204 No Content or a silent transport failure that returns
  `{ data: null, error: null }`). Both cases are bugs the caller must address.
- Never use raw strings as query keys in components — always import from the factory.

## Reading data in components

```ts
import { useSuspenseQuery } from 'basalt-ui/query'

const { data } = useSuspenseQuery(resourceQueries.summary())
```

- Always `useSuspenseQuery` inside loader-prefetched routes (never `useQuery`) — pairs with the
  router's `ensureQueryData` (see basalt-router.md).
- Wrap pages or panels in `<Suspense fallback={…}>` at the route level.

## Mutations

```ts
const mutation = useMutation({
  mutationFn: (body) => unwrap(api.resource.post({ body })),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['resource'] })
    notifications.show({ message: 'Saved', color: 'green' })
  },
})
```

- Invalidate by resource prefix (first key segment) — catches list + summary at once.
- Show a notification on success; let errors bubble to the global error boundary.
- For the in-button success flip (loading spinner → green `IconCheck`), drive it off `mutation.isPending`
  / `mutation.isSuccess` — see the interaction-feedback section in basalt-mantine.md.

## DevTools

Use `BasaltQueryDevtools` from `basalt-ui/query` — it is lazy, production-excluded, and safe to
import unconditionally:

```tsx
import { BasaltQueryDevtools, QueryClientProvider } from 'basalt-ui/query'

function Root() {
  return (
    <QueryClientProvider client={client}>
      {children}
      <BasaltQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}
```

Never import `@tanstack/react-query-devtools` directly in app code — it is an optional peer and
the lazy wrapper handles the production guard for you.

## Eden footguns (hard authoring rules)

Two patterns silently degrade Eden Treaty inference to `any` — both must be avoided:

1. **Non-chained route definitions**: Elysia routes MUST be method-chained on the `app` instance.
   A standalone `app.get(...)` (reassigned or called without chaining back to the root) drops the
   `App` type to `any`, which propagates into the Treaty client and loses all type safety.

2. **Mismatched tsconfig path aliases**: The client package and the server package MUST share or
   extend one root `tsconfig` so path aliases (`~/*`, `@/*`, etc.) resolve identically in both.
   A mismatch causes Eden's type extraction to fail silently and degrade to `any`.

Both footguns produce no TypeScript error at the point of breakage — they only manifest as `any`
types on the Treaty client, making them hard to spot. Check these first when Eden types regress.

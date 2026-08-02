---
source: basalt-ui
description: Client state conventions for basalt-ui apps — where each kind of state lives and the theme-scheme rule (localStorage-theme read is guarded). Mostly advisory.
paths:
  - 'src/**'
  - 'apps/**/src/**'
---

# Basalt State

How to place state in a basalt-ui app. The **theme-scheme rule** below is
guard-enforced (`basalt-ui check-theme` bans `localStorage.getItem('theme')`); the rest is **advisory**.

## State placement

Pick the right home for each kind of state — don't dump everything into one store:

- **Server state** (API data) → TanStack Query (see basalt-query.md).
- **URL state** (filters, active tab, pagination, time window) → `validateSearch` in TanStack Router
  (see basalt-router.md). URL state is shareable and survives reload — prefer it for anything a user
  might link to.
- **Theme / color scheme** → `useMantineColorScheme()` from Mantine — **never** a client store, and
  **never** `localStorage.getItem('theme')`. The scheme persists to Mantine's own key and resolves the
  `--vx-*` tokens via CSS; reading it any other way breaks scheme reactivity and trips `basalt-ui check-theme`.
- **UI preferences that must survive navigation but aren't URL-worthy** (sidebar collapsed, panel
  layout, draft filters) → `createPersistedState` from `basalt-ui/state` — the framework's own
  versioned localStorage primitive (see below). `BasaltShell` already persists its own collapse state
  internally; use `createPersistedState` for app-level preferences. Reach for a third-party store
  only when complex cross-component state genuinely warrants it (see escape hatch below).

## useOnlineStatus — SSR-safe online/offline hook

`useOnlineStatus()` returns `true` when the browser reports an active network connection,
`false` when offline. Backed by `useSyncExternalStore` + `window.online`/`offline` events.
SSR-safe — server snapshot is `true` (optimistic). Exported from both `basalt-ui` (root) and
`basalt-ui/state`.

```ts
import { useOnlineStatus } from 'basalt-ui/state'

const isOnline = useOnlineStatus()
if (!isOnline) return <OfflineBanner />
```

No props, no options. Use it in any component; no provider needed.

## createPersistedState — the default primitive

`createPersistedState` is a factory hook: call it once at module scope, use the returned hook in
components. SSR-safe, cross-tab via the `storage` event, versioned to handle shape migrations.

```ts
import { createPersistedState } from 'basalt-ui/state'

// 1. Define the hook once (version: increment when the shape changes):
export const usePanelLayout = createPersistedState({
  key: 'panel-layout',
  version: 1,
  initial: 'split' as 'split' | 'stacked',
})

// 2. Use in any component — no provider, no context:
const [layout, setLayout] = usePanelLayout()
```

Keys are namespaced `basalt:<key>` automatically and never collide with the theme-scheme guard.
Pass a `schema` (Standard Schema) to validate persisted values and fall back to `initial` on mismatch.

## Zustand escape hatch (complex cross-component stores)

Reach for Zustand only when `createPersistedState` is insufficient — typically when multiple
unrelated components share mutable state that is **not** URL-worthy and has no single owning
component:

```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type UiState = {
  panelLayout: 'split' | 'stacked'
  setPanelLayout: (v: UiState['panelLayout']) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      panelLayout: 'split',
      setPanelLayout: (v) => set({ panelLayout: v }),
    }),
    { name: 'app-ui' },
  ),
)
```

basalt-ui does **not** ship or depend on Zustand — it is a consumer choice. Resist putting
query results, derived data, or theme scheme in any store.

> **Forms** are covered by `basalt-forms.md` — see `./forms` (useBasaltForm, field, FormErrorSummary,
> useFormDraft). `@mantine/form` is an optional peer; install it with `bun add @mantine/form`.

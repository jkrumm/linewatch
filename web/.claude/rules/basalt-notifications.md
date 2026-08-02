---
source: basalt-ui
description: Notification conventions for basalt-ui apps — notify helpers, typed registry, persisted history store, bell/center, and BasaltNotifications overlay from the shipped ./notifications battery. @mantine/notifications is an optional peer.
paths:
  - 'src/**'
  - 'apps/**/src/**'
---

# Basalt Notifications

basalt-ui ships `./notifications` — a Mantine notification adapter battery providing `notify`,
`notifySuccess/Error/Warning/Info`, `notifyPromise`, `defineNotifications`, `emit`,
`useNotificationHistory`, `NotificationBell`, `NotificationCenter`, and `BasaltNotifications`
on top of `@mantine/notifications`. `@mantine/notifications` is an **optional peer** — install it
before using this battery:

```bash
bun add @mantine/notifications
```

## Mount BasaltNotifications

Render **one** `<BasaltNotifications />` inside `BasaltProvider`, before the router. The overlay is
opt-in — it is NOT auto-mounted from `BasaltProvider` to keep the peer out of the root barrel.

```tsx
import { BasaltNotifications } from 'basalt-ui/notifications'
import { BasaltProvider } from 'basalt-ui'

createRoot(root).render(
  <BasaltProvider>
    <BasaltNotifications />
    <App />
  </BasaltProvider>,
)
```

`BasaltNotifications` wraps Mantine's `<Notifications />` with basalt defaults:
`position="bottom-right"`, `autoClose=4000`, `limit=5`. Pass props to override:

```tsx
<BasaltNotifications position="top-right" autoClose={3000} limit={3} />
```

NOTE: `BasaltOverlays` (from `basalt-ui/commands`) is the shipped composable mount that wires
notifications together with spotlight/modals in one place. A standalone `<BasaltNotifications />`
remains available for apps that don't use the overlays layer.

## notify

`notify(opts)` is the core helper. It maps intent → Mantine color name, sets the correct aria
`role` for screen reader announcement, applies per-intent `autoClose` defaults, and records the
toast to the persisted history store. Returns the notification id string.

```ts
import { notify } from 'basalt-ui/notifications'

notify({ intent: 'success', message: 'Profile saved' })
notify({ intent: 'error', message: 'Upload failed', title: 'Error', autoClose: false })
notify({ intent: 'warning', message: 'Session expires soon', dedupKey: 'session-warn' })
```

### Intent → Mantine color + aria role + autoClose

| Intent  | `color=`   | `role=`               | Default autoClose         |
| ------- | ---------- | --------------------- | ------------------------- |
| success | `'green'`  | `'status'` (polite)   | 2000ms                    |
| info    | `'blue'`   | `'status'` (polite)   | 3000ms                    |
| warning | `'yellow'` | `'alert'` (assertive) | 5000ms                    |
| error   | `'red'`    | `'alert'` (assertive) | `false` (until dismissed) |

**Never pass raw Mantine colors directly.** Always use `notify`'s `intent` field — the mapping is
the canonical source so screen-reader announcement and autoClose stay consistent.

### Two-layer dedup

1. **Mantine id-dedup**: passing the same `id` to `notifications.show` is a no-op on screen
   (Mantine's built-in dedup). Pass `id` to prevent a toast from appearing twice.
2. **dedupKey window**: a module-level guard skips any `notify` call using the same `dedupKey`
   within 1500ms — useful for event-driven triggers that may fire rapidly.

```ts
// Fire rapidly — only the first call within 1500ms shows:
notify({ intent: 'warning', message: 'Rate limit', dedupKey: 'rate-limit-warn' })
```

## Convenience wrappers

```ts
import { notifySuccess, notifyError, notifyWarning, notifyInfo } from 'basalt-ui/notifications'

notifySuccess('Changes saved')
notifyError('Upload failed', { title: 'Storage error' })
notifyWarning('Session expires in 5 minutes')
notifyInfo('New version available', { autoClose: 10000 })
```

Each wrapper calls `notify` with the matching intent. The second arg takes all `NotifyOptions`
fields except `intent` and `message`.

## notifyPromise

For async operations — shows a loading toast, then updates to success or error on settle.
Uses `notifications.show` for loading, then `notifications.update` for the final state (required
by Mantine to replace an existing id — `show` with the same id is a no-op).

```ts
import { notifyPromise } from 'basalt-ui/notifications'

await notifyPromise(uploadFile(file), {
  loading: 'Uploading…',
  success: 'Upload complete',
  error: 'Upload failed',
})
```

The promise is passed through — `await notifyPromise(...)` resolves/rejects as normal. The final
state is recorded to the notification history store (loading state is not recorded).

## defineNotifications + emit

`defineNotifications` is a const-generic factory (mirrors `defineSeries` from `./tokens`) for
typed notification kind registries. Augment `BasaltRegister.notifications` once with the spec map
type, then use `emit` — unknown kinds are tsc errors.

```ts
// notifications.ts — define and augment (app-side, once):
import { defineNotifications } from 'basalt-ui/notifications'

export const NOTIFICATIONS = defineNotifications({
  'upload:success': { intent: 'success', toMessage: (p: { name: string }) => `Uploaded ${p.name}` },
  'upload:error': { intent: 'error', toMessage: (_: unknown) => 'Upload failed' },
  'session:warn': { intent: 'warning', toMessage: () => 'Session expires soon' },
})

declare module 'basalt-ui' {
  interface BasaltRegister {
    notifications: typeof NOTIFICATIONS
  }
}
```

```ts
// usage.ts — typed emit, unknown kinds fail tsc:
import { emit } from 'basalt-ui/notifications'

emit('upload:success', { name: 'photo.jpg' }) // ✓ typed payload
emit('upload:error', null) // ✓
emit('nonexistent', null) // ✗ tsc error
```

`emit` resolves `intent` + calls `toMessage(payload)` from the registered spec, then calls
`notify()`. Pass extra `NotifyOptions` as a third argument to override spec defaults.

## defineNotification (single-spec helper)

Mirror of `defineOverlay` from `./commands` — types a single notification spec without registering
it. Use when splitting notification definitions across files before merging into `defineNotifications`.

```ts
import { defineNotification, defineNotifications } from 'basalt-ui/notifications'

// Type an isolated spec constant — useful when splitting across files:
const uploadSuccess = defineNotification({
  intent: 'success',
  toMessage: (p: { name: string }) => `Uploaded ${p.name}`,
})

// Merge into the full registry (defineNotifications does the actual registration):
export const NOTIFICATIONS = defineNotifications({ 'upload:success': uploadSuccess })
```

WARNING: `defineNotification` only TYPES — it does NOT register. Only `defineNotifications(map)`
registers. Calling `emit` without a prior `defineNotifications` is a no-op at runtime.

### `NotificationSpec` has no `title`/`icon` — by design

`NotificationSpec` is `{ intent, toMessage? }` — deliberately no `title`/`icon` field. Those stay
per-call `NotifyOptions` (`emit(kind, payload, { title: '…' })` or `notify({ ..., title: '…' })`),
so a title that varies per call site isn't forced into the registry. If every call to a given kind
repeats the same title, pass it at each call site — there's no registry-level default to fall back
on.

### Colors beyond the 4 intents live outside the registry

`notify`/`emit` only resolve `intent` to one of the four Mantine colors (§ Intent → Mantine color
above) — there's no `intent` override and no raw-color escape in `NotifyOptions`. A feature needing
per-category colored toasts beyond `success`/`info`/`warning`/`error` (e.g. achievement toasts keyed
by achievement type) cannot ride the typed registry. The documented stance: call Mantine's raw
`notifications.show({ color, ... })` directly, outside `notify`/`emit`. The cost is explicit — a
raw `notifications.show` toast is invisible to the persisted history store, the bell, and the
notification center, since only `notify`/`notifyPromise` record to history.

## Notification history store

Every `notify()` / `notifyPromise()` call records to a module-level persisted external store
(own `useSyncExternalStore` + versioned `{ v, value }` envelope under `basalt:notifications` in
localStorage). The store is **not** hook-scoped — `add`, `markRead`, `markAllRead`, `clear` are
module-level and callable outside React.

Ring-buffer cap: 50 items. Items store `{ id, intent, title?, message, createdAt, readAt? }` —
**message and title are strings** (ReactNode is not serializable). Cross-tab sync via the
`storage` event.

### useNotificationHistory

```ts
import { useNotificationHistory } from 'basalt-ui/notifications'

const { items, unreadCount, markRead, markAllRead, clear } = useNotificationHistory()
```

| Field           | Type                        | Description                                |
| --------------- | --------------------------- | ------------------------------------------ |
| `items`         | `NotificationHistoryItem[]` | All history (newest first, ring-buffer 50) |
| `unreadCount`   | `number`                    | Items with no `readAt`                     |
| `markRead(id)`  | `(id: string) => void`      | Mark one item read                         |
| `markAllRead()` | `() => void`                | Mark all items read                        |
| `clear()`       | `() => void`                | Clear all history                          |

## NotificationBell

A Mantine `ActionIcon` + `Indicator` showing unread count. Opens a `NotificationCenter` in a
`Popover`. Marks all items read when the center opens. Designed for the shell `globalActions` slot.

```tsx
import { NotificationBell } from 'basalt-ui/notifications'
import { BasaltShell } from 'basalt-ui'
;<BasaltShell globalActions={<NotificationBell />} {...rest} />
```

The bell renders a bell SVG icon (no `@tabler/icons` dependency — icons are ReactNode per house
rules). The unread indicator is capped at `9+` for counts above 9.

## NotificationCenter

Lists history items (title, message, relative time, unread dot) with "Mark all read" and "Clear"
actions. Consumes `useNotificationHistory`. Composable — mount it inside any Popover, Drawer, or
panel:

```tsx
import { NotificationCenter } from 'basalt-ui/notifications'
import { Drawer } from '@mantine/core'
;<Drawer opened={opened} onClose={close} title="Notifications">
  <NotificationCenter maxHeight={500} />
</Drawer>
```

`NotificationBell` uses `NotificationCenter` internally. Mount `NotificationCenter` directly only
when you need a custom container (e.g. a full-page notifications view or a custom Drawer).

## Deferred (not yet shipped)

The following features are advisory notes for future work — they are NOT part of the current battery:

- **Web Push** (`usePushSubscription` + `sw.js` + Elysia push route): server-side push delivery
  for background notifications. Requires a service worker, a push endpoint, and a vapid key.
- **Visibility-aware delivery buffering**: buffer toasts while the tab is hidden (`document.hidden`)
  and flush on `visibilitychange` — prevents lost toasts when the tab is backgrounded.
- **IntersectionObserver per-item mark-seen**: replace the mark-read-on-open approach with
  per-item IntersectionObserver so only viewed items are marked read (higher fidelity).
- **Cross-device read-sync**: propagate `readAt` via an Elysia endpoint so read state syncs
  across browser sessions (requires auth and a backend store).
- **Quiet hours**: suppress non-error toasts during a configurable time window.

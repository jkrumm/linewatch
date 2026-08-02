---
source: basalt-ui
description: Command bus, overlay controller, Spotlight projection, shortcuts display, and composable overlay mount from the shipped ./commands battery. @mantine/modals + @mantine/spotlight are optional peers; @mantine/notifications is already a peer from ./notifications.
paths:
  - 'src/**'
  - 'apps/**/src/**'
---

# Basalt Commands

basalt-ui ships `./commands` — a Mantine-coupled command bus + overlay controller battery providing
`defineCommands`, `runCommand`, `defineOverlays`, `overlays`, `toSpotlightActions`,
`toShortcutList`, `ShortcutsHelp`, and `BasaltOverlays` on top of `@mantine/modals` and
`@mantine/spotlight`. Both are **optional peers** — install them before using this battery. The
default `BasaltOverlays` also mounts `<Notifications>` (or pass `notifications={false}`), so
`@mantine/notifications` is needed too:

```bash
bun add @mantine/modals @mantine/spotlight @mantine/notifications
```

Also import Spotlight styles in `main.tsx` — use the **layered** bundle, since the unlayered one
outranks basalt's `@layer basalt` styles regardless of specificity:

```tsx
import '@mantine/spotlight/styles.layer.css'
```

## Mount BasaltOverlays

`BasaltOverlays` is the composable overlay mount — it bundles `ModalsProvider`, `Spotlight`, and
`Notifications` into a single mount point. Put it inside `BasaltProvider`, before the router. It
**replaces** `<BasaltNotifications />` from `basalt-ui/notifications` — do NOT mount both in the
same tree (that would double-mount `<Notifications />`).

```tsx
import { BasaltOverlays } from 'basalt-ui/commands'
import { BasaltProvider } from 'basalt-ui'
import '@mantine/spotlight/styles.layer.css'

createRoot(root).render(
  <BasaltProvider>
    <BasaltOverlays>
      <App />
    </BasaltOverlays>
  </BasaltProvider>,
)
```

Each layer is enabled by default; pass `false` to disable:

```tsx
<BasaltOverlays spotlight={false} notifications={false}>
  <App />
</BasaltOverlays>
```

## defineCommands + runCommand

`defineCommands` is a const-generic factory (mirrors `defineSeries`/`defineNotifications`) for
typed command registries. Augment `BasaltRegister.commands` once, then use `runCommand` — unknown
ids are tsc errors.

```ts
// commands.ts (app-side) — define and augment once:
import { defineCommands } from 'basalt-ui/commands'

export const COMMANDS = defineCommands({
  'file:save': { label: 'Save file', group: 'File', shortcut: 'Mod+S', run: () => save() },
  'file:open': { label: 'Open file', group: 'File', shortcut: 'Mod+O', run: () => open() },
  'data:sync': { label: 'Sync data', group: 'Data', run: async () => sync() },
  'help:docs': { label: 'Open docs', group: 'Help', run: () => window.open('/docs') },
  'edit:focus': {
    label: 'Focus editor',
    group: 'Edit',
    shortcut: 'Mod+E',
    when: () => isEditorPage(), // hides from palette when not on editor page
    run: () => focusEditor(),
  },
})

declare module 'basalt-ui' {
  interface BasaltRegister {
    commands: typeof COMMANDS
  }
}
```

```ts
// usage.ts — typed runCommand; unknown ids are tsc errors:
import { runCommand } from 'basalt-ui/commands'

runCommand('file:save') // ✓ sync
await runCommand('data:sync') // ✓ async
runCommand('nonexistent') // ✗ tsc error
```

### CommandId + CommandRunContext

`CommandId` is `Extract<keyof Slot<'commands', CommandMap>, string>`.
Un-augmented: `never` → `runCommand` is effectively uncallable.
Augmented: the exact registered key literal union.

`CommandRunContext` is minimal (`{ close?: () => void }`) — pass it to close the command palette
before executing:

```ts
runCommand('file:save', { close: () => spotlight.close() })
```

### CRITICAL — runtime stash pattern

The `BasaltRegister` slot augmentation is **type-only and erased at runtime**. `defineCommands`
stashes the spec map in a module-level `activeCommands` variable; `runCommand` reads from THAT
stash — NOT from `{} as Commands`. This is the same pattern as `defineNotifications` / `emit`.
Always call `defineCommands` once before any call to `runCommand` (typically imported at app boot).

### TS circular-inference footgun

Calling `overlays.open(...)` inside a `run` handler, in the **same module that also augments**
`BasaltRegister.commands` (i.e. the file with `declare module 'basalt-ui' { interface
BasaltRegister { commands: typeof COMMANDS } }`), can trip TS into inferring `COMMANDS` as
`implicitly has type 'any'` — the `run` return type and the `commands` slot type end up in a
circular inference loop. Fix: give that `run` an explicit `: void` (or `: Promise<void>` for async)
return annotation. Prefer splitting overlay-opening commands into a separate file from the
`defineCommands`/`declare module` augmentation when practical — it sidesteps the cycle entirely.

## defineOverlays + overlays

`defineOverlays` registers ephemeral modal overlays. `overlays.open` is the imperative controller.

```ts
// overlays.ts (app-side) — define and augment once:
import { defineOverlays } from 'basalt-ui/commands'

export const OVERLAYS = defineOverlays({
  'user:edit': {
    title: 'Edit user',
    render: (p: { id: string; name: string }) => <UserEditForm id={p.id} name={p.name} />,
  },
  'confirm:delete': {
    title: 'Delete item?',
    render: (p: { name: string }) => <ConfirmBody name={p.name} />,
  },
})

declare module 'basalt-ui' {
  interface BasaltRegister { overlays: typeof OVERLAYS }
}
```

```ts
// usage.ts — typed overlays.open; unknown keys are tsc errors:
import { overlays } from 'basalt-ui/commands'

overlays.open('user:edit', { id: '42', name: 'Alice' }) // ✓ typed
overlays.open('confirm:delete', { name: 'photo.jpg' }) // ✓
overlays.open('nonexistent', {}) // ✗ tsc error
overlays.close() // close all open modals
```

`OverlayKey` is `Extract<keyof Slot<'overlays', OverlayMap>, string>`.
The same runtime-stash pattern applies — `defineOverlays` stashes to `activeOverlays`.

### Imperative vs route (when to use each)

| Use `overlays.open`                   | Use route mask (`./router-tanstack`)       |
| ------------------------------------- | ------------------------------------------ |
| Ephemeral confirms, quick-edit panels | Shareable/back-button/refreshable overlays |
| No URL needed                         | URL-addressable dialogs                    |
| Triggered from commands or buttons    | Triggered by navigation                    |

## Spotlight projection (toSpotlightActions)

`toSpotlightActions()` projects the active command registry to `SpotlightActionData[]` for Mantine
Spotlight. Commands where `when()` returns `false` are excluded. `BasaltOverlays` calls it
automatically with `shortcut="mod + K"`.

```ts
import { toSpotlightActions } from 'basalt-ui/commands'
import { Spotlight, spotlight } from '@mantine/spotlight'

// Manual Spotlight mount (if not using BasaltOverlays):
<Spotlight actions={toSpotlightActions()} shortcut="mod + K" />

// Programmatically open the palette:
spotlight.open()
```

## Shortcut display (toShortcutList + ShortcutsHelp)

`toShortcutList()` returns commands with a `shortcut` field as a flat list. `ShortcutsHelp`
renders them in a grouped Mantine layout with platform-aware labels (⌘ on mac, Ctrl elsewhere).

**Display + live binding.** `ShortcutsHelp` renders the shortcuts for reference, and the same
`shortcut` field is bound to live keys by `useCommandHotkeys()` (via the `@tanstack/react-hotkeys`
optional peer). Spotlight `mod + K` covers the palette trigger.

```tsx
import { ShortcutsHelp } from 'basalt-ui/commands'

// In a help modal or settings panel:
;<ShortcutsHelp title="Keyboard shortcuts" maw={480} />
```

```ts
import { toShortcutList } from 'basalt-ui/commands'
const list = toShortcutList()
// [{ id: 'file:save', label: 'Save file', shortcut: 'Mod+S', group: 'File' }, ...]
```

## Live keybindings (useCommandHotkeys)

`useCommandHotkeys()` binds all registered command shortcuts to their `run()` functions via
`@tanstack/react-hotkeys`. It is an **optional-peer** hook — degrades to a no-op when the peer is
absent; core resolves cleanly either way. No `HotkeysProvider` wrapper is required.

Install the optional peer:

```bash
bun add @tanstack/react-hotkeys
```

### Mount pattern

**BasaltOverlays mounts it automatically** (via the internal `HotkeysMount` component) when
`hotkeys={true}` (default). No extra setup needed if using `BasaltOverlays`.

For manual mounting, call `useCommandHotkeys()` once in the component tree, after `defineCommands`:

```tsx
import { useCommandHotkeys } from 'basalt-ui/commands'

function App() {
  // Activate all registered command shortcuts — call once per tree, not per-command.
  useCommandHotkeys()
  return <RouterProvider router={router} />
}
```

If you want hotkeys active only on a specific page:

```tsx
function EditorPage() {
  useCommandHotkeys()
  return <EditorLayout />
}
```

### toHotkeyBindings

`toHotkeyBindings()` projects the command registry into the `UseHotkeyDefinition[]` array that
`useHotkeys` from `@tanstack/react-hotkeys` expects. Commands without a `shortcut` are skipped.
Commands where `when()` returns false at press time are silently skipped.

```ts
import { toHotkeyBindings } from 'basalt-ui/commands'
import { useHotkeys } from '@tanstack/react-hotkeys'

// Manual binding — equivalent to useCommandHotkeys() but you control the options:
function MyHotkeys() {
  useHotkeys(toHotkeyBindings(), { preventDefault: true })
}
```

### Shortcut string format

Shortcut strings use the `Mod+Key` convention: `Mod` resolves to `⌘` on macOS and `Ctrl`
elsewhere. The `@tanstack/hotkeys` package handles platform resolution at runtime.

```ts
defineCommands({
  'file:save': { label: 'Save', shortcut: 'Mod+S', run: () => save() },
  'file:close': { label: 'Close', shortcut: 'Mod+W', run: () => close() },
  'edit:find': { label: 'Find', shortcut: 'Mod+F', run: () => find() },
  'view:zoom': { label: 'Zoom', shortcut: 'Mod+Shift+Z', run: () => zoom() },
})
```

## Spotlight live store (basaltSpotlight)

`BasaltOverlays` mounts Spotlight against a basalt-owned store (`createSpotlight()` singleton).
Import `openSpotlight` / `closeSpotlight` from `basalt-ui/commands` instead of Mantine's global
`spotlight` to target this instance:

```ts
import { openSpotlight, closeSpotlight } from 'basalt-ui/commands'

// Open the palette programmatically:
openSpotlight()

// From a command handler (close palette, then run):
runCommand('palette:open', { close: () => closeSpotlight() })
```

Spotlight actions are synced from the registry via `toSpotlightActions()` at mount time. Shortcuts
displayed in the Spotlight action description are platform-formatted via `formatShortcutDisplay`
(`⌘S` on mac, `Ctrl+S` on windows).

## defineOverlay (single-overlay helper)

Mirror of `defineCommand` — types a single overlay without registering it. Use when splitting
overlay definitions across files.

```ts
import { defineOverlay } from 'basalt-ui/commands'

const confirmDelete = defineOverlay<{ name: string }>({
  title: 'Confirm delete',
  render: ({ name }) => <Text>Delete "{name}"?</Text>,
})
// Then include in defineOverlays({ 'confirm:delete': confirmDelete })
```

WARNING: `defineOverlay` only TYPES — it does NOT register. Only `defineOverlays(map)` registers.

## Deferred

- **`SidebarItem.command?: CommandId`** — cross-ref between the shell sidebar and the command bus
  is a later integration step. Do not add it now.

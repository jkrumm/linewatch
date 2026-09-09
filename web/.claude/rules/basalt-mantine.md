---
source: basalt-ui
description: Mantine v9 conventions for basalt-ui apps — provider and overlay mount order, the shell's props, surfaces and depth, scroll regions, motion. Mostly enforced by construction via createBasaltTheme.
paths:
  - 'src/**'
  - 'apps/**/src/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `bun scripts/check-coverage.ts --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — card-with-border, hidden-inline-style, in-body-page-title, inline-display, inline-spacing, mantine-shade-index, raw-form-control, raw-html-layout, raw-motion-value, raw-spacing, sub-16-input-font · oxlint rules — basalt/card-inset, basalt/deprecated-export, basalt/hand-rolled-shell, basalt/in-body-page-title, basalt/no-import-meta-env, basalt/page-bar-budget, basalt/provider-above-router, basalt/raw-scroll-container, basalt/shadow-basalt-export -->
<!-- not guarded: no second cssVariablesResolver — don't hand-build createTheme or re-add the resolver basalt already installs -->
<!-- /basalt:coverage -->

# Basalt Mantine — provider, shell, surfaces

`createBasaltTheme` + `BasaltProvider` encode the theming opinion **by construction**; this rule is
the part the framework cannot enforce in code. The identity itself and every color/spacing/type law
live in basalt-tokens.md — not restated here.

## Provider and overlay mount

Mount `BasaltProvider` at the top of the tree, **above the router** (Mantine's context must exist
before any route renders), with `theme={createBasaltTheme(overrides)}`. Then the data layer, then
`RouterProvider`. Don't hand-build `createTheme` and don't add a second `cssVariablesResolver`. The
canonical composition — `BasaltProvider > QueryClientProvider > BasaltOverlays > RouterProvider`,
and why that order is load-bearing — is the README's "Composition order" section; don't restate the
tree here. No `'use client'` directive ships in the package; a Next.js App Router consumer wraps
the composition in its own client file.

**Overlays mount exactly once, through `BasaltOverlays`** (`basalt-ui/commands`), inside
`BasaltProvider`: it composes `ModalsProvider`, Spotlight (against basalt's own store), the command
hotkeys and `<Notifications>` in one place, each disableable with `false`. `ModalsProvider` mounts
as a **sibling** of `children`, not a wrapper — the imperative `modals.*`/`overlays.*` API works
untouched, but `useModals()`/`openContextModal` need real React context, which a sibling cannot
provide: pass `modals={false}` and mount your own `ModalsProvider` when you need either.
`<BasaltOverlays notifications />` is the ONE notifications mount; there is no standalone
component any more. Import the **layered** style bundle for every `@mantine/*` battery, then
`basalt-ui/styles.css` last.

Color scheme is read and written through `useMantineColorScheme()` only — never a client store,
never `localStorage.getItem('theme')` (guard-enforced; see basalt-state.md).

## The shell — one mount, declared data

`BasaltShell` composes `AppSidebar` / `MobileNav` / `AppBreadcrumbs` / `PageBar` and is the canonical
single mount (`basalt/hand-rolled-shell` fires on `AppShell.*` parts or a `Burger` in a file that
does not render it). The sub-components are exported for a genuinely divergent layout; prefer the
shell, which already wires collapse persistence, the mobile breakpoint and the breadcrumb.

Every extension point is **declared data, not a `ReactNode` slot**, so basalt owns the mobile
projection:

| Prop                | Shape                                | What basalt then owns                                                                  |
| ------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| `sections`          | `SidebarSection[]`                   | the desktop sidebar AND the mobile bar (`projectMobileNav`) — one definition           |
| `globalActions`     | `GlobalAction[]`                     | header placement; the first two ride the mobile bar, the rest fold into ONE kebab      |
| `sidebarBlocks`     | `SidebarBlock[]`                     | rail projection (dot / ring), fold persistence, one More-sheet row per block (law C13) |
| `brand`             | `BrandConfig & { menu? }`            | a `Name ▾` workspace switcher when `menu` is present                                   |
| `search`            | `SidebarSearchConfig & { actions? }` | the ⌘K row plus one or two icon buttons (a tuple by type)                              |
| `settingsMenuItems` | `SettingsMenuItem[]`                 | flat footer rows at three or fewer, one gear menu above that                           |
| `account`           | `BasaltAccountProps`                 | the footer row, below the settings menu                                                |

- **The router seam is ONE component, not a render callback.** `SidebarItem.Anchor` (a `NavAnchor`)
  is the consumer's `<Link>`; absent, the row falls back to `<a href>` + `onClick`. The
  breadcrumb's equivalent is `parentAnchor`. No `renderNavLink`/`renderBreadcrumbLink` surface.
- **`AppBreadcrumbs` is prop-driven** (`section`/`parent`/`parentAnchor`/`parentHref`/`page`),
  renders `null` without `page`; `useRouterBreadcrumbs` (basalt-state.md) sources a custom trail.
- **Collapse persists through `createPersistedState`**, keyed `basalt:<storageKey>` — read with
  `readPersistedValue`, never a bare `localStorage.getItem`.
- **The account row is presentational, provider-agnostic** — no `./auth`. Authenticated leads with
  initials from `identity.name` (never an avatar image); unauthenticated falls back to a glyph.

**Mobile is a tab bar, not a menu.** A slot is a destination — a tap navigates with nothing to
dismiss, no full-height drawer. `projectMobileNav` is a PURE projection inferring the surface from
row count (0 drops the slot, 1 is a plain link, up to `menuMax` is a menu, more is a sheet).
`SidebarItem.mobile` (`'tab'`/`'more'`/`'hidden'`) is the per-destination placement. The active
indicator is a **neutral** ink tint behind the icon only (never the identity blue); the bar carries
**no** `env(safe-area-inset-bottom)` (Mantine's `AppShell.Footer` already grows the box). Region
edges come from `BasaltShell` itself (`--app-shell-border-color` → `--vx-divider`) — never draw a
border or pass `withBorder` to a shell region yourself.

## Surfaces, depth and shape

Depth-tier law (which token for which surface, why static, why the ring is inset) is
`docs/DESIGN-CORE.md` § Layout, elevation, shapes — not restated here. Mantine-specific facts only:

- **Never pass `withBorder` to a `Card`/`Paper`** — the theme pins bg/shadow/radius but does not
  clear `border`, so `withBorder` draws a second real edge (`card-with-border` guard kind).
  `<Card.Section withBorder>` is a section divider and fine.
- **The ring lands on the box carrying the surface's `border-radius`** — `ChartCard` puts the
  shadow on a box with no background (an inner box paints the fill; `overflow: hidden` on the
  shadowed box would clip the shadow otherwise).
- **Use Mantine primitives, not raw HTML** — `Box`/`Flex`/`Grid`/`Stack`/`Group`/`Paper`/`Card`
  over a `<div>` with an inline style; a CSS module reading `var(--vx-*)` is the sanctioned second
  fix in row code. Only Mantine-free `src/charts/**` uses raw `<div>` freely.
- **Inputs come from `@mantine/core`**, never a native `<select>` — the form tier's font size
  clears the iOS zoom threshold via an `!important` floor (`sub-16-input-font` flags a smaller one).
- **Charts measure themselves** — pass `height`/`aspectRatio`/`fill` only; never `useElementSize`
  in a chart file (Mantine is banned there), never raw `@visx/responsive` outside `charts/**`.

## Scroll regions

**A scroll region inside app chrome is a Mantine `ScrollArea`, not a raw `overflow: auto` box** —
it draws its own bar inside its root, so the bar floats instead of reflowing the column
(`AppSidebar`'s nav is the reference: `type="hover"`, `scrollbars="y"`). Raw `overflow: auto` stays
correct only where a library owns the node (`BasaltStickToBottom`, `BasaltVirtualList`) and for a
table body (`Table.ScrollContainer type="native"` — a `ScrollArea` viewport would break a sticky
`<thead>`'s positioning context).

## Interaction feedback and motion

Every action button confirms itself: the `loading` prop in flight, a brief label flip
(`Save → Saved`) via Mantine's `<Transition>`, and a toast ONLY for an outcome the user might miss.
Destructive actions confirm through `modals.openConfirmModal` first.

- **Timing is a token, never a literal** — `MOTION_DURATION`/`MOTION_SPRING`/`MOTION_EASE_STANDARD`
  (`raw-motion-value` enforces it). Animate `transform`/`opacity`/`color`, never a layout property.
- **Import from `motion/react`, never `framer-motion`** — exact-pinned optional PEER. Mantine's
  `<Transition>` for a mount fade; `motion` for a crossfade, spring or gesture.
- **Always branch on `useReducedMotion`** with a real unanimated path, not just `duration: 0`
  (`ThemeToggle` is the pattern). Restraint applies to motion too — no looping idle animation.

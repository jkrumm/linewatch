---
source: basalt-ui
description: Mantine v9 conventions for basalt-ui apps — provider and overlay mount order, the shell's props, surfaces and depth, scroll regions, motion. Mostly enforced by construction via createBasaltTheme.
paths:
  - 'src/**'
  - 'apps/**/src/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `basalt-ui check-coverage --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — card-with-border, hidden-inline-style, in-body-page-title, inline-display, inline-spacing, mantine-shade-index, raw-form-control, raw-html-layout, raw-motion-value, raw-spacing, sub-16-input-font · oxlint rules — basalt/card-inset, basalt/hand-rolled-shell, basalt/in-body-page-title, basalt/page-bar-budget, basalt/raw-scroll-container, basalt/shadow-basalt-export -->
<!-- not guarded: — -->
<!-- /basalt:coverage -->

# Basalt Mantine — provider, shell, surfaces

`createBasaltTheme` + `BasaltProvider` encode the theming opinion **by construction**; this rule is
the part the framework cannot enforce in code. The identity itself and every color/spacing/type law
live in basalt-tokens.md — not restated here.

## Provider and overlay mount

Mount `BasaltProvider` at the top of the tree, **above the router** (Mantine's context must exist
before any route renders), with `theme={createBasaltTheme(overrides)}`. Then the data layer, then
`RouterProvider`. Don't hand-build `createTheme` and don't add a second `cssVariablesResolver`.

**Overlays mount exactly once, through `BasaltOverlays`** (`basalt-ui/commands`), inside
`BasaltProvider`: it composes `ModalsProvider`, Spotlight (against basalt's own store), the command
hotkeys and `<Notifications>` in one place, each disableable with `false`. A standalone
`<BasaltNotifications />` (`basalt-ui/notifications`) is the alternative for an app with no commands
layer — **never both in one tree**, which double-mounts `<Notifications>`. Import the **layered**
style bundles for every `@mantine/*` battery, then `basalt-ui/styles.css` last; an unlayered Mantine
import outranks `@layer basalt` regardless of specificity.

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
  is the consumer's `<Link>`; basalt renders every pixel around it — desktop row, mobile slot, sheet
  row. Absent, the row falls back to `<a href>` + `onClick`. The breadcrumb's equivalent is
  `parentAnchor`. There is no `renderNavLink` / `renderBreadcrumbLink` surface.
- **`AppBreadcrumbs` is prop-driven** (`section` / `parent` / `parentAnchor` / `parentHref` /
  `page`) and renders `null` without `page`. `BasaltShell` derives those props from the active item;
  `useRouterBreadcrumbs` (basalt-state.md) is the router-side source for a custom trail.
- **Collapse persists through basalt's own `createPersistedState`**, keyed `basalt:<storageKey>` —
  read it with `readPersistedValue`, never a bare `localStorage.getItem`. Pass `collapsed` +
  `onCollapsedChange` to own it instead (e.g. from your own hotkey — basalt binds none).
- **The `.` entry is router-agnostic; a router adapter DOES ship**, at `./router-tanstack`. Badge /
  active / navigate wiring stays consumer-side either way; `NavCountBadge` is the count pattern.
- **The account row is presentational over a provider-agnostic contract** — basalt has no auth
  dependency and ships no `./auth`. The authenticated row leads with initials derived from
  `identity.name` (never an avatar image); the unauthenticated row falls back to a person glyph.
  No separating hairline: the row's own top padding is the separation. The email is hidden unless
  `showEmail` is passed.

**Mobile is a tab bar, not a menu.** A slot is a destination, so a tap navigates with nothing to
dismiss; there is no full-height mobile drawer, and everything it used to hold reaches the trailing
More slot. `projectMobileNav` is a PURE projection and infers the surface from row count — 0 drops
the slot, 1 collapses to a plain link (a group of one IS a destination), up to `menuMax` is a menu,
more is a bottom sheet. `SidebarItem.mobile` (`'tab'` / `'more'` / `'hidden'`) is the per-destination
placement; `MobileNavConfig` is the escape hatch, not the interface. Two bar rules that look like
bugs and are not: the active indicator is a **neutral** ink tint behind the ICON only (never the
identity blue, never a full-tab fill — the desktop sidebar's accent-icon rule does not apply here),
and the bar carries **no** `env(safe-area-inset-bottom)` padding, because Mantine's own
`AppShell.Footer` rule already grows the box by the inset. Search lives in the SIDEBAR, not the
header; the header carries no bottom rule. "Zero horizontal rules" is not true of the mobile bar,
which has a top border by design.

## Surfaces, depth and shape

- **Never pass `withBorder` to a `Card`/`Paper`.** Card depth is `VX.shadowCard`, which bakes its 1px
  ring into the shadow value; the theme pins bg/shadow/radius but does not clear `border`, so
  `withBorder` draws a second real edge and the card reads heavy. It is on-token, so only the
  `card-with-border` guard kind catches it. `<Card.Section withBorder>` is a section divider and fine.
- **Three depth tiers, split control-vs-panel-vs-floating**, and the dividing line is that split —
  never component-by-component. `shadowCard` for surfaces that HOLD content (Card, Paper,
  Notification, ChartCard, SettingsSection): an outset ring on light, a deeper drop + inset rim on
  dark. `shadowRaised` for anything you click or type into: **never an outset ring**, because an
  outset ring paints in the color of whatever it is drawn over, so one value can ride a saturated
  fill, a tint and a panel alike. `shadowOverlay` for detached floating surfaces (Tooltip, Popover,
  Menu, Combobox, Modal, Drawer). Focus is a fourth tier and LAYERS over the resting depth.
- **Emphasis is fill weight, not depth.** Every box-owning Button/ActionIcon variant takes the same
  resting depth; `outline` takes the ring-free `shadowCtrl` (its border is its edge) and `subtle` is
  **flat in both states** — a text affordance, with a neutral ink tint as its hover and nothing more.
  **Depth is static**: no variant lifts or gains a shadow on hover or press. A hover lift and a
  materializing `subtle` shadow were both tried and reverted.
- **The ring must land on the box that carries the surface's `border-radius`** — it is drawn by that
  box's own corners. `ChartCard` legitimately puts the shadow on a box with no background (an inner
  box paints the fill, because `overflow: hidden` on the shadowed box would clip the shadow).
- **Use Mantine primitives, not raw HTML** — `Box`/`Flex`/`Grid`/`SimpleGrid`/`Stack`/`Group`/
  `Paper`/`Card` instead of a `<div>` with an inline `style`. **The second sanctioned fix is a CSS
  module**, and in row code it is the right one: what the guard objects to is the inline literal, not
  the `<div>`, and a class reading `var(--vx-*)` costs no component instance per row. `check-theme`
  scans `.css`, so the tokens stay policed there. Only the Mantine-free `src/charts/**` may use raw
  `<div>` freely — still with `VX.*`.
- **Inputs come from `@mantine/core`**, never a native `<select>`; the theme defaults them to the
  form tier, whose font size clears the iOS zoom threshold, and the floor in `styles.css` is
  `!important` (`sub-16-input-font` flags a smaller one as dead code against it).
- **Charts measure themselves** — pass `height` / `aspectRatio` / `fill` and nothing else. Never
  `useElementSize` inside a chart file (Mantine is banned there), never raw `@visx/responsive`
  outside `charts/**`.

## Scroll regions

**A scroll region inside app chrome is a Mantine `ScrollArea`, not a raw `overflow: auto` box** — it
draws its own bar inside a `position: relative; overflow: hidden` root, so the bar floats instead of
reserving gutter width and reflowing the column. `AppSidebar`'s nav is the reference (`type="hover"`,
`scrollbars="y"`, the flex fill on the ScrollArea root). `styles.css` re-hides the native bar on the
viewport, so **one overlay bar** is the framework-wide outcome — do not re-theme it.

Raw `overflow: auto` stays correct where a library owns the scroll node (`BasaltStickToBottom`,
`BasaltVirtualList`) and for a table body, which is `Table.ScrollContainer type="native"` — a
`ScrollArea` viewport is the positioning context a sticky `<thead>` resolves against, so the default
type pins the header to the page viewport instead of the table's box.

## Interaction feedback and motion

Every action button must confirm itself — silent success reads as broken. Three layers, together:
the `loading` prop while in flight; a brief flip on the trigger itself (label `Save → Saved`,
`color="green"`, a check revealed through Mantine's `<Transition>`), held about a second; and a toast
ONLY for an outcome the user might miss (an off-screen write, an error, background work). The user's
eye is on the thing they clicked. Destructive actions confirm through `modals.openConfirmModal`
first; form errors are inline, and a toast covers only submit-level failure.

- **Timing is a token, never a literal.** `MOTION_DURATION` / `MOTION_SPRING` /
  `MOTION_EASE_STANDARD` from `basalt-ui`; the duration cap is the same interaction-feedback ceiling
  above (`raw-motion-value` enforces it). Never animate a layout-shifting property — move
  `transform`, `opacity`, `color`, `background`.
- **Import from `motion/react`, never `framer-motion`** (`no-restricted-imports`, repo and shipped).
  `motion` is an exact-pinned optional PEER, not a bundled dependency. Reach for Mantine's own
  `<Transition>` for a simple mount fade; reach for `motion` when the interaction needs a crossfade
  between two elements, spring physics or a gesture.
- **Always branch on `useReducedMotion`** (`@mantine/hooks`) with a real unanimated code path — no
  `motion.*` wrapper at all, not just `duration: 0`. `ThemeToggle` is the pattern.
- **Restraint applies to motion too.** A state change earns a transition; idle chrome does not.
  Never a looping or pulsing idle animation.

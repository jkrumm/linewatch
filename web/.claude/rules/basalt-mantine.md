---
source: basalt-ui
description: Mantine v9 in a basalt-ui app — provider, shell, surfaces, scroll, breakpoints, motion.
paths:
  - 'src/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `bun scripts/check-coverage.ts --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — card-with-border, hidden-inline-style, in-body-page-title, inline-display, inline-spacing, mantine-shade-index, raw-form-control, raw-html-layout, raw-media-query, raw-motion-value, raw-spacing, sub-16-input-font · oxlint rules — basalt/card-inset, basalt/hand-rolled-shell, basalt/in-body-page-title, basalt/raw-breakpoint, basalt/raw-scroll-container, basalt/route-view-transition, basalt/shadow-basalt-export -->
<!-- not guarded: no second cssVariablesResolver — don't hand-build createTheme or re-add the resolver basalt already installs -->
<!-- /basalt:coverage -->

# Basalt Mantine

`BasaltProvider` and `BasaltShell` mount the whole app; compose them, never their parts.

## Provider

- Mount once: `createBasaltRouter({ routeTree })`, then `<BasaltProvider router={router} />`; in a router you do not own (TanStack Start root route) pass `children` instead, with `context.queryClient`. `spotlight={false}` for an app with its own Cmd+K. It owns Mantine, Query and notifications; Spotlight mounts once `defineNav`/`defineCommands` ran, `ModalsProvider` (a sibling, no `useModals()` context) once `defineOverlays`/`overlays.confirm` ran. [type BasaltProvider]
- Never pass `cssVariablesResolver` to `BasaltProvider`; retune with `theme={createBasaltTheme(...)}`. [type BasaltProvider]
- Read and write the color scheme with `useMantineColorScheme()` only. [check-theme localstorage-theme]

## Shell

- One `BasaltShell nav={NAV}` in `__root.tsx` wraps `<Outlet />`; never build `AppShell.*` parts or a `Burger`, and never wrap `<Outlet />` in `<ViewTransition>` (the router animates route changes in nav order). [basalt/hand-rolled-shell] [basalt/route-view-transition]
- Shell extensions are typed data props (`globalActions`, `sidebarBlocks`, `brand`, `search`, `settingsMenuItems`, `account`), never `ReactNode` slots. [type BasaltShell]
- Pass no `renderNavLink`, `renderBreadcrumbLink` or `withBorder`; the shell resolves links against the router and draws region edges. [type BasaltShell]
- A page is named once, by its nav item's `label` (the breadcrumb), `PageBar.title` (no shell) or `PageTitle` (shell-less screen); no in-body `<Title order={1|2}>`. [basalt/in-body-page-title] [check-theme in-body-page-title]; a shell page renders `<PageBar />` only to fill a slot (`actions`, `sync`, `tabs`, `filters`) and its `title` is ignored there. [type PageBar]
- A nav item's mobile placement is its `mobile` field: `'tab'`, `'more'` or `'hidden'`. [type defineNav]

## Surfaces

- Never pass `withBorder` to `Card` or `Paper`; the theme draws the ring (`<Card.Section withBorder>` is fine). [check-theme card-with-border]
- The theme owns the Card/Paper inset (12/16) and radius: write no `p`, `padding`, `py`, `px` or `radius`, not even `py="sm" px="md"`. Flush is `variant="flush"` (whole card) or `<Card.Section>` (a full-bleed region). [basalt/card-inset]
- Lay out with `Box`/`Flex`/`Grid`/`Stack`/`Group`, not a `<div>` with `style`. [check-theme raw-html-layout] [check-theme hidden-inline-style]
- No inline `display: flex|grid`; no inline spacing; spacing props take `xs..xl`. [check-theme inline-display] [check-theme inline-spacing] [check-theme raw-spacing]
- Inputs come from `@mantine/core`, never `<input>`, `<select>` or `<textarea>`. [check-theme raw-form-control]
- Never set a form control's font size below 16. [check-theme sub-16-input-font]

## Scroll and breakpoints

- A scroll region is a Mantine `ScrollArea`, not a raw `overflow: auto` box; a page that fills the scrollport sets `height: var(--basalt-main-content-h)`, never a hand-built `calc(100dvh - …)`. [basalt/raw-scroll-container]
- Never use `visibleFrom`/`hiddenFrom` or a raw `@media` width; chrome follows `useSizeClass()`, page layout follows container queries: `<SimpleGrid type="container" cols={{ base: 1, [CONTAINER_KEYS.regular]: 2 }} />` (`CONTAINER_KEYS` from `basalt-ui/tokens`), never `cols={{ base: 1, lg: 2 }}`. [basalt/raw-breakpoint] [check-theme raw-media-query]

## Motion

- Animation timing comes from basalt's motion tokens, never a literal duration, spring or easing. [check-theme raw-motion-value]

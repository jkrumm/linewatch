---
source: basalt-ui
description: Mantine v9 usage conventions for basalt-ui apps — provider order, the Vx bridge, component defaults, and interaction feedback. Partly enforced by-construction via createBasaltTheme.
paths:
  - 'src/**'
  - 'apps/**/src/**'
---

# Basalt Mantine — Usage Conventions

basalt-ui is a framework for Mantine v9 apps. `createBasaltTheme` and `BasaltProvider` encode most of
the theming opinion **by construction** — this rule covers the conventions the framework can't enforce
in code.

## Provider order

Mount `BasaltProvider` (which wraps `MantineProvider` + injects the palette `<style>` + bridges the Vx
tokens) at the top of the tree, before the router. A typical `main.tsx` stack, top to bottom:

1. `BasaltProvider` (Mantine + palette CSS + Vx bridge; pass `theme={createBasaltTheme(overrides)}`)
2. `Notifications` (from `@mantine/notifications`) — optional
3. `ModalsProvider` (from `@mantine/modals`) — optional
4. data layer (e.g. `QueryClientProvider`)
5. `RouterProvider`

Never wrap `BasaltProvider` inside the router — Mantine's context must be available before any route
renders.

## Theming

- Use `createBasaltTheme(overrides?)` for the theme — it merges your overrides over `baseTheme`
  (last-wins), so you can retune any field without forking. Don't hand-build `createTheme`.
- The theme reskins **every** Mantine accent to the modern-zinc identity (`docs/DESIGN-SPEC.md` in
  the basalt-ui repo) —
  **cool-neutral zinc** ramps on both light and dark — plus a **single saturated sky-blue accent**
  — split by role: as INK (links, active-nav icon, chart lines, focus ring) `#0077bd` light /
  `#8ec5ff` dark; as a FILLED SURFACE `#0077bd` in BOTH schemes with a white label — and binds
  Mantine's surface vars AND its color families to the same `--vx-*` tokens
  the charts use (`cssVariablesResolver`, pre-wired in `BasaltProvider`), so chrome and charts share
  one scheme-reactive identity. (Blueprint / Basalt zinc-charcoal are the historical hue-tuning
  ancestors; `docs/DESIGN-SPEC.md` in the basalt-ui repo supersedes both.) Don't add a second
  `cssVariablesResolver`.
- Color scheme: read/write via `useMantineColorScheme()`. **Never** read the color scheme from
  localStorage directly, and never `localStorage.getItem('theme')` — see basalt-state.md.
- Owned `spacing`/`radius` scales and the `fontWeights` ladder live in the theme — consume them as
  tokens (`p="md"`, `radius="sm"`, `fw="semibold"`), not raw numbers (see basalt-tokens.md).

## Color & accent restraint

Restraint is the #1 lever — neutrals carry the surface, the accent only points. The palette is
**one saturated sky-blue accent** over cool-neutral zinc; the neutrals do ~90% of the work
(60/30/10, pushed toward 90/10).

- **The accent appears ONLY on**: the primary data series, active-nav **icons** and active **child**
  labels, links, primary buttons, focus rings, and the leader bar in meters. It does **NOT** appear
  on borders, large fills, every icon, or secondary/routine buttons. Don't flood blue — "ink earns
  its color."
- **Active nav = an ink-9% tint** + an **accent-colored icon** + weight-600 ink text — **no panel
  fill and no shadow**. It is a _selected row_, not a raised control; a panel-filled, shadowed row
  reads as a button sitting in the nav rather than as the current location. Inactive = muted text,
  faint icon, hover ink-6%; an active row hovers one step further to ink-13%. This is baked into
  the theme's NavLink defaults (`--nl-*` vars) and holds for _every_ render path, including a
  consumer's router `<Link>` passed via `renderNavLink`. Child items indent with a 1px `divider`
  left border; active child = accent text, weight 600.
- **Buttons**: the primary action = filled accent (`variant="filled"`), **exactly one per view**.
  Every other/secondary action = `variant="default"` (neutral). Do **not** use a colored
  `variant="light"` for routine actions.
- **Status hues stay muted/forest.** Positive deltas use `color="green"` (forest green), never
  `color="teal"` (vivid turquoise) or a saturated emerald. Status (`red`/`green`/`orange`/`yellow`)
  is for signal only, kept muted — never raw Material/AntD.
- **Dark mode** is cool-neutral zinc (`#27272a`-family panels on a darker `#18181b`-mixed page) —
  not steel-blue, not pure black. Lift elevation via the depth tokens' whisper shadow + inset ring;
  the accent uses its lighter shade (`#8ec5ff`) on dark to avoid glow/bleed **as INK** — links,
  active-nav icons, chart lines, focus ring. A FILLED control is the opposite case: it keeps the
  deep `#0077bd` fill and a white label in both schemes, because a light fill cannot carry white
  text and a darker one fades into the dark page (<3:1). Fill with `--vx-accent-fill`, never
  `--vx-accent`.
- **Light mode** is never pure-white page + pure-black text (harsh halation). Page is a
  slightly-darker zinc mix (`#ececee`-ish) than the panel (`#f4f4f5`) so cards lift subtly off it;
  text = near-black ink (`#262626`). Depth comes from a whisper shadow with a 1px ring baked in
  (`shadow-card` for panels, `shadow-raised` for controls — see "Elevation, density & shape"), not
  a plain hairline border.

## Bridging Mantine ↔ charts

Charts are Mantine-free, but their color scheme must track Mantine's toggle. `BasaltProvider` already
bridges this. If you compose the providers manually, one — and only one — file may import both
`@mantine/core` and `basalt-ui/charts` to read the scheme and feed `VxThemeProvider`:

```tsx
import { useMantineColorScheme } from '@mantine/core'
import { VxThemeProvider } from 'basalt-ui/charts'

export function VxBridge({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useMantineColorScheme()
  const resolved = colorScheme === 'auto' ? 'dark' : colorScheme
  return <VxThemeProvider colorScheme={resolved}>{children}</VxThemeProvider>
}
```

Route components import chart primitives directly from `basalt-ui/charts` — never from the bridge file.

## Component conventions

- **Shell**: `BasaltShell` wraps every page (compose it once at the root). Don't add another shell
  inside a page. Wire nav badges with `NavCountBadge`.
- **Layout**: prefer `Stack`/`Group`/`SimpleGrid` over manual flex/grid CSS.
- **Notifications**: `notifications.show(...)` from `@mantine/notifications` — never roll a custom toast.
- **Modals**: `modals.openConfirmModal(...)` for destructive actions; `modals.open(...)` for forms.
- **Inputs**: from `@mantine/core` (`TextInput`, `Select`, `Combobox`, …). Don't use native `<select>`.
  The theme defaults inputs to `md` (16px font) so iOS Safari never zooms on focus. The floor
  (`styles.css`) is `!important` and mechanically enforced: `raw-form-control` flags any raw
  `<input>`/`<select>`/`<textarea>`, `sub-16-input-font` flags a sub-16 `fontSize` on a form control
  as dead code against the floor.
- **DatePickerInput**: from `@mantine/dates` (if you separately install it). In v9 it uses string
  values (`YYYY-MM-DD`) for `value`/`onChange` — no `Date` conversion.
- **Responsive chart sizing**: charts measure themselves — `CartesianChart`/`ChartFrame` do it,
  including reserving the legend band, so pass `height` / `aspectRatio` / `fill` and nothing else
  (see basalt-charts.md). `useChartSize` from `basalt-ui/charts` is for a non-chart box that needs
  measuring. Never `useElementSize` from `@mantine/hooks` in a chart file (Mantine is
  banned inside `charts/**`), and never raw `@visx/responsive` outside `charts/**`.

## Strict surfaces & layout primitives

The theme runs a **strict surface system**: Mantine components don't chain through
`--mantine-color-default-*` — each reads a **raw ramp step** directly — so `cssVariablesResolver`
**collapses the ramp steps onto the basalt tokens**. Light borders (`--mantine-color-gray-2/3/4`)
and dark borders (`--mantine-color-dark-4`) both resolve to `--vx-surface-border`; light
hover/subtle steps (`--mantine-color-gray-0/1`) resolve to the `--vx-surface-subtle` token;
`Card`/`Paper` backgrounds are forced to `--vx-surface-panel` via theme `styles` (Mantine otherwise
defaults card bg to the page body color, so cards blend into the page); `--app-shell-border-color`
is pinned to `--vx-surface-border`. Net: **one border shade, one card background, one radius
(`--vx-radius-card`) across every surface** — AppShell, Table, Input, Divider, Tabs, Popover,
Accordion, cards. The agent cannot reintroduce a divergent border/bg (no more off-system
`#aba59c`). Surfaces must come from `VX.surface.*` + the radius token — **never** inline
`border`/`borderRadius`/`backgroundColor`/`boxShadow`, and never a raw Mantine ramp-step var
(`var(--mantine-color-gray-N)`).

**Never pass `withBorder` to a `Card`/`Paper`.** Card depth is `--vx-shadow-card`, which bakes its
1px ring into the shadow value itself; the theme's `styles.root` pins bg/shadow/radius but does not
clear `border`, so `withBorder` draws a _second_, real edge on top of the ring and the card reads
heavy and boxed. This is the most common way a migrated app silently keeps its old hairline
identity — the prop is on-token (its color resolves to `--vx-surface-border`), so only the
`card-with-border` guard kind catches it. `withBorder={false}` and `<Card.Section withBorder>` (a
section divider, not card depth) are both fine.

- **Use Mantine primitives, not raw HTML.** To keep padding/spacing/radius/colors consistent,
  consumer code must compose Mantine layout/surface primitives — `Box`, `Flex`, `Grid`,
  `SimpleGrid`, `Stack`, `Group`, `Paper`, `Card` — instead of raw `<div>`/`<span>` with inline
  `style`. Raw HTML with inline layout/surface styling defeats the token system.
- **Mechanical enforcement.** `basalt-ui check-theme` adds six surface guard kinds (each a config knob,
  default ON; `theme-allow` line-comment escape): `off-system-surface-var` (raw ramp-step vars),
  `card-with-border` (`withBorder` on a `Card`/`Paper`), `mantine-shade-index` (a shade-pinned color —
  see below), `raw-html-layout` (raw `<div>`/`<span>` with inline layout/surface styling),
  `inline-spacing` (inline spacing literals), `inline-display` (inline `display` literals). The
  Mantine-free `src/charts/**` is the only place raw `<div>` is allowed — and it must still use `VX.*`
  tokens. `oxlint` adds `basalt/card-inset`, which catches the other half of the same card drift: an
  explicit `p`/`padding`/`radius` on a `Card`/`Paper` instead of the xs/sm inset and the theme radius.

**Never pin a shade index on a color.** `c="yellow.7"`, `bg="blue.4"`, `var(--mantine-color-red-6)` —
each names one fixed swatch that is identical in light and dark, so a shade legible on the dark page
is the one that fails contrast on the light one. Two correct forms: `VX.status.*` /
`--vx-status-warn|bad|good` for a verdict color (emitted per scheme, contrast guaranteed by the
derivation), or the bare hue name (`c="red"`, `color="green"`) to let the theme pick the step. The
`mantine-shade-index` guard kind catches the pinned form; `gray`/`dark` steps in `var()` belong to
`off-system-surface-var` instead. Note the distinction from `off-identity-accent`, which polices
_which hue_ you reach for and permits the bare status names on purpose — this kind polices the index.

## Scroll regions

**A scroll region inside app chrome is a Mantine `ScrollArea`, not a raw `overflow: auto` box.**
ScrollArea draws its own bar absolutely inside a `position: relative; overflow: hidden` root, so the
bar floats over the content; a native bar reserves gutter width and reflows the column the moment
the content overflows. `AppSidebar`'s nav is the reference pattern — `<ScrollArea type="hover"
scrollbars="y" scrollbarSize={9}>` with the flex fill (`flex: 1; min-height: 0`) on the ScrollArea
root and the content classes on the inner `Stack`, so child-combinator spacing rules still see the
content's own children through the wrapper.

`styles.css` re-hides the native bar on `.mantine-ScrollArea-viewport`: basalt's global
`*::-webkit-scrollbar` theming otherwise re-exposes the bar ScrollArea hides, yielding two bars plus
an always-on gutter. That fix makes **one overlay bar** the framework-wide outcome for every
ScrollArea consumer — do not undo it, and do not re-theme the viewport's native bar.

A raw `overflow: auto` element is still correct where a library owns the scroll container and needs
a real scrollable node: `BasaltStickToBottom` (scroll anchoring) and `BasaltVirtualList` (TanStack
Virtual measures the scroll element). That is why this is a documented standard rather than a lint
rule — the legitimate exceptions are context-dependent, not syntactic. Prefer ScrollArea for
everything else: sidebars, panels, menus, palettes, and any chrome that scrolls.

## Elevation, density & shape

basalt-ui targets dense, professional surfaces (a terminal, not a marketing page). The depth and
shape doctrine lives here; the spacing/radius/type **tokens** are in basalt-tokens.md.

- **Density is the point** (Linear/Notion). Sections separate by surface change and shadow/hairline,
  not by large air — default to the tighter spacing step. The shipped dense defaults: shell header
  **48px**, navbar width **216** (collapsed **64**) with **`sm` (12px)** padding; sidebar section
  gap **`sm`**, compact nav rows (`--nl-padding: 6px 8px`, `min-height: 30px`, `sm` font), brand row
  32px. Pages: KPI/card padding **~17–19px**, page `Stack`/`SimpleGrid` gaps **`sm`**; ChartCard
  header/body padding raised to ~16–18px.
- **Surface single-source.** All cards — Mantine `Card`/`Paper` **and** the Mantine-free
  `ChartCard` — resolve to **one radius token** (`--vx-radius-card` = **7px**) and
  **one depth token** (`shadow-card` — a whisper shadow + 1px ring, the ring lives IN the shadow, no
  separate `border` property). Cards must never diverge: same radius, same shadow. Never
  inline-override `border`/`borderRadius`/`boxShadow`/`backgroundColor` on a surface — use the
  radius token (`radius="md"` / `var(--vx-radius-card)`) + `VX.shadowCard` + `VX.surface.*`.
  Mechanically enforced by `basalt-ui check-theme`'s `raw-surface` guard. Outer spacing comes from the
  parent `Stack`/`SimpleGrid` gap, not an intrinsic card margin.
- **Depth = a whisper shadow with a 1px ring baked in, not a plain hairline** (see
  `docs/DESIGN-SPEC.md` in the basalt-ui repo, doctrine inversion #1 — this supersedes the old
  "never a drop shadow" rule). **Three depth tiers, split control-vs-panel-vs-floating:**
  - **`shadow-card` — panels.** A surface that HOLDS content: `Card`, `Paper`, `Notification`,
    `ChartCard`, `SettingsSection`. Its light-mode ring is an **outset** 1px hairline; dark is a
    deeper drop + an inset 4%-white rim.
  - **`shadow-raised` — interactive controls.** Anything you click or type into: Button,
    ActionIcon, the field idiom (Input/TextInput/PillsInput/…), the sidebar search trigger, header
    icon buttons, `Chip`, `CheckboxCard`/`RadioCard`, the agent composer. **Never an outset ring** —
    dark is drop + an inset 8%-white rim, light is drop only. That is what lets ONE value ride a
    saturated fill, a 13% tint and a neutral panel alike: an outset ring paints in the color of
    whatever it is drawn over, so `shadow-card`'s pale hairline would read as a grey outline around
    a colored button, while an inset edge is drawn over the control's own background. The
    light/dark asymmetry is deliberate — a light-mode edge would have to be a _darkening_, which
    reads as a border (uniform) or a double bottom rule (bottom-only); both were tried and
    rejected. Don't tidy the two schemes into one shape.
  - **`shadow-overlay` — detached floating surfaces.** Tooltip, Popover, Menu, Combobox, Modal,
    Drawer — they sit _above_ the page rather than on it. Resolved in `theme/index.ts`; not
    Mantine's own shadow scale.

  Focus is a fourth tier and **layers**: a 2px accent ring drawn OVER the resting depth, never
  replacing it.

  **The dividing line is control-vs-panel, not component-by-component.** Two controls sitting side
  by side must never land on different tokens — a `size="md"` Input beside a `size="md"` Button
  (pinned to the same height by `--vx-space-control-height`), or the header's search trigger and
  icon button. Closing exactly that split is why `shadow-raised` exists.

  **Emphasis is fill weight, not depth.** Every Button/ActionIcon variant that owns a box takes the
  SAME resting depth: `default` / `filled` / `light` → `shadow-raised` unmodified; `outline` →
  ring-free `shadow-ctrl` (its real 1px accent border already is its edge); `subtle` → **flat in
  both states** (a text affordance, not an object — its hover is a neutral ink-6% tint and nothing
  more). **Depth is static — no variant moves or changes depth on hover or press.** A hover lift
  and a materializing `subtle` shadow were both tried and reverted; don't reintroduce either.
  Disabled is flat and grounded. Reduced motion drops the transition, never the resting depth.

  Mechanics: every default-variant control renders its bg + depth with a _transparent_ 1px border
  box (never `border: none` — the box stays so focus/error can recolor it with no layout shift).
  `--mantine-color-default-border` is pinned to `transparent` in `cssVariablesResolver`, the ONE
  lever that kills the stock hairline for every default-variant component at once
  (`defaultVariantColorsResolver`'s `variant === 'default'` branch reads that single var); the
  shadow itself is added per-component in `controls.module.css`, since Mantine never declares one
  for `default`. `PillsInput` reuses the Input field idiom's `classNames` wiring directly (it
  renders `InputBase` under its own `__staticSelector`, so the base `Input` theme entry never
  reached it). Layout dividers (header bottom border, sidebar section separators) still use plain
  borders — only card/control depth moved to shadow. A dedicated test,
  `src/theme/border-coverage.test.ts`, mechanically enumerates every `@mantine/core` component
  whose shipped CSS declares a border and asserts it's either a themed `baseTheme.components` key
  or a reasoned `BORDER_ALLOWLIST` entry — this is what catches the NEXT unthemed bordered
  component (Button/ActionIcon shipped with no `.extend()` block at all, which no consumer-source
  guard can ever see).

- **The ring must land on the box that carries the surface's `border-radius`.**
  `shadow-card`/`shadow-raised` bakes a 1px ring into the shadow value itself, and the ring is drawn
  by the shadowed box's OWN corners — it never reads correctly against a different element's radius
  (the Input wrapper bug: a `position: relative` box with `border-radius: 0` drew a square ring
  around the 8px-rounded `<input>` inside it). Background usually co-locates with the radius since
  most surfaces declare both on the same box, but it's the radius the ring is contractually bound
  to, not the background — `ChartCard.tsx` legitimately carries the shadow on a box with NO
  background (an inner box, sharing its exact radius, paints the fill instead, because `overflow:
hidden` on the same box as the shadow would clip the shadow itself) and is correct. `src/theme/
shadow-surfaces.test.ts` mechanically enumerates every site that applies either token and requires
  a written `roundedBy` reason naming where that box's radius comes from.
- **Tight radii read precise/technical** (Linear): `sm` for controls, `md` for cards, `pill` for
  badges. Consume the token, never a raw number (basalt-tokens.md).
- **Type is carried by the three-font system** (sans body / head condensed headings / mono
  numerals — basalt-tokens.md), numbers in the mono tabular stack so metric columns align (a
  Coinbase pattern).

## Composing the shell from sub-components

`BasaltShell` is the canonical single-mount. When a fully custom layout is needed, the shell
sub-components are available individually from `basalt-ui`:

- `AppSidebar` — desktop sidebar (sections, collapse, brand, footer/settings extras)
- `MobileNav` — bottom-tab mobile nav
- `AppBreadcrumbs` — breadcrumb bar (reads from `useRouterBreadcrumbs` or a manual trail)
- `PageHeaderProvider` + `PageActions` + `PageActionsOutlet` — portal-based page action slots
- `NavCountBadge` — count badge for sidebar nav items

```tsx
import {
  AppSidebar,
  MobileNav,
  AppBreadcrumbs,
  PageHeaderProvider,
  PageActionsOutlet,
  NavCountBadge,
} from 'basalt-ui'

function CustomShell({ children }: { children: React.ReactNode }) {
  return (
    <PageHeaderProvider>
      <AppSidebar sections={sections} brand={brand} renderNavLink={renderNavLink} />
      <MobileNav sections={mobileSections} renderNavLink={renderNavLink} />
      <main>
        <AppBreadcrumbs />
        <PageActionsOutlet />
        {children}
      </main>
    </PageHeaderProvider>
  )
}
```

Prefer `BasaltShell` unless the layout genuinely diverges — it already composes all of the above
with the correct wiring (collapse persistence, mobile breakpoint, breadcrumb integration).

## Icons

basalt-ui takes icons as `ReactNode` (no icon dependency shipped). Use a single icon library across the
app — `@tabler/icons-react` pairs cleanly with Mantine. Size via the icon's `size` prop (`size={16}`),
not CSS.

## Interaction feedback (micro-animations)

Every action button (Save, Log, Add, Delete, Toggle) must give immediate visual confirmation — silent
success feels broken. Three layers, applied together:

1. **In-flight state** — `loading` prop on `<Button>` (built-in spinner). Disables clicks automatically.
2. **Post-success state on the trigger itself** — flip the button briefly: swap label `Save → Saved`,
   set `color="green"` (the success status hue — never `teal`/`violet`, which the theme guard rejects as
   off-identity), reveal an `IconCheck` via `<Transition mounted={justSaved} transition="pop"
duration={180}>`. Hold ~1.2–1.5s, then reset. The user's eye is on the thing they clicked — feedback
   lands there, not only in a corner toast.
3. **Toast (`notifications.show`)** — only for outcomes the user might miss (writes that succeed
   off-screen, errors, async background work). Don't toast trivial UI toggles. `autoClose` ≤ 2000ms for
   success; errors stay until dismissed.

Guidelines:

- Durations: 120–200ms for state flips, 180–250ms for `Transition`, never above 300ms (feels laggy).
- Never animate layout-shifting properties (height, width) on buttons — animate `transform`, `opacity`,
  `color`, `background`.
- A button that turns into a check **is** the confirmation; the toast is for context the user can't see.
- Destructive actions: `modals.openConfirmModal` first, then the same in-button success pattern after.
- Form errors: prefer inline field errors over toast; toast only for submit-level failures.

## Motion (`motion`)

basalt-ui ships `motion` (motion.dev, formerly framer-motion) as a bundled dependency — the same
precedent as `@visx/*`: an internal implementation detail, not a peer the consumer opts into.
`ThemeToggle` is the first consumer (icon morph + direct-select popover reveal).

- **Reach for Mantine's own `<Transition>`** (above) for simple mount/unmount fades/pops — it's
  already there, needs no import. **Reach for `motion`** when the interaction needs something
  `Transition` can't do: crossfade between two different elements (not just show/hide one),
  spring physics, or a gesture-driven reveal.
- **Import from `motion/react`, never the raw `framer-motion` package** — `motion` re-exports it,
  but a direct `framer-motion` import bypasses the pinned/vetted specifier. Enforced by oxlint
  `no-restricted-imports` (repo-local and the shipped consumer preset).
- **Never a hardcoded duration/spring/ease literal in a `transition={{...}}` prop.** Import
  `MOTION_DURATION` / `MOTION_SPRING` / `MOTION_EASE_STANDARD` from `basalt-ui` instead — the
  motion analog of routing color through `VX.*`. `MOTION_DURATION` is capped at 0.3s (300ms),
  matching the interaction-feedback ceiling above. Mechanically enforced by `basalt-ui check-theme`'s
  `raw-motion-value` guard (default ON; `theme-allow` line-comment escape).
- **Always branch on `useReducedMotion`** (`@mantine/hooks`) — render a real unanimated code path
  (no `motion.*` wrapper at all), not just `transition={{ duration: 0 }}`. See `ThemeToggle`'s
  `SchemeGlyph` for the pattern.
- **Restraint applies to motion too.** Subtle and purposeful — a state change earns a transition,
  idle chrome does not. Never a looping/pulsing idle animation.

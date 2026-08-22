---
source: basalt-ui
description: Color, spacing, radius, and type discipline — route every value through the basalt-ui token system. Enforced by `basalt-ui check-theme`.
paths:
  - 'src/**'
  - 'apps/**/src/**'
  - 'packages/**/src/**'
---

# Basalt Tokens — Color, Spacing, Radius, Type

basalt-ui ships one color/type/spacing/radius identity shared by the Mantine chrome and the visx
charts. The **identity is modern zinc** (see `docs/DESIGN-SPEC.md` in the basalt-ui repo) —
**cool-neutral zinc surfaces**
(Tailwind zinc family) on both light and dark, low-contrast panel lift on a slightly darker page,
depth via a whisper shadow + 1px ring (`shadow-card` on panels, `shadow-raised` on interactive
controls, `shadow-overlay` on floating surfaces — see basalt-mantine.md) rather than a hairline
border, carrying
**one saturated sky-blue accent**, split by ROLE: as INK (links, active-nav icon, chart
lines, focus ring) it is `#0077bd` light / `#8ec5ff` dark; as a FILLED SURFACE it is
`#0077bd` in BOTH schemes with a WHITE label (`--vx-accent-fill`, never `--vx-accent`). Neutrals do ~90% of the
surface (60/30/10, pushed toward 90/10); the accent only points — primary CTA, focus, links, small
status pops — never floods. (Blueprint/Basalt zinc-charcoal are the historical hue-tuning
ancestors; `docs/DESIGN-SPEC.md` in the basalt-ui repo supersedes both — see its "Doctrine
inversions" section.) This
rule is the operational checklist; it is enforced mechanically by **`basalt-ui check-theme`**
(wire it into `lint`: `oxlint . && basalt-ui check-theme`; `init` seeds that as `lint:basalt`). A
violation fails the build. Escape hatch: a scoped `theme-allow <rule-id> — <reason>` comment
(diff-visible, deliberate) — see the contract below.

`check-theme` reads its config from your `package.json` `"basalt"` key
(`{ roots?, exempt?, include?, profile?, severity?, spacingSteps?, forbiddenAccents? }`); set `roots`
to your source dirs and `exempt` to the files that legitimately define palette values.

**`roots` is not optional in practice.** Omitted it falls back to `src` relative to the cwd — fine
for a single-app repo, zero files for anything under `apps/*/src`, and `check-theme` then exits 1
with `0 files scanned`. Since 1.20.0 `init` writes a real `roots` from the detected layout and
`doctor`'s `guard-scan` check fails when the configured roots resolve to nothing; before that a repo
could look fully wired while the gate scanned nothing.

The scan reaches slightly beyond `roots`: each root's PARENT contributes its `index.html` and its
`public/` tree (the Vite layout basalt's own preset assumes), because that is where a `theme-color`
meta and a webmanifest's `background_color` actually live. `.json` is never blanket-scanned — name a
design-surface JSON in `basalt.include`, the only route to one.

## `theme-allow` — the 1.20.0 contract

Scope it. `theme-allow <rule-id> — <reason>` waives that ONE kind; the id is a guard kind
(`raw-surface`, `inline-spacing`, …) or an oxlint plugin rule (`hand-rolled-plot`,
`raw-scroll-container`, …), with or without the `basalt/` prefix.

```tsx
// theme-allow raw-surface — third-party widget needs a literal corner
<Widget style={{ borderRadius: 3 }} />
```

- **A bare `theme-allow` still waives everything**, so no upgrade takes a build down over comment
  placement — but it now reports `theme-allow-unscoped` (`warn` for one minor, then `error`).
  Rescope the ones you have; that is the whole migration.
- **Spell the id right — a typo waives nothing.** A word in the id slot that names no rule is
  recorded as unknown and suppresses nothing; the annotation covers exactly the ids it got right.
  Only a genuinely bare `theme-allow` is the blanket form. Because the id slot is read strictly, a
  prose reason has to be introduced by a separator: `theme-allow: <why>` or
  `theme-allow <id> — <why>`, never `theme-allow <why>`.
- **Three placements work and both engines agree on all three**: the reported line, a comment-ONLY
  line directly above it (the only form JSX can express — the reported line is usually a multi-line
  opening tag or a `{expr}` child), and in CSS a trailing annotation reaching back over the
  declaration it terminates. The third is what survives the shipped `oxfmt` reflowing a long
  `background-color` so the hex lands ABOVE the comment.
- **`basalt/hand-rolled-plot` no longer grants whole-file immunity** off whichever comment happened
  to sit on the first assembly node. Every node is waived on its own; a file-scoped exception needs
  a written declaration that both names the rule and gives a reason, anywhere in the file.

### New in 1.20.0 — five guard kinds, all `warn` for one minor

| Kind                      | Fires on                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `theme-allow-unscoped`    | a `theme-allow` with no rule id, no reason, or an id that names no rule                                             |
| `surface-shadow-override` | a `boxShadow` built FROM tokens that REPLACES `--vx-shadow-card` instead of composing with it                       |
| `css-raw-surface`         | the kebab dialect of the surface kinds in CSS (`border-radius: 6px`); sub-scale corners and circle/pill values pass |
| `inline-font-size`        | `style={{ fontSize: 11 }}` — the `check-theme` half of `basalt/no-raw-font-size`, for a CI that runs only the guard |
| `hidden-inline-style`     | a multi-line opening tag, or a style object hoisted to a const — `raw-html-layout`'s formatting-independent half    |

Two new oxlint rules ship at `warn` alongside them: **`basalt/shadow-basalt-export`** (below) and
**`basalt/hand-rolled-shell`** (`AppShell` parts or `Burger` in a file that does not render
`BasaltShell`). **`basalt/raw-size-literal` is now `error`** — CSS-length strings on
`size`/`fz`/`fontSize`. Every kind keeps its own boolean, `basalt.severity` and `exemptRules`.

## The guard sees palette, not vocabulary

Round 4 swept seven consumer repos: every gate green, and ~15 independently re-rolled copies of
components basalt already ships (`StatCard` in 4 of 4 apps, `EmptyState`, a 266-line hand-rolled
`AppShell`). A fork written by a token-fluent author uses exactly the right tokens, so no palette
guard can ever see it. **`basalt/shadow-basalt-export` is the cheap detector** — it warns when a
local component's name collides with a live basalt export, read from the real shipped barrel. The
habit it stands in for: check whether basalt already ships the thing before building it.

## Filled surfaces — the fill band

A filled control is a SURFACE, not ink, and it does not invert across schemes. It is squeezed from
both sides at once: a **white label** needs ≥4.5:1 against the fill, and the control needs ≥3:1
against the page behind it — on BOTH pages. That leaves one narrow luminance band, so:

- **Every family's fill sits in that band** (`FILL` / `ACCENT` in the palette): the hue varies, the
  luminance does not. Every filled surface therefore reads WHITE, on either page, at ~4.9:1.
- **Never fill with the ink accent.** `--vx-accent` is light on dark by design (it is read against
  the page) — filling with it puts a white label on a light blue button. Fill with
  `--vx-accent-fill` / `--vx-fill-{family}`; label with `--vx-on-accent` / `--vx-on-{family}`.
- **Never decide a foreground yourself**, and do not trust Mantine's `autoContrast`: it resolves the
  color once in JS, scheme-blindly, using a brightness heuristic that does not track WCAG contrast.
  The theme emits `--vx-on-*` per scheme instead, and every filled control is bound to it.
- Hover is **derived** from the fill in CSS, so retuning a fill carries its hover along.

Retuning a fill OUTSIDE the band breaks its label. `theme/contrast.test.ts` fails the build on it.

## Color — never a raw literal

- **No raw `#hex` / `rgb()` / `rgba()` / `hsl()`** in scanned source. Route every color through the
  palette: `VX.*` tokens (from `basalt-ui/tokens` or `basalt-ui/charts` — they are CSS vars, so they
  work in components AND non-component files), or the Mantine theme (`color`/`c`/`bg` props, `theme.colors`).
  Opacity via `alpha(token, a)` — never `rgba()` — so the hue keeps resolving per color scheme.
- **No off-identity Mantine accents.** `color`/`c`/`bg`/`backgroundColor` must not be
  `teal`/`violet`/`grape`/`indigo`/`pink`. `createBasaltTheme` reskins _every_ Mantine accent to the
  Basalt identity, so those names still render on-palette — but the guard rejects them because they
  signal off-identity intent. Allowed accents: **`blue`** (the one earned identity hue — the
  saturated sky accent), **`gray`** (neutral), and the status hues **`red`/`green`/`orange`/`yellow`**
  (muted/forest, never raw Material/AntD). Categorical/series color goes through series tokens
  (`defineSeries` → `seriesTokens`/`groupTokens`), never a Mantine accent prop. Success-button flips
  and positive deltas use `color="green"` (forest green), not `teal` (vivid turquoise).
- **"Ink earns its color"** — default to neutral. A hue is justified only for trend, signal/status,
  or genuine multi-series separation. A count badge is a signal → it may carry blue; a nav active-state
  is UI chrome → it stays neutral (`NavCountBadge` already encodes this). Active nav renders a
  **neutral surface fill** + plain text + a weight bump, never the accent — baked into the theme's
  NavLink `--nl-*` defaults across every render path (including a router `<Link>` hosted through
  `SidebarItem.Anchor`).
- **Accent restraint, mechanically.** The accent lands on exactly the single primary CTA per view
  (`variant="filled"`), focus rings, links, and small status pops — nowhere else. Routine/secondary
  buttons use `variant="default"` (neutral); don't reach for a colored `variant="light"` (it reads
  washed-out on the warm light canvas). Neutrals carry borders, large fills, and routine icons.

## Surfaces — one collapsed token set

The surface token set is **`bg` · `panel` · `elevated` · `subtle` · `border`**:

- `--vx-surface-bg` (`VX.surface.bg`) — the page background.
- `--vx-surface-panel` (`VX.surface.panel`) — the card/`Paper` background.
- `--vx-surface-elevated` (`VX.surface.elevated`) — a lifted surface (chart areas, tooltips).
- `--vx-surface-subtle` (`VX.surface.subtle`) — a faint hover/striped/track surface: a step
  **below white on light** (`#f2f2f1`), **above panel on dark** (`#323239`). Used for Table
  hover/striped rows, `Code`, the `SegmentedControl` track, and Tabs/Accordion/Menu hover.
- `--vx-surface-border` (`VX.surface.border`) — the single hairline border token.

The theme **collapses Mantine's raw ramp steps onto these tokens** (`cssVariablesResolver` plus
theme `styles`): light/dark border ramp steps → `--vx-surface-border`, light hover steps →
`--vx-surface-subtle`, card bg → `--vx-surface-panel`, `--app-shell-border-color` →
`--vx-surface-border`. So **every** Mantine component (AppShell, Table, Input, Divider, Tabs,
Popover, Accordion, cards) renders one border shade, one card background, and one radius
(`--vx-radius-card`). Never inline a surface color or reach for a raw ramp-step var
(`var(--mantine-color-gray-N)`) — the `off-system-surface-var` guard rejects it.

## Spacing & radius — prefer the scale token

- `baseTheme` owns the scales: `spacing` 11/13/18/20/26 → `xs…xl`, `radius` 2/4/6/16/32 → `xs…xl`.
  Both are DERIVED — `deriveSpacing(level)` / `deriveRadius(level)` in `tokens/palette.ts` move them
  with `createBasaltTheme`'s `density` / `radius` knobs, so read the numbers as level-0 values, not
  as constants. **Use the token**, not the raw number, when a value equals a step: `p="md"` not
  `p={18}`, `gap="sm"` not `gap={13}`, `radius="sm"` not `radius={4}`. The guard flags exact
  token-equals (`p={18}`, any numeric `radius`).
- **Card radius has one source: `--vx-radius-card` (7px) = `VX.radiusCard`.** Every
  card corner — the Mantine chrome (`Card`/`Paper`, `radius="md"`) and the Mantine-free `ChartCard`
  (`var(--vx-radius-card)`) — resolves to this single token; cards must never diverge. Don't inline
  a `borderRadius` on a surface (the `raw-surface` guard rejects it).
- **Dense by default.** The framework targets compact (Linear/Notion) surfaces — prefer the tighter
  spacing step (`sm`/`xs`) for shell, nav, and card padding rather than `md`/`lg` air (see
  basalt-mantine.md for the shipped dense defaults).
- **Sub-scale micro-spacing is legitimate and allowed raw** — `gap={2}`, `pl={4}`, `mt={6}` have no
  token equivalent (the scale starts at 11). Use them freely for tight clusters; don't invent
  micro-tokens or pepper `theme-allow`. One-off layout dims (`h={36}`, `w={64}`) are also fine raw.
  **The same permission holds in CSS modules**, where it has to be enforced differently: there is no
  prop form to prefer, so `inline-spacing` simply does not fire on a declaration whose every literal
  is ≤ 10px (`gap: 2px`, `padding: 4px 8px`). It reads longhands and logical properties too
  (`padding-top`, `margin-inline`, `row-gap`, `padding-inline-start`), not just the shorthands.
  `rem` resolves against the 16px root, so `0.25rem` and `4px` get the same answer; units that need
  layout context (`em`, `%`, `ch`, `vw`) are not micro-spacing claims and flag. A `var()` component
  is dropped before that judgement; one non-micro value makes the whole declaration a finding
  (`padding: 4px 16px` flags). An inline style OBJECT in TSX (`style={{ padding: 4 }}`) also still
  flags: there the Mantine prop exists and should have been used.
- **Icons** size via the icon's own `size` prop (`size={16}`), not spacing tokens — that's not spacing.

## Type

- A shipped **three-font system**: `Nunito Sans Variable` (body), `Hubot Sans Variable` (headings,
  brand, card titles — always `font-stretch: 88%`), `JetBrains Mono Variable` (all numerals,
  micro-labels, kbd/badges, axis ticks). Fonts ship as exact-pinned `@fontsource-variable/*` deps,
  `@import`ed in `styles.css`; the `--basalt-font-{sans,head,mono}` vars stay the override seam
  (system-font fallback chains preserved). Type is carried by Mantine's `fontSizes` + `headings` +
  the named `fontWeights` ladder (`fw="semibold"`, `fw="medium"`, …) and `fontFamilyMonospace` for
  numbers. Don't hard-code `fontSize` in px on chrome; use `size`/`fz` tokens.

## `groupTokens` ↔ `paletteOptions.groups` — the prefix lockstep

`groupTokens(GROUP, MAP)` (from `basalt-ui/tokens` or `basalt-ui/charts`) generates `var(--vx-GROUP-key)`
refs assuming the same map is also handed to `BasaltProvider`'s `paletteOptions.groups` under the key
`` `${GROUP}-` `` (**with the trailing dash** — `paletteOptions.groups` is keyed by CSS-var _prefix_,
not by group name). Drift between the two — e.g. calling `groupTokens('activity', MAP)` but wiring
`paletteOptions={{ groups: { activity: MAP } }}` (missing the dash) — emits token refs that point at
CSS variables the palette stylesheet never declares: no tsc error, silent unstyled/transparent charts
at runtime. Derive both from one `GROUP` constant so they can't drift:

```ts
// theme/series.ts
export const GROUP = 'activity'
export const colors = groupTokens(GROUP, SERIES) // -> var(--vx-activity-key)
export const paletteGroups = { [`${GROUP}-`]: SERIES } // -> { 'activity-': SERIES }
```

```tsx
// main.tsx
<BasaltProvider paletteOptions={{ groups: paletteGroups }}>{/* app */}</BasaltProvider>
```

## When the guard fires

Fix the source, don't silence it — reach for the right token first. Only add `theme-allow` for a
genuine, documented exception (a third-party widget needing a literal), scoped to the rule id, with
a reason: a bare `// theme-allow` passes the check, tells the next reader nothing, and now reports
`theme-allow-unscoped` besides. The palette-definition files are listed in your `exempt` set so they
don't self-trip. A stylesheet emitted by `basalt-ui tokens:css` needs no entry — in a `.css` file
carrying that exact two-line `@generated basalt-ui` header, the guard skips the LINES that are
basalt custom properties, selectors, `}` or self-closing comments. Pasting the marker anywhere else
suppresses nothing, and an ordinary declaration added to such a file is still reported.

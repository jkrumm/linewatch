---
source: basalt-ui
description: Color, spacing, radius and type discipline — route every value through the basalt-ui token system. Enforced by `basalt-ui check-theme` plus the oxlint type-scale rules.
paths:
  - 'src/**'
  - 'apps/**/src/**'
  - 'packages/**/src/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `basalt-ui check-coverage --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — css-raw-surface, inline-font-size, off-identity-accent, off-system-surface-var, raw-color-fn, raw-font-family, raw-hex, raw-radius, raw-surface, surface-shadow-override, theme-allow-unscoped · oxlint rules — basalt/no-raw-font-size, basalt/raw-size-literal, basalt/token-layer-boundary -->
<!-- not guarded: — -->
<!-- /basalt:coverage -->

# Basalt Tokens — color, spacing, radius, type

## The identity (stated once, here)

basalt-ui ships ONE identity shared by the Mantine chrome and the visx charts: **cool-neutral zinc
surfaces on both schemes**, a page slightly darker than its panels, depth from a whisper shadow with
a 1px ring baked in rather than a hairline border, and **one saturated sky-blue accent** that only
points. Neutrals carry ~90% of the surface.

The accent is **split by ROLE**, and this is the one thing an author gets wrong:

- **As ink** — links, active-nav icon, chart lines, focus ring — it is read against the page, so it
  inverts across schemes. `VX.accent`.
- **As a filled surface** — a control carrying a white label — it cannot invert: it is squeezed
  between the label's contrast and the page's, which leaves one narrow luminance band. `VX.accentFill`,
  labelled with `VX.onAccent`. Every Mantine family's fill sits in that same band, so a filled
  control always reads white on either page. **Never fill with `VX.accent`.**

**The palette is DERIVED, not authored** (`tokens/derive.ts` from one seed + five bounded knobs), and
a consumer retunes it through `createBasaltTheme(overrides?, { derive, fonts, radius, density })`.
That is why no hex, no shade index and no pixel constant belongs in a rule, a doc or a component:
every one of them is an output of a config the consumer may move. Read the values off `VX.*` and the
theme; read the numbers, when you genuinely need them, off `tokens/palette.ts`.

## Color — never a raw literal

- **No raw `#hex` / `rgb()` / `rgba()` / `hsl()` in scanned source.** Route color through `VX.*`
  (from `basalt-ui/tokens` or `basalt-ui/charts` — they are CSS vars, so they work in components AND
  in non-component files) or through the Mantine theme (`color` / `c` / `bg`, `theme.colors`).
- **Opacity is `alpha(token, a)`** (`color-mix`), never `rgba()` — so the hue keeps resolving per
  scheme.
- **No off-identity Mantine accents.** `teal`/`violet`/`grape`/`indigo`/`pink` still render
  on-palette (the theme reskins every family), and are rejected anyway because they signal
  off-identity intent. Allowed: **`blue`** (the one earned hue), **`gray`**, and the status names
  `red`/`green`/`orange`/`yellow`. A positive delta is `color="green"`, never `teal`.
- **Never pin a shade index** — `c="yellow.7"`, `bg="blue.4"`, `var(--mantine-color-red-6)` each name
  one fixed swatch that is identical in both schemes, so the shade that is legible on dark is the one
  that fails on light. Use `VX.status.*` for a verdict, or the bare hue name and let the theme pick.
- **"Ink earns its color."** Default to neutral. A hue is justified by trend, signal/status, or
  genuine multi-series separation. The accent lands on the single primary CTA per view, focus rings,
  links and small status pops — never on borders, large fills, routine icons or secondary buttons.
- **Categorical/series color is consumer data**, declared once through `defineSeries` →
  `seriesTokens`/`groupTokens` and wired into `buildPaletteCss`, never a Mantine accent prop and
  never an inline pair. `groupTokens(GROUP, MAP)` assumes the same map reaches
  `BasaltProvider`'s `paletteOptions.groups` under the key `` `${GROUP}-` `` — **with the trailing
  dash**, which is a CSS-var prefix and not a group name. Derive both from one `GROUP` constant;
  a mismatch emits refs to variables the stylesheet never declares, with no tsc error and no
  runtime throw — just unstyled charts.

## Surfaces — one collapsed token set

`VX.surface` is exactly: `bg` · `panel` · `panelHover` · `elevated` · `subtle` · `overlay` ·
`field` · `border` · `hairline`. Plus `VX.divider` for layout separators, which is NOT a surface.

The theme **collapses Mantine's raw ramp steps onto those tokens** (`cssVariablesResolver` + theme
`styles`), so every Mantine component — AppShell, Table, Input, Divider, Tabs, Popover, Accordion,
Card — renders one border shade, one card background and one radius. Never inline a surface color
and never reach for a raw ramp-step var (`var(--mantine-color-gray-N)`).

## Spacing & radius — prefer the scale token

- `baseTheme` owns both scales and both are DERIVED (`deriveSpacing(level)` / `deriveRadius(level)`
  move them with the `density` / `radius` knobs). **Use the token, not the number**: `p="md"`, not
  the integer that happens to equal `md` today; `radius="sm"`, never a numeric radius.
- **Card radius has one source**, `VX.radiusCard` / `--vx-radius-card`: the Mantine chrome and the
  Mantine-free `ChartCard` resolve to the same token. Cards must never diverge.
- **Sub-scale micro-spacing is legitimate and allowed raw** — a tight cluster below the scale's
  first step has no token, so use the raw number rather than inventing a micro-token or peppering
  `theme-allow`. The same permission holds in CSS modules: a declaration whose every literal is
  micro does not fire. One non-micro value makes the whole declaration a finding, and an inline
  style OBJECT in TSX still fires, because there the Mantine prop existed.
- **Dense by default** — the framework targets compact surfaces; reach for the tighter step.
- **Icons size through the icon's own `size` prop**, which is not spacing.

## Type

Three fonts: sans (body), a condensed head font (headings, brand, card titles), mono (every numeral,
micro-label, kbd, axis tick). They ship as exact-pinned `@fontsource-variable/*` peers imported by
`basalt-ui/styles.css`; `createBasaltTheme(_, { fonts })` is the ONE override seam, writing the
`--basalt-font-*` vars. Size and weight come from the theme's `fontSizes` / `headings` / named
`fontWeights` ladder (`fw="semibold"`) — never a hardcoded `fontSize`, and never a CSS-length string
on `size`/`fz`.

## `theme-allow` — the escape hatch and its grammar (stated once, here)

```text
theme-allow                                  → this node/line, EVERY rule   (reports theme-allow-unscoped)
theme-allow <id>[, <id>…] [— <why>]          → this node/line, those rules  (unscoped without a why)
theme-allow-file <id>[, <id>…] — <why>       → the WHOLE FILE, those rules; a bare one waives NOTHING
"basalt:theme-allow[-file]": "<id>… — <why>" → the same two, for JSON / .webmanifest
```

An id is a guard kind (`raw-surface`, `inline-spacing`, …) or an oxlint plugin rule
(`hand-rolled-plot`, `hand-rolled-filter`, …), with or without the `basalt/` prefix.

```tsx
// theme-allow raw-surface — third-party widget needs a literal corner
<Widget style={{ borderRadius: 3 }} />
```

- **An annotation must START its comment** — after `//`, `/*`, `<!--`, a block gutter `*`, or
  nothing but whitespace. Prose that merely MENTIONS the token waives nothing; a file documenting
  its own waivers used to disarm itself.
- **File scope is spelled, never inferred**: `theme-allow-file <id>… — <why>`, anywhere in the file.
  A bare `theme-allow-file` waives nothing at all.
- **A typo waives nothing.** A word in the id slot naming no rule is recorded as unknown; the
  annotation still covers the ids it got right. Because the id slot is read strictly, a bare reason
  needs a separator — `theme-allow: <why>` or `theme-allow <id> — <why>`, never `theme-allow <why>`.
- **Three placements work, and both engines agree on all three**: the reported line, a comment-ONLY
  line directly above it (reaching the first CODE line below, through the rest of its comment
  block), and in CSS a trailing annotation reaching back over the declaration it terminates. A blank
  line ends the reach — that is how you say "this comment is not about the next statement".
- **JSON and `.webmanifest` take a member key**, since they cannot hold a comment. For a manifest
  the first remedy is `basaltAppPlugin`, not a waiver: a hand-copied hex drifts from the palette.
- **The three import-boundary rules honour no escape at all** (`visx-boundary`, `visx-tooltip`,
  `token-layer-boundary`) — an architecture boundary a stray comment can switch off is the bypass
  they exist to prevent. The agent-chat guards honour `basalt-agent-allow`, a separate token that
  never waives a `theme-allow` finding, or the reverse.

Unsupported shapes are asserted as unsupported in both engines' test grids (`src/guard/
check-source.test.ts`, `configs/oxlint-plugin.test.ts`), so "unsupported" and "silently broken"
cannot read the same. **Audit them**: `basalt-ui check-theme --audit-allows` re-runs the scan with each waiver
neutralized, one at a time, and **exits 1 on a waiver that suppresses nothing** — a dead waiver
silently covers the next real finding on that line. It judges plugin-rule waivers too, by re-running
oxlint; where oxlint is unreachable the verdict is "cannot judge", never "dead". Its scope line is
part of the report: `0 dead` is not `0 dead anywhere`.

## Wiring the guard

`check-theme` reads `package.json`'s `"basalt"` key (`roots`, `exempt`, `include`, `profile`,
`severity`, `exemptRules`, …). **`roots` is not optional in practice** — omitted, it falls back to
`src` relative to cwd, which is zero files for anything under `apps/*/src`; `init` writes a real one
and `doctor`'s `guard-scan` fails when it resolves to nothing. The scan also reaches each root's
PARENT for its `index.html` and `public/` tree, because that is where a `theme-color` meta and a
webmanifest's `background_color` live. Wire it as `oxlint . && basalt-ui check-theme` — what `init`
seeds as `lint:basalt`.

**When it fires, fix the source** — the right token first. `theme-allow` is for a documented
exception; a palette-definition file belongs in `exempt`, not behind a comment.

**The guard sees palette, not vocabulary.** A fork written by a token-fluent author uses exactly the
right tokens, so no palette guard can see it — `basalt/shadow-basalt-export` catches an exact name
collision and nothing else, and renaming the fork is what a fork's author does anyway. It is a
tripwire, not coverage. The habit is the control: **check whether basalt already ships the thing
before building it.**

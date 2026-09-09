---
source: basalt-ui
description: Where an interactive control may live and how it binds — the three homes, the ctl size tier, the store-bound filters and tabs of basalt-ui/controls, the mobile policy, and sidebar blocks. Enforced by basalt/hand-rolled-filter, control-outside-home, bound-control-outside-home, control-size-literal, responsive-twin and page-bar-budget.
paths:
  - 'src/**'
  - 'apps/**/src/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `bun scripts/check-coverage.ts --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — raw-selection-control · oxlint rules — basalt/bound-control-outside-home, basalt/control-outside-home, basalt/control-size-literal, basalt/hand-rolled-filter, basalt/responsive-twin -->
<!-- not guarded: C1 as a cross-file law (a control placed in one file, its home declared in another) -->
<!-- not guarded: hand-rolled section headings (argo writes `<Text fw={600} size="sm">` + children, which no AST heuristic matches without false positives) -->
<!-- not guarded: C11 — a table/list stating its count when it is not a BasaltDataTable -->
<!-- not guarded: C12 — one shape for refresh/sync (SyncButton); only the alias table sees a renamed copy -->
<!-- /basalt:coverage -->

# Basalt Controls — homes, tiers, binding

Every interactive control — filter, view tab, refresh, action, section header — has one home, one
size tier and one persistence binding, and basalt owns all three. The API is in the shipped types and
`llms.txt`; this file is the law. Long form: `docs/CONTROLS-SPEC.md` in the basalt-ui repo.

## The laws

| #   | Law                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | A control lives in exactly ONE of three homes — the page bar, a section/widget header, or a form row — entered only through a slot prop.                                                                   |
| C2  | A basalt filter or tab has no `value`/`onChange`; it takes `field` and owns both the URL write and the localStorage mirror.                                                                                |
| C3  | Tab and filter state never lives in `useState` — it derives from a store field on the URL lane or the local lane.                                                                                          |
| C4  | Every field declares its lanes once, at definition, and resolves URL ⊳ localStorage ⊳ fallback uniformly for every field kind.                                                                             |
| C5  | The HOME sets the size tier; an element inside a home slot carries no `size`, `w`, `fullWidth`, `visibleFrom` or `hiddenFrom`.                                                                             |
| C6  | A page has one `PageBar`; its `actions` hold ≤5 entries and exactly one `primary`; a `Section` holds ≤3.                                                                                                   |
| C7  | A home never scrolls horizontally and never wraps — overflow folds into a `More` menu or a `Filters (n)` sheet, computed by basalt from typed data.                                                        |
| C8  | Every section, card or table title is a `WidgetHeader`; the page title is the breadcrumb (or `PageBar.title` with no shell). An in-body h1/h2 is an error.                                                 |
| C9  | A responsive swap belongs to the control — rendering the same control twice under `visibleFrom`/`hiddenFrom` is an error.                                                                                  |
| C10 | A nav link carrying a store field passes `store.linkSearch` by reference; a `search:` literal in a nav definition, or a literal `useSearch({ from })`, is an error.                                        |
| C11 | Every table or list inside a section states its count in its header.                                                                                                                                       |
| C12 | Refresh/sync has ONE shape, `SyncButton`, whose `scope` picks the home (`global` → the shell header, `page` → `PageBar.sync`).                                                                             |
| C13 | Sidebar blocks are declared data (`SidebarBlock[]`), never `ReactNode` slots, so rail and More-sheet projection stay basalt's.                                                                             |
| C14 | An empty home renders nothing, so no route pays for a reserved row.                                                                                                                                        |
| C15 | Every touch target inside a home clears the `touchControlHeight` floor below `sm`. The mobile `Filters (n)` sheet draws no row of its own — it renders the same `PanelRow` the aside's panel surface does. |
| C16 | A new guard lands `warn` with a dated `promote` version, and the build fails once the package version reaches it while the rule is still `warn`.                                                           |

C1's cross-file case, a hand-rolled section heading, C11 outside `BasaltDataTable` and C12 are
**advisory** — the generated header above says so. A green lint run is not evidence they hold.

## The three homes

| Home                                                                              | Slot props                                         | Tier         | Contents                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------- | ------------ | ------------------------------------------ |
| `PageBar`                                                                         | `actions`, `sync`, `filters`, `filtersEnd`, `tabs` | `ctl`        | the page's filters, tabs, actions, refresh |
| `Section`                                                                         | `actions`, `tabs`                                  | `ctl`        | that section's own controls and its count  |
| `WidgetHeader` / `ChartCard` / `StatCard` / `BasaltDataTable` / `SettingsSection` | `actions`                                          | `ctl`        | that widget's own controls and its count   |
| `SettingsRow`                                                                     | `control`                                          | Mantine `md` | ONE form field, bound to a setting         |
| `FormRow` / `FormGroup` (`basalt-ui/forms`)                                       | children                                           | Mantine `md` | ONE form field or a labelled cluster       |

- **Inside `BasaltShell`** both `PageBar` rows are portals (header / the band above the scrollport)
  — where you write `<PageBar>` never moves it. Without a shell both rows render in flow, sticky.
  The header height is a token, never state.
- **The form row keeps Mantine's own `md` tier** — a raw `Select` in `SettingsRow.control` is the
  right answer, `size` there is load-bearing. Neither `SettingsRow` nor `FormRow`/`FormGroup` is a
  tiered slot; no filter or size rule applies to them.
- **A control's home is a decision about reach**: affects more than one widget → promote to the
  page bar; formats one widget → stays in that widget's header.
- **An overlay rendered by the PARENT is exempt by FILENAME** — `*-{modal,drawer,popover,panel,form}.tsx`.
  Outside that: `theme-allow-file control-outside-home — overlay`.

## The `ctl` tier — the home sizes the control

| Anchor                | Mantine size                                               | Where                                               |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| `controlHeightTag`    | count-tag `Badge`                                          | inline chip, table cell                             |
| `controlHeightWidget` | `--ai-size-icon` (explicit `size="icon"`, ActionIcon only) | sidebar search actions — no home defaults to it     |
| `controlHeightCtl`    | `size="ctl"`                                               | `PageBar`, `Section`, table toolbar, sidebar blocks |
| `touchControlHeight`  | hit area below `sm`                                        | every home                                          |
| `controlHeight`       | `size="md"`                                                | forms — unchanged                                   |

Each home wraps its **slot** — never its body — in a hoisted theme provider defaulting every
Mantine control inside it to `size="ctl"`. A raw `Button` in `PageBar.actions` is already the right
height with no prop; a `size="xs"` typed there is law C5 (`basalt/control-size-literal`). Mantine's
own `sm`/`xs` are NOT re-pointed elsewhere. Exception: `ChartCard.actions` is Mantine-free, so it
carries only the tier attribute and its controls size themselves.

## Binding a control to a store

```tsx
import { FilterSet, RangeFilter, MultiSelectFilter, ViewTabs } from 'basalt-ui/controls'
import { DateRangePicker } from 'basalt-ui/controls-dates'
;<PageBar
  tabs={<ViewTabs field={analytics.field.tab} />}
  filters={
    <FilterSet>
      <RangeFilter field={analytics.field.range} customPicker={DateRangePicker} />
      <MultiSelectFilter field={analytics.field.channels} label="All channels" noun="channels" />
    </FilterSet>
  }
/>
```

The store, its fields and their lanes are basalt-state.md. What this file adds: **the control takes
`field` and nothing else about state** — no `value`, no `onChange`, no `size`, so a wrong call site
is a tsc error. `ActionGroup`/`OverflowMenu`/`SyncButton` take typed action DATA, never children.

**The date picker is injected, never imported.** `basalt-ui/controls` resolves with no
`@mantine/dates` installed; `DateRangePicker` comes from `basalt-ui/controls-dates` through
`RangeFilter.customPicker`. Never import `@mantine/dates` from a shared module or reach for
`DateInput`/`DatePickerInput` inside a home slot.

## `FilterSet` owns the responsive story

Do not build one at the call site. Above `sm`, `FilterSet` measures its own children and folds the
tail into a `+N` pill. Below `sm`, the first `inline` children stay pills and one `Filters (n)`
pill opens a sheet where every child renders full-width and answers one `Reset all`. **`n` and
`Reset all` are DERIVED** from whether each field differs from its fallback — adding a filter is
one JSX line, no count or reset handler to maintain.

| Below `sm`       | What basalt does                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PageBar` row 1  | breadcrumb · the `primary` action as an icon · ONE kebab holding every `more` action                                               |
| `PageBar` row 2  | line 1: `ViewTabs` full-width (a `Select` past three options) · line 2: one inline pill · `Filters (n)` · the aside's `Panel` pill |
| a section header | title · count · one inline action, the rest in a kebab; tabs past three become a `Select`                                          |
| a widget header  | value + delta wrap under the title; the sparkline drops to bleed; one `⋯` action                                                   |

Every swap is CSS inside the control (one mount), never a JS media query. Two mounts under
`visibleFrom`/`hiddenFrom` is `basalt/responsive-twin`.

## The aside

`PageAside` is a shell REGION, not a fourth home — C1 still names three. Its body IS a home: it
scopes children to the `panel` surface, so the same `SelectFilter` that is a pill in the page bar
is a ROW in the aside — never two components, the surface is read from where it's mounted.

| In the aside     | Write                                                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| an inspector row | `PanelRow` — label above, optional `hint`, mono `readout`, `end` slot             |
| a bound slider   | `SliderControl` — min/max/step come off the handle, never props                   |
| a facet list     | `MultiSelectFilter` + `counts` (and `max`, past which the tail folds)             |
| a group of rows  | `Section` — flush inside the aside, which draws the rhythm itself                 |
| a choice         | `PanelChoice` — a track only while ≤3 options AND every label fits, else `Select` |

- ONE `PageAside` per page, written AFTER the main content — it portals into the region from `sm`
  up, its tree position is reading order, not layout.
- Below `sm` it projects into `PageBar` row 2 as one `Panel` pill; with no row 2 — or shell-less —
  it renders in flow. One node either way (C9).
- A bound control outside all of this is `basalt/bound-control-outside-home` — a slot prop, a
  `FilterSet`, a `PageAside` or a `PanelRow` is a home; nothing else is.

## Sidebar blocks

A non-destination list, a progress meter or a bespoke node in the sidebar is a `SidebarBlock` —
declared data, three kinds (`list`/`progress`/`custom`), placed `'nav'`/`'bottom'`. Because it's
data, basalt owns what a `ReactNode` slot couldn't: a rail dot/ring when collapsed, a persisted
fold, one More-sheet row per block. A `custom` block is desktop-only, by design.

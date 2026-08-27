---
source: basalt-ui
description: Where an interactive control may live and how it binds — the three homes, the ctl size tier, the store-bound filters and tabs of basalt-ui/controls, the mobile policy, and sidebar blocks. Enforced by basalt/hand-rolled-filter, control-outside-home, control-size-literal, responsive-twin and page-bar-budget.
paths:
  - 'src/**'
  - 'apps/**/src/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `basalt-ui check-coverage --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — raw-selection-control · oxlint rules — basalt/control-outside-home, basalt/control-size-literal, basalt/hand-rolled-filter, basalt/responsive-twin -->
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

| #   | Law                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | A control lives in exactly ONE of three homes — the page bar, a section/widget header, or a form row — entered only through a slot prop.                            |
| C2  | A basalt filter or tab has no `value`/`onChange`; it takes `field` and owns both the URL write and the localStorage mirror.                                         |
| C3  | Tab and filter state never lives in `useState` — it derives from a store field on the URL lane or the local lane.                                                   |
| C4  | Every field declares its lanes once, at definition, and resolves URL ⊳ localStorage ⊳ fallback uniformly for every field kind.                                      |
| C5  | The HOME sets the size tier; an element inside a home slot carries no `size`, `w`, `fullWidth`, `visibleFrom` or `hiddenFrom`.                                      |
| C6  | A page has one `PageBar`; its `actions` hold ≤5 entries and exactly one `primary`; a `Section` holds ≤3.                                                            |
| C7  | A home never scrolls horizontally and never wraps — overflow folds into a `More` menu or a `Filters (n)` sheet, computed by basalt from typed data.                 |
| C8  | Every section, card or table title is a `WidgetHeader`; the page title is the breadcrumb (or `PageBar.title` with no shell). An in-body h1/h2 is an error.          |
| C9  | A responsive swap belongs to the control — rendering the same control twice under `visibleFrom`/`hiddenFrom` is an error.                                           |
| C10 | A nav link carrying a store field passes `store.linkSearch` by reference; a `search:` literal in a nav definition, or a literal `useSearch({ from })`, is an error. |
| C11 | Every table or list inside a section states its count in its header.                                                                                                |
| C12 | Refresh/sync has ONE shape, `SyncButton`, whose `scope` picks the home (`global` → the shell header, `page` → `PageBar.sync`).                                      |
| C13 | Sidebar blocks are declared data (`SidebarBlock[]`), never `ReactNode` slots, so rail and More-sheet projection stay basalt's.                                      |
| C14 | An empty home renders nothing, so no route pays for a reserved row.                                                                                                 |
| C15 | Every touch target inside a home clears the `touchControlHeight` floor below `sm`; sheet rows use `sheetRowHeight`.                                                 |
| C16 | A new guard lands `warn` with a dated `promote` version, and the build fails once the package version reaches it while the rule is still `warn`.                    |

C1's cross-file case, a hand-rolled section heading, C11 outside `BasaltDataTable` and C12 are
**advisory** — the generated header above says so. A green lint run is not evidence they hold.

## The three homes

| Home                                                                              | Slot props                                         | Tier         | Contents                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------- | ------------ | ------------------------------------------ |
| `PageBar`                                                                         | `actions`, `sync`, `filters`, `filtersEnd`, `tabs` | `ctl`        | the page's filters, tabs, actions, refresh |
| `Section`                                                                         | `actions`, `tabs`                                  | `ctl`        | that section's own controls and its count  |
| `WidgetHeader` / `ChartCard` / `StatCard` / `BasaltDataTable` / `SettingsSection` | `actions`                                          | `ctl`        | that widget's own controls and its count   |
| `SettingsRow`                                                                     | `control`                                          | Mantine `md` | ONE form field, bound to a setting         |

- **Inside `BasaltShell`**, `PageBar` row 1 portals into the header (the breadcrumb stays the lead)
  and row 2 renders in-flow, sticky, publishing its measured height as `--basalt-page-bar-h` for a
  sticky table or a full-height pane to offset against. Without a shell, both rows render in flow with
  `title` + `icon` leading. The header height is a token on every viewport — never React state.
- **The form row is a real home, and it keeps Mantine's own `md` tier.** A raw `Select` bound to a
  setting is the right answer in `SettingsRow.control`, and the `size` prop there is load-bearing
  rather than redundant. `SettingsRow` is not a tiered slot, and no filter or size rule applies to it.
- **A control's home is a decision about reach**: it belongs next to what it acts on. If it affects
  more than one widget it is promoted to the page bar; if it formats one widget it stays in that
  widget's header.

## The `ctl` tier — the home sizes the control

| Anchor                | Mantine size                                               | Where                                               |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| `controlHeightTag`    | count-tag `Badge`                                          | inline chip, table cell                             |
| `controlHeightWidget` | `--ai-size-icon` (explicit `size="icon"`, ActionIcon only) | sidebar search actions — no home defaults to it     |
| `controlHeightCtl`    | `size="ctl"`                                               | `PageBar`, `Section`, table toolbar, sidebar blocks |
| `touchControlHeight`  | hit area below `sm`                                        | every home                                          |
| `controlHeight`       | `size="md"`                                                | forms — unchanged                                   |

Each home wraps its **slot** — never its body — in a hoisted theme provider that defaults every
Mantine control inside it to `size="ctl"`, plus a `data-basalt-tier` attribute. So a raw `Button`
dropped into `PageBar.actions` is already the right height with no prop, and a `size="xs"` typed
there is law C5 (`basalt/control-size-literal`). Mantine's own `sm`/`xs` are NOT re-pointed: a
`size="sm"` in a modal or a form keeps Mantine's height. One exception, by boundary:
`ChartCard.actions` lives inside the Mantine-free chart layer, so it cannot mount the slot theme —
it carries only the tier attribute, and the basalt controls placed there size themselves.

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
`field` and nothing else about state.** No `value`, no `onChange`, no `size` — those props do not
exist, so a wrong call site is a tsc error rather than a review comment. `ActionGroup`,
`OverflowMenu` and `SyncButton` sit on the same subpath and take typed action DATA, never children.

**The date picker is injected, never imported.** `basalt-ui/controls` resolves and renders with no
`@mantine/dates` installed, which is what lets a consumer without a date picker use every other
control; `DateRangePicker` comes from `basalt-ui/controls-dates` through `RangeFilter.customPicker`.
Never import `@mantine/dates` from a shared module, and never reach for `DateInput`/`DatePickerInput`
inside a home slot.

## `FilterSet` owns the responsive story

Do not build one at the call site. Above `sm`, `FilterSet` measures its own children and folds the
tail into a `+N` pill rather than wrapping or scrolling. Below `sm`, the first `inline` children stay
pills and one `Filters (n)` pill opens a bottom sheet where every child renders full-width, applies
immediately, and answers one `Reset all`. **`n` and `Reset all` are DERIVED** from whether each field
differs from its fallback — so adding a filter is one JSX line, with no count to maintain and no
reset handler to extend.

| Below `sm`       | What basalt does                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `PageBar` row 1  | breadcrumb · the `primary` action as an icon · ONE kebab holding every `more` action      |
| `PageBar` row 2  | `ViewTabs` full-width (a `Select` past three options) · one inline pill · `Filters (n)`   |
| a section header | title · count · one inline action, the rest in a kebab; tabs past three become a `Select` |
| a widget header  | value + delta wrap under the title; the sparkline drops to bleed; one `⋯` action          |
| a sheet row      | full-width, `sheetRowHeight`, applies immediately                                         |

Every swap is CSS inside the control (one mount), never a JS media query — a media-query hook renders
differently on the server than on the first client paint. Two mounts under
`visibleFrom`/`hiddenFrom` is `basalt/responsive-twin`.

## Sidebar blocks

A non-destination list, a progress meter or a bespoke node in the sidebar is a `SidebarBlock` —
declared data, three kinds (`list` / `progress` / `custom`), placed `'nav'` or `'bottom'`. Because it
is data, basalt owns what a `ReactNode` slot could not express: a rail dot or ring when the desktop
sidebar is collapsed, a persisted fold, and one More-sheet row per block on mobile opening a sheet of
its items. A `custom` block is desktop-only, by design.

## Anti-patterns

| Instead of                                            | Write                                                |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `useState` + a `SegmentedControl` in the page body    | a store field + `ViewTabs` in the home's `tabs` slot |
| a raw `Select`/`MultiSelect`/`Chip.Group` as a filter | `SelectFilter` / `MultiSelectFilter`                 |
| `<X visibleFrom="sm"/>` beside `<X hiddenFrom="sm"/>` | one control — the swap is already inside it          |
| `size="xs"` on a button in a home slot                | nothing; the home sets the tier                      |
| a hand-written `presetToParams`                       | `field.toWindow(value)`                              |
| a hand-counted `Filters (3)` badge                    | nothing; `FilterSet` derives it                      |
| `overflowX: 'auto'` on a filter row                   | nothing; the fold is basalt's                        |
| a local `Section` / `PageHeader` / `RefreshButton`    | `Section` / `PageBar` / `SyncButton`                 |
| an in-body `<Title order={1}>`                        | the route's breadcrumb title                         |
| a hand-built joined button row                        | `ControlGroup` (or `group: true` on the actions)     |

---
source: basalt-ui
description: Where an interactive control lives and how it binds — homes, slots, store-bound filters and tabs, aside, sidebar blocks.
paths:
  - 'src/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `bun scripts/check-coverage.ts --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — raw-selection-control · oxlint rules — basalt/bound-control-outside-home, basalt/control-outside-home, basalt/control-size-literal, basalt/hand-rolled-filter, basalt/responsive-twin -->
<!-- not guarded: C1 as a cross-file law (a control placed in one file, its home declared in another) -->
<!-- not guarded: hand-rolled section headings (argo writes `<Text fw={600} size="sm">` + children, which no AST heuristic matches without false positives) -->
<!-- not guarded: C11 — a table/list stating its count when it is not a BasaltDataTable -->
<!-- not guarded: C12 — one shape for refresh/sync (SyncButton); only the alias table sees a renamed copy -->
<!-- /basalt:coverage -->

# Basalt Controls

A control has one home and takes its state from a store field; the home sets its size.

## Homes

- A control lives in exactly one home: a `PageBar` slot (`actions`, `sync`, `filters`, `filtersEnd`, `tabs`), a `Section` slot (`actions`, `tabs`), a `WidgetHeader`/`ChartCard`/`StatCard`/`BasaltDataTable` `actions` slot, or a form row (`SettingsRow.control`, `FormRow`, `FormGroup`). A per-row action is `BasaltDataTable rowActions` (typed data: `label`, `icon`, `onClick(row)`, `danger`, `disabled(row)`), never a `Menu`/`ActionIcon` in a column `cell`/`display` renderer. [basalt/control-outside-home]
- A raw Mantine selection control (`Select`, `SegmentedControl`, …) in a page slot is a filter without a `field`: bind the basalt filter with `field={store.field.x}`; in `SettingsRow control=` keep the Mantine control and take `[value, setValue]` from `prefs.field.x.use()`. [basalt/hand-rolled-filter] [check-theme raw-selection-control]
- A basalt filter outside a slot, `FilterSet`, `PageAside` or form row has no home. [basalt/bound-control-outside-home]
- `PageBar` `actions` holds at most 5 entries with exactly one `primary` (date navigation is `filtersEnd`, not an action); a `Section` holds at most 3 `actions`. [type PageBar] [type Section]
- A control in a home slot carries no `size`, `w`, `fullWidth`, `visibleFrom` or `hiddenFrom`; the home sizes it. [basalt/control-size-literal]
- Never render the same control twice under `visibleFrom`/`hiddenFrom`; the control swaps itself in CSS. [basalt/responsive-twin]
- A section, card or table title is a `WidgetHeader`; no in-body `<Title order={1|2}>`. [basalt/in-body-page-title]
- An overlay rendered by the parent lives in a file named `*-{modal,drawer,popover,panel,form}.tsx`, or opts out with `theme-allow-file control-outside-home — overlay`. [basalt/control-outside-home]
- A form dialog is a `defineOverlays` entry (augment `BasaltRegister` `overlays`) opened with `overlays.open('id', props)` from a row action; its component lives in a `*-modal.tsx`. [type overlays]

## Binding

- A filter or tab takes `field={store.field.x}` and nothing else about state; `value`, `onChange` and `size` are type errors. [type ViewTabs]
- Filters are `RangeFilter`, `MultiSelectFilter`, `SelectFilter`, `SearchFilter`, `NumberFilter`, `ToggleFilter`, inside one `FilterSet` in `PageBar.filters`. [type FilterSet]
- `ViewTabs` goes in a `tabs` slot (`PageBar.tabs`, `Section.tabs`) when it switches a page or section, or in a `ChartCard`/`WidgetHeader` `actions` slot when it switches only that card's view; every other `PageBar` slot, `Section.actions` and a `FilterSet` refuse it (the lint reads the slot it is written in, not a hoisted binding). [basalt/bound-control-outside-home]
- `FilterSet` folds overflow and the mobile `Filters (n)` sheet itself; never build either. [type FilterSet]
- Import `DateRangePicker` from `basalt-ui/controls-dates` and pass it as `RangeFilter` `customPicker`; never import `@mantine/dates` in a shared module. [type RangeFilter]
- Refresh is `SyncButton`: `scope="page"` in `PageBar.sync`, `scope="global"` in the shell's `globalActions`. [type SyncButton]
- Actions are typed data (`BarAction[]`), never children. [type BarAction]

## Aside and sidebar

- `PageAside` is the shell's right region; it takes a required `title`. [type PageAside]
- A sidebar list, progress meter or custom node is a `SidebarBlock` in `BasaltShell sidebarBlocks`, never a `ReactNode`. [type SidebarBlock]

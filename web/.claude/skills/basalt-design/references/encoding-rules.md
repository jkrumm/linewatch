# Encoding rules

Checkable sentences. Each one is a reviewer fail.

## Nine non-negotiables

1. One axis per chart; never a dual axis.
2. Colour follows the entity, never its rank.
3. Categorical colours come in fixed order and never cycle; the ninth series folds into "Other".
4. Sequential scales are one hue, light to dark.
5. Diverging scales are two hues with a neutral grey midpoint.
6. Never a rainbow.
7. Status colours are reserved for status, and always paired with an icon or word, never colour alone.
8. Text wears text tokens (`VX.*`), never the series colour.
9. Markers are at least 8 px; hit areas at least 24 px.

## Tooltips enhance, never gate

- Every value is reachable without hover: direct labels, a caption under the segments, or a `BasaltDataTable` alongside.
- A tooltip shows the same content on keyboard focus as on hover.
- One tooltip for all series at a point (`chartCursor` on lines, the mark itself as hit target on bars).
- Values lead, labels follow ("12.4 K sessions", not "Sessions: 12.4 K").
- Label text is set as text, never as HTML.

## A refetch keeps the frame

- On refetch hold the previous render (React Query `placeholderData: keepPreviousData`); dim it, do not blank it.
- Skeletons are for the first load only, at the final footprint; there is no layout jump when data arrives or refreshes.
- A refetch that fails over existing data keeps the data and flags the failure (the `query` prop of `StatCard`, `Section` and `BasaltDataTable` branches this way); only no-data-and-failed shows the error.
- `StatStripCell` `stale` dims a cell while placeholder data shows.

## Filter grammar

- One left-aligned filter row above what it scopes (`PageBar` `filters` from `basalt-ui`; `FilterSet` (`basalt-ui/controls`), `RangeFilter` (`basalt-ui/controls`)).
- Date range comes first.
- Filters scope everything below them; never a filter inside one chart.
- A filter that empties a view offers "clear filters" in the `EmptyState`.

## Number typography

- Hero values, row labels and body text: proportional sans, lining figures.
- `tabular-nums` only in table columns and axis ticks.
- Mono only for UPPERCASE micro-captions, times and code.
- Ticks compact from 1,000: `0 / 1K / 2K`; values compact as `1,284 / 12.9K / $4.2M`.
- Every number carries its unit inline; a rate or total carries its period.

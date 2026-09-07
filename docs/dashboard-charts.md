# Dashboard charts — tooltip, legend, axis, cursor and card history

*Moved verbatim from `CLAUDE.md` (the "dashboard runs on basalt-ui" section) to keep
that file under its size budget. The one-line rules stay there; this is the why.*

- **`ChartTooltipFloat` portals to `document.body`, and is safe anywhere.** Its
  predecessor `ChartTooltip` was a plain `<div>`: rendered inside `<svg>`, React
  created it in the SVG namespace, so it mounted, took its props, threw nothing —
  and was never painted. `latency-band-chart.tsx` carried eight authored tooltip
  rows nobody had ever seen, and nothing caught it (it typechecks, it lints, the
  chart is correct in every other respect).
  **What the fix surfaced is the part worth keeping in mind:** the first time
  those rows were reviewed against the marks they name, one disagreed — the
  vantage row painted an `unknown` verdict amber while the rail draws it neutral.
  A mark that renders and a legend that does not are not independently reviewable.
  The structural answer is now the framework's: `series` is the single source of
  truth, the legend and the per-series tooltip rows are DERIVED from it, and marks
  draw `ctx.visible` — so a swatch cannot name a colour its mark does not have.
  `basalt/chart-legend-literal` reports (at `warn`) any `ChartLegend` items array
  that is not derived from `series` — including, since 1.20.0, a `.map()` over some
  other array. The two strips' four-STATE legends are `BandStripSeries[]` handed to
  `BandStrip`, which derives the legend, each band's fill AND the one tooltip row
  from that same array — so a retuned state cannot leave its swatch behind. The
  throughput chart's three marks are a `ChartSeries[]` doing the same job on
  `MirroredBars`. `speed-chart.tsx`'s reference legend —
  the one legend on this page that `ChartFrame` cannot own, because `MultiLine`
  draws `refLines` but names none of them — goes through the shipped
  `deriveLegend(refSeries)` over the same array the rules are drawn from. Delete
  that block the day `refLines` takes a `label`.
- **Every chart on the cursor shows a tooltip, and exactly one of them announces
  it.** For three releases only the pointer's own chart did: this directory drew a
  value chip on every synced sibling (`charts/synced-tip.tsx`) until the 1.15.0
  rebuild made tooltips source-only, and hovering a spike then moved a bare line
  across four charts with numbers on one — the position without the reading.
  `tooltip.onFollow` (1.18.0) is the shipped answer and **all six charts take it as
  a prop now** — the app-side `useFollowerTooltip`/`tooltipAnchor`
  (`charts/follower-anchor.ts`) that reproduced it for the three hand-composed
  charts is deleted with them. The `aria-live` half came with it: a kind gives the
  live region to the cursor SOURCE alone, where four hand-composed charts once fired
  four live regions on every cursor move.
  **One half is still ours, and it is pinned by `charts/follower-tooltip.test.ts`:**
  - **A follower off screen renders nothing** (`charts/use-in-viewport.ts`, which
    tracks the NODE — a version keyed on a `RefObject` ran its effect once on mount
    and never observed an element that appears later).
    `ChartTooltipFloat` still has **no viewport gate of its own**, and it keeps a
    tooltip inside the window, so an unconditional `onFollow: true` does not quietly
    draw off screen — it draws *clamped into view*, over a tooltip the reader is
    looking at. Measured: the Throughput chart at y=1501 in an 1100px viewport put
    its tooltip at y=997, on top of Speed's at y=1015. Every chart therefore passes
    `onFollow: inView`, never `true`.
  Source charts still track the pointer; only the latency band anchors as a source
  (`tooltip.follow: false`), because three charts share its column.
- **`components/status-bar.tsx` is the one standing deviation from that rule, and it
  carries the accessible half with it.** The page opens on a six-cell bar (verdict,
  latest cycle, and the four headline numbers), so a KPI gets ~230px; `StatCard` puts
  its label and its `menu` slot in one `wrap="nowrap"` Group, which already squeezed at
  328px. The card cannot render its own header at bar density, so the cells are
  hand-rolled and the comparison sits under the value. What that would have cost is
  `StatCard.tone` — so `Cell` reproduces the 3px `VX.status[tone]` rail **and** copies
  `StatCard`'s `VisuallyHidden` threshold sentence verbatim, and
  `status-bar.render.test.tsx` pins it. A rail nothing announces is the exact defect
  `StatCard.tone` was adopted to remove; re-introducing it silently is the failure mode
  here, not the hand-rolling. One card idiom still holds — the bar is one card. **The
  deviation is the CARD, never the heading**: each cell's label is a shipped
  `WidgetHeader tier="widget"` (law C8), which is what makes the bar twelve real `<h3>`s
  a screen reader can list rather than twelve unmarked uppercase strings — the same test
  pins that per label rather than by count, because the cell list renders twice (a
  `SimpleGrid` below `xl`, a divided `Group` above it).
- **A single-plot cartesian chart composes `CartesianChart` and draws only marks —
  this is lint-enforced, not a preference.** `basalt/hand-rolled-plot` fails the
  build on an axis, overlay or crosshair primitive in a file that does not compose
  it, because that primitive already owns the measured margins, both y scales, the
  axes, the grid, the page-shared cursor, the crosshair and the tooltip.
  `latency-band-chart.tsx` is the one chart here that fits: it declares six series
  and draws four marks, and everything else went. **Every chart on this page is now
  on a shipped kind, and the 11 `hand-rolled-plot` waivers are gone with them.**
  Three of them assembled their own plot for three releases — two strips with no y
  dimension at all, and a throughput chart whose two panes are scaled
  *independently* against one baseline, neither of which `CartesianChart` can
  express. basalt-ui 1.23.0 ships both shapes as kinds (`BandStrip`,
  `MirroredBars`), designed against these call sites, so the argument is now the
  framework's and the waivers retired rather than being re-justified. **Do not
  hand-compose a plot again**: if a shape does not fit, the answer is a kind
  upstream, not a waiver here.
- **A chart's axis label and its scale key are two different things, and as of
  basalt-ui 1.17.0 nothing on this page confuses them.** Every chart renders its
  domain through a formatter: the four bucketed ones keep the bucket's ISO start
  as the scale domain (and therefore as the cross-chart cursor key) and draw it
  with `lib/axis.ts`'s `bucketTickFormat`, all four through `formatX` now that no
  chart here composes its own axis; the two run-series charts key on `runAxisKey`
  (the run's ISO instant) and
  draw it with `runTickFormat`. Before any of those seams existed, `fmtAxisDate` reduced an ISO
  string to `DD.MM` — a 24 h window drew `01.08` a dozen times — and a
  *pre-formatted* label was the only thing that reached the axis, forcing one
  string to be display, identity and hover key at once. **What that cost is the
  thing to remember**: identity had to be unique, so a *display* string carried a
  seconds tiebreak and then a UTC-offset suffix for the DST fall-back hour, purely
  so two runs could not collapse onto one x position and silently drop a
  measurement. Keying on the instant says it instead, and buys the page cursor with
  it. The same rule applies to the tooltip header — see `formatHeader` below.
- **Every chart on the page now shares one cursor, and the last two joined by
  becoming instants.** The Speed views sat in a `ChartCursorScope` for most of this
  project's life — their x-axis is speed-test RUNS, and their key was deliberately
  shaped so `Date.parse` would reject it. Both are gone: a latency spike now marks
  the run nearest it and a run marks the bucket it landed in. **What that does not
  buy is horizontal alignment, and the limit is the framework's**: every cartesian x
  scale in basalt-ui is a `scalePoint` over the domain's keys, so 24 runs are 24
  evenly spaced positions whatever the real gaps between them — the bucketed charts
  only look proportional because their domain IS a regular grid. The cursor lands on
  the right run at a different screen x, and both cards' tooltip copy says so.
  Identity also moved from a row id to a millisecond, which the 5-minute speedtest
  rate limit makes structural rather than lucky; `lib/axis.ts` and `lib/axis.test.ts`
  are where that argument is written down. The heatmaps still join no cursor — they
  hit-test per cell and never broadcast.
- **The tooltip header formats from the instant, never from the key.**
  `TooltipHeader` regexed `YYYY-MM-DD` out of the domain value and rebuilt a LOCAL
  `Date`, so a UTC ISO key named the previous calendar day for every bucket after
  22:00 local while the axis, the badge and every sibling named the current one
  (measured, `TZ=Europe/Berlin`: axis `02.08 01:00`, header `Sat Aug 1 2026`). The
  latency band answered that for one release by keying its domain in local time
  with the offset written out — correct, and it cost the chart a key its siblings
  did not share. `tooltip.formatHeader` is the seam; `charts/tooltip-header.test.ts`
  pins both halves. **Re-keying a domain to make a formatter come out right is the
  regression here**, not the wrong date.
- **Every chart picks tick VALUES, and none of them measures itself to do it.**
  `smartTicks` spaces x ticks by `VX.minPxPerTick` (55), sized for the bare `DD.MM`
  basalt's own formatter produces; `bucketAxisLabel` draws `DD.MM HH:MM` at ~72px
  on the bucketed charts and `runTickFormat` the same on the run ones, so the
  default overlaps end to end. A tick COUNT cannot fix it either —
  `smartTicks`/`smartTicksEvery` append the final key unconditionally, so at every
  count the last two labels print on top of each other at the right edge. All six
  charts pass `lib/axis.ts`'s `axisTickValues` as `xTickValues` (basalt-ui 1.23.0,
  on `CartesianChart`, `MultiLine` and both band kinds alike), which is handed the
  chart's own resolved plot width. That deleted `fitTickCount` and the three
  `useChartSize` boxes that existed only to estimate a width for it.
- **`densifyBuckets` tolerates an overlapping window and rejects a wrong grid — two
  causes, one symptom.** A row landing on no slot used to throw either way, and one
  of the two causes is routine: `keepAcrossTimeAdvance` serves the previous window's
  answer as `placeholderData` when the window steps forward, so its oldest rows fall
  before the new `from`. On the 24 h range that is one 5-minute step, and it took the
  page down with `1 of 288 rows landed on no slot` **every five minutes** (a
  placeholder chaining for an hour threw `13 of 288`). Two individually correct
  designs: densify's docblock asserted "the server filters `ts >= from AND ts <= to`",
  which the query layer quietly violates by design. So the check is split — off-grid
  *inside* the window still throws (nothing legitimate produces it), on-grid *outside*
  the window is skipped. The cost, accepted: while a placeholder is on screen the
  newest slot has no row and reads "not measured" for well under a second.
- **Loading is a third state, and every reachable path renders it.** "Nothing
  measured yet" and "measured, and nothing was there" are different facts, and a
  query in flight must never render as the second. `?? []` on a query result is
  how that rule breaks: an empty bucket array densifies to a fully-hatched *not
  measured* window, `windowDowntime([])` returns a perfectly defined `0`, and an
  absent `status` used to render "No cycle has reported what it measured
  through" — each a finding about the line, asserted over a question nobody had
  asked. The rule is one; the sentinel varies with the component's shape, which
  is a known wart rather than a discovery: charts and tables take `isPending`,
  `CoverageCallout` takes a `'pending'` string, `Stat.value` takes `null`, and
  the card-owning components (`StatusBar`, `LiveChip`, `VantageCard`,
  `LinkComparison`, `pathStats`) treat `null`/`undefined` as *not asked yet*.
  **Guard even where a route loader makes the state unreachable** — the loader
  guarantee is route config that a later edit can silently remove, and the cost
  of being wrong is this dashboard announcing that the collector is dead. Every
  chart on the page carries the guard now; `charts/pending.render.test.tsx` pins
  all of them. **Every one of them hands `isPending` straight to the framework.**
  It used to take an app-side `PendingChart` branched OUTSIDE the measuring
  wrapper, because inside the render prop nothing mounted until a `ResizeObserver`
  fired and a pending state no server-rendered guard can observe is one that gets
  quietly deleted. `ChartFrame` floors its plot rect at `minWidth` (200px), so it
  renders `ChartPending`, drops the legend and sets `aria-busy` whether or not
  anything has been measured. What the tests assert alongside the caption is the
  dropped LEGEND, not the accessible label: `ChartFrame` keeps `ariaLabel` on its
  container while pending, deliberately, so a screen reader is told what is
  loading.
- **A fold carries its unmeasured members.** The three bucketed strips downsample
  to fit a narrow viewport. The GROUPING is basalt's since 1.23.0 (`fold: { merge }`
  on both band kinds, with `foldBands` exported so a merge is tested against the
  arithmetic that actually runs); only the merge is ours, deliberately — whether a
  folded slot's value is a max, a sum or a rate recomputed from summed parts is a
  question about the measurement. **`foldedFrom`/`unmeasuredMembers` ride on the
  datum from CONSTRUCTION, not out of the merge**: `getBand`/`getAbsentFraction` are
  handed a datum and nothing else, so an unfolded slot has to answer the same
  question a folded one does. That is ~4 lines per chart and it is not optional. A
  fold that calls a group measured
  because *any* member was measured paints an unmeasured stretch as clean — the
  founding fabrication, and on the `all` range it triggers below ~830px, not just
  on a phone. So every fold carries `unmeasuredMembers`, splits its column
  proportionally (`absentFraction` on both kinds), and scales the tooltip
  denominator by `foldedFrom` (a summed `count` against a per-bucket
  `expectedCycles` prints "30 of 10"). The mirror
  lie — a two-thirds-measured column drawn wholly unmeasured — is equally
  forbidden. Both are pinned by tests. Folding also changes the chart's hover key
  space, and **that half is no longer ours to patch**: the app used to carry a
  source→folded key index (`charts/fold.ts`) so a folded strip could resolve a key
  the unfolded latency band broadcast, first by reading `HoverContext` directly and
  later through `useHoverSync`'s `resolveKey`. `useChartCursor` resolves on the
  parsed domain instead. **The mode is load-bearing and every synced chart here
  declares it.** A folded column is keyed by its FIRST member (deliberately — a
  midpoint key would fabricate a bucket start), so under the default `'nearest'` a
  source bucket in the back half of a group resolves to the NEXT column and up to
  half the band's keys put a follower's crosshair one column right. `getX` returns a
  leading edge on all four of them, so all four pass `'leading'` — strict
  containment, `[first, last + step)`, which is what "the column that swallowed this
  bucket" means and holds at every fold width because it is a property of the keys,
  not of the grouping. A key outside the span resolves to nothing rather than
  snapping to an end column that does not contain it. The index and its `resolveKey`
  are both deleted; the invariant it depended on (every source column accounted for
  exactly once) is still pinned directly in the three fold tests, because a fold that
  drops a column shortens the window without shortening the axis.

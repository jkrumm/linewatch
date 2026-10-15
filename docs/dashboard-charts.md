# Dashboard charts — tooltip, legend, axis, cursor and card history

*Moved from `AGENTS.md` (then `CLAUDE.md`; the "dashboard runs on basalt-ui" section) to keep that
file under its size budget. The one-line rules stay there; this is the why. Rewritten for
basalt-ui 2.10.0 in the migration's Wave 8: where a 1.x mechanism is gone, the bullet keeps the
lesson and names what replaced it.*

- **A mark that renders and a legend that does not are not independently reviewable, so the
  legend is derived.** On 1.x the tooltip primitive (`ChartTooltip`, a plain `<div>` inside
  `<svg>`) mounted into the SVG namespace and was never painted: `latency-band-chart.tsx` carried
  eight authored tooltip rows nobody had seen, and nothing caught it. The first review against
  the marks found a row painting an `unknown` verdict amber while the rail drew it neutral.
  The structural answer survives the port: `series` (`states` on the strips) is the one source,
  and the legend, each band's fill and the tooltip rows are derived from that array, so a
  retuned state cannot leave its swatch behind. `ChartTooltipFloat`, `ChartLegend` and the
  `basalt/chart-legend-literal` rule are gone in 2.x; `speed-chart.tsx`'s reference legend rides
  on `RefLine.legend`, so swatch, dash and label are one record.
- **Every chart on the cursor shows a tooltip, and exactly one of them announces it.** For three
  1.x releases only the pointer's own chart did, and hovering a spike moved a bare line across
  four charts with numbers on one — the position without the reading. `tooltip.onFollow` is the
  shipped answer and all six charts take it; the `aria-live` half comes with it (a kind gives the
  live region to the cursor SOURCE alone).
  **One half is still ours, pinned by `charts/follower-tooltip.test.ts`:** a follower off screen
  renders nothing (`charts/use-in-viewport.ts`, which tracks the NODE — a version keyed on a
  `RefObject` ran its effect once on mount and never observed an element that appears later).
  On 1.x `ChartTooltipFloat` clamped a tooltip into the window, so an unconditional
  `onFollow: true` drew it *clamped into view*, over the tooltip the reader was looking at
  (Throughput at y=1501 in a 1100px viewport put its tooltip at y=997, on Speed's at y=1015).
  Every chart passes `onFollow: inView`, never `true`. **Not re-measured on 2.x** — the gate
  stays as a precaution until someone removes it and looks.
  `tooltip.follow: false` (a source-only anchor for the latency band) has no 2.x equivalent and
  needs none: 2.x hard-wires the tooltip to the cursor column (`anchor: 'group-center'`), so all
  charts line up on the instant being read.
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
- **The app draws marks, never a plot.** On 1.x `basalt/hand-rolled-plot` failed the build on an
  axis, overlay or crosshair primitive in a file that did not compose `CartesianChart`, and three
  charts carried waivers for three releases (two strips with no y dimension; a throughput chart
  whose two panes scale independently). 1.23.0 shipped both shapes as kinds (`BandStrip`,
  `MirroredBars`) and the waivers retired. On 2.x the rule itself is retired because the concern
  is unrepresentable: every chart is `CartesianChart`/`Lines`/`BandStrip`/`MirroredBars`/
  `Heatmap`/`Sparkline`, engine marks come from `@tanstack/charts/*` only
  (`basalt/chart-engine-boundary`), and `latency-band-chart.tsx` is the one chart with consumer
  `marks`. **If a shape does not fit a kind, the answer is a kind upstream, not a waiver.**
- **A chart's axis label and its scale key are different things; x is the instant.** Every chart's
  x is a `Date` (a bucket's start, a run's `ts`) drawn through `lib/axis.ts`'s `bucketTickFormat`
  / `runTickFormat`, never a pre-formatted label. On 1.x one string had to be display, identity and
  hover key at once, so a *display* string grew a seconds tiebreak and a UTC-offset suffix for the
  DST fall-back hour, purely so two runs could not collapse onto one x position and silently drop
  a measurement. Keying on the instant says it directly and buys the page cursor with it. Same
  rule for the tooltip header — see `formatHeader` below.
- **Every chart shares one cursor, keyed on the instant.** The Speed views were the last holdouts
  (their x was speed-test RUNS, deliberately shaped so `Date.parse` would reject it); once x is an
  instant a latency spike marks the nearest run and a run marks the bucket it landed in. The group
  is basalt's default `chartCursor()`; `ChartCursorScope` is gone (`cursorGroup` opts a chart
  out; nothing here does). **Alignment is not shared:** a `Date` x is a proportional scale over
  the data's OWN extent, so the run charts (first run to last) put the crosshair at a different
  pixel column than the bucketed ones (whole window) — same instant, different x (24h: 974 / 1005
  / 1042 px). The fix is an upstream `xDomain` (ledger row 99). The heatmaps join no cursor — they
  hit-test per cell and never broadcast.
- **The tooltip header formats from the instant, never from the key.**
  1.x's `TooltipHeader` regexed `YYYY-MM-DD` out of the domain value and rebuilt a LOCAL
  `Date`, so a UTC ISO key named the previous calendar day for every bucket after
  22:00 local while the axis, the badge and every sibling named the current one
  (measured, `TZ=Europe/Berlin`: axis `02.08 01:00`, header `Sat Aug 1 2026`). The
  latency band answered that for one release by keying its domain in local time
  with the offset written out — correct, and it cost the chart a key its siblings
  did not share. `tooltip.formatHeader` is the seam; `charts/tooltip-header.test.ts`
  pins both halves. **Re-keying a domain to make a formatter come out right is the
  regression here**, not the wrong date.
- **Tick thinning is basalt's.** The 1.x `axisTickValues` (a width-aware tick picker handed to
  `xTickValues`) existed because `smartTicks` spaced ticks for a bare `DD.MM` and the app's
  `DD.MM HH:MM` labels (~72px) overlapped end to end, and a tick COUNT could not fix it because
  the final key was appended unconditionally. 2.x `xTicks` takes values, not a width callback, and
  basalt thins the labels itself; `axisTickValues`, `AXIS_LABEL_PX` and `fitTickCount` are deleted.
  Checked at a 352px chart width, 24h/7d/30d: no overlap on any chart (tightest 5–8px, latency
  band and speed at 30d; bufferbloat falls to two labels at 30d).
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
  how that rule breaks: an empty bucket array densifies to a fully *not
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
  all of them. **Every one hands the pending state straight to the framework** as
  `state={{ pending: true }}`; a pending state no server-rendered guard can observe is one that
  gets quietly deleted, so the tests render it with `renderToStaticMarkup`. Since 2.10.0 the
  pending legend is basalt's to hide (row 89), so no chart passes `legend: false` any more (it stays in the DOM, `visibility: hidden`).
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
  space: a folded column is keyed by its FIRST member (deliberately — a midpoint key would
  fabricate a bucket start), so under the default `'nearest'` resolution a source bucket in the
  back half of a group would resolve to the NEXT column and put a follower's crosshair one column
  right. Strict containment (`[first, last + step)`) is what "the column that swallowed this
  bucket" means; on 2.x only `latency-band-chart.tsx` declares it (`cursorResolution="leading"`).
  **Whether the two strips and throughput need the same on 2.x is not pinned by any test** — they
  take the default. The invariant that matters is pinned directly in the three fold tests, against
  the real `foldBands`: every source column accounted for exactly once, because a fold that drops
  a column shortens the window without shortening the axis.

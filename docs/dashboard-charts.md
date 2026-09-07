# Dashboard charts — tooltip and legend history

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

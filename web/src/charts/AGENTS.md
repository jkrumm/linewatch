# web/src/charts — Agent Instructions

Read this before adding or changing a chart. The lint gate and the basalt-ui guards are in
[`web/AGENTS.md`](../../AGENTS.md); the page that hosts the charts is in
[`web/src/routes/AGENTS.md`](../routes/AGENTS.md).

- **Charts are basalt's kinds; the app draws marks, never a plot.** Every chart is on a shipped
  2.x kind — `CartesianChart` (latency band, with consumer `marks`), `Lines` (speed,
  bufferbloat, status-bar `Sparkline`s), `BandStrip` (both strips), `MirroredBars`
  (throughput), `Heatmap` (both heatmaps). Engine marks come only from the allowed
  `@tanstack/charts/*` subpaths (`basalt/chart-engine-boundary`, lint-enforced); a second chart
  host in one file is `basalt/chart-host-single`. `@visx/*` is gone from the lockfile. The 1.x
  rules `hand-rolled-plot` and `chart-legend-literal` are retired — a `theme-allow` naming a
  retired id is a dead waiver (`--audit-allows` reports it). `series` / `states` stay the single
  source of truth: legend, fill and tooltip rows derive from them, so retune the array, never a
  swatch. **If a shape does not fit a kind, the answer is a kind upstream, not a waiver.**
- **Absent is a flat fill in its own colour, legended, and never a measured state's.**
  `charts/band-shared.ts` `ABSENT_COLOR` (`VX.accent`, at `ABSENT_ALPHA`) is the strips' and the
  latency band's; throughput passes `absentState` with `THROUGHPUT_ABSENT_COLOR` (`VX.status.warn`)
  because `ABSENT_COLOR` is its download hue. Each is pinned by a test. The 1.x hatch is gone with
  `CategoryGrid`; on the speed heatmap _failed_ (amber) and _absent_ (neutral) each have their
  own `getState`/`states` fill since 2.11.0 (D2 closed — `docs/waves/evidence/w9.md`).
- **Every chart takes `tooltip.onFollow: inView`, never `true`.** `onFollow` is basalt's
  boolean (a follower shows its tooltip while a sibling owns the cursor); `inView` is
  `charts/use-in-viewport.ts`, which tracks the NODE, so an off-screen chart does not draw over
  the tooltip the reader is looking at. `charts/follower-tooltip.test.ts` pins it as a source
  test (a follower state needs a sibling's live cursor, which `renderToStaticMarkup` cannot
  produce). The gate was measured against 1.x's clamping float; 2.x's behaviour without it is
  not re-measured, so it stays as the cheap precaution. There is no `tooltip.follow` and none is
  needed: the tooltip anchors to the cursor's column, so every chart sharing it lines up on the
  instant being read. History: [`docs/dashboard-charts.md`](../../../docs/dashboard-charts.md).
- **Axis label vs. scale key are different things.** Every chart's x is the
  instant as a `Date` — a bucket's start (`formatX`/`bucketTickFormat`) or a run's `ts`
  (`runTickFormat`). Never a pre-formatted display string as the domain key — it collapses distinct buckets/runs onto one x position and drops a
  measurement. Same rule for the tooltip header.
- **Every chart shares one cursor, keyed on the instant.** All six charts share the default
  `chartCursor()` group (no provider; `ChartCursorScope` is gone — `cursorGroup` is the
  opt-out, and nothing here uses it). A `Date` x is a proportional time scale over the data's OWN extent,
  so the speed and bufferbloat charts (first run to last run) put the crosshair at a
  different pixel column than the bucketed charts (the whole window) — same instant,
  different x; expected until basalt takes an x domain. Heatmaps join no cursor (hit-test per cell, never broadcast).
- **`tooltip.formatHeader` must format from the instant, never regex the domain
  key.** A UTC ISO key regexed for `YYYY-MM-DD` and rebuilt as a LOCAL `Date` can
  name the wrong calendar day. The strips and throughput now receive the `Date`
  itself, and so does the latency band; `charts/tooltip-header.test.ts` pins all of them. There
  is no `tooltip.label` slot, so the clock rides in the header (`fmtDateTime`).
- **Every chart keys on the instant and leaves tick thinning to basalt.**
  `xTicks` takes values, not a width callback, so each chart hands basalt every x and it
  thins the labels itself (W6, 352 px chart width, 24 h / 7 d / 30 d: no overlap on any
  chart; the tightest are the latency band and speed at 30 d, 5–8 px between four
  labels). `axisTickValues` is deleted.
- **`densifyBuckets` throws on an off-grid row INSIDE the window (a real bug) and
  skips one outside it (routine)** — `keepAcrossTimeAdvance` serves a stale window's
  placeholder data for well under a second when the window steps forward.
- **Loading is a third state, never `?? []`'d away.** "Nothing measured yet" and
  "measured, nothing there" are different facts; every chart/component takes an
  explicit pending sentinel (`isPending`, `'pending'`, `null`) and guards even behind
  a route loader guarantee. Pinned by `charts/pending.render.test.tsx`.
- **A fold must carry `foldedFrom`/`unmeasuredMembers` from construction and key by
  its FIRST member with `'leading'` containment.** Never mark a folded group
  measured because any member was, and never let a fold silently drop a column.
  Pinned by the three fold tests.

  Implementation history and the measurements behind these rules:
  [`docs/dashboard-charts.md`](../../../docs/dashboard-charts.md).

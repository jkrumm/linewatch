# Baseline on basalt-ui 1.41.0

Recorded 2026-10-15 on `master` at `a03621a`, nothing changed (Wave 1 is evidence only). Every later
wave compares against this file.

## Gates

| Gate | Result |
|-|-|
| `make check` | green: root `tsc`; `web` `tsr generate` + `tsc -p tsconfig.app.json` + `tsc -p tsconfig.node.json`; `bun test ./src ./collector` 577 pass / 0 fail / 32 files (1460 expects); `cd web && bun test` 343 pass / 0 fail / 31 files (5937 expects) |
| `cd web && bun run lint` | `oxlint .` clean; `✓ Theme guard: no off-palette colors.` |
| `basalt-ui doctor` (`web/node_modules/.bin`) | 6 checks, `All checks passed.` (manifest, version match 1.41.0, guard-scan 57 files, oxlint preset, lefthook check-theme job, ai-major-parity) |
| `cd web && bun run build` | green, 1.17 s; one warning, chunks over 500 kB (`index`) |

The Wave 2 head must reproduce: 343 web tests (D4: tests are not typechecked, `bun test` is its own
gate) and root 577.

## Bundle (`web/dist/assets`, gzip -9)

| Asset | Raw B | gzip B |
|-|-|-|
| `index-*.js` (app + vendor) | 760277 | 231954 |
| `routes-*.js` | 442287 | 142133 |
| `react-markdown-*.js` | 112036 | 33446 |
| `remark-gfm-*.js` | 38277 | 11416 |
| `dist-*.js` | 12512 | 4154 |
| `lib-*.js` | 4146 | 1809 |
| ~20 shiki-language / theme stubs (`*_basalt-ui-*.js`) | 118–136 each | ~130 each |
| **JS total (all `.js`)** | **1372859** | **429148** |
| `index-*.css` | 249637 | 39048 |
| `routes-*.css` | 31876 | 5857 |
| **CSS total** | **281513** | **44905** |

Fonts (woff2, hubot-sans, jetbrains-mono, nunito-sans, 5 + 3 + 5 files) are not in the totals.
`react-markdown` and `remark-gfm` ship as chunks although `src/` never imports them (they come
through `basalt-ui/content`); Wave 2 drops the five deps `src/` does not import, so expect those two
chunks to move, not necessarily vanish.

## `USE_MOCK` (D3): seeded, but not reproducible

`web/src/lib/api.ts:37` is `const USE_MOCK = false` — a source edit, not a runtime switch, so a mock
capture needs a local uncommitted flip (never committed; master deploys on push). The generator
(`web/src/lib/mock/generate.ts`) uses `mulberry32` hashed noise keyed by (kind, target, time bucket),
**but anchors everything to `const NOW = Date.now()` captured at module load** (line 36). Two page
loads a minute apart therefore describe different worlds; **marks are not byte-identical across
loads.** For a byte-comparable chart-mark capture a later wave must pin `NOW` (a one-line local
edit, uncommitted, or a captured fixture); live-container captures (this file) are for look-and-feel,
not for byte equality.

## D1(c): can rollhook CD be paused for this repo? No switch found

- Nothing in this repo triggers a deploy: `.github/workflows/` holds only `check.yml` (PR + master
  `check`, no deploy job, no `rollhook` reference); `docker-compose.yml` has no rollhook label.
  The only mentions are prose (`AGENTS.md`, `docs/DESIGN.md`, the `make deploy` echo).
- rollhook's own README (`~/SourceRoot/rollhook/README.md`) documents `POST /deploy` (bearer) and the
  GitHub-Actions OIDC token exchange, and no pause / maintenance / skip setting (env table: image and
  log retention, URL, notification hooks). So the trigger lives outside this repo and offers no
  documented off switch.
- Consequence: D1(c) is unavailable; the decision stands on D1(b) (`basalt-2` branch, merge once at
  Wave 10). Nothing was paused.

## D2: `BandStrip` absent share in 2.8.0 / 2.8.1, evaluated on paper

Sources: `basalt-ui@2.8.1` tarball (`npm pack`, unpacked outside the repo): `MIGRATING.md` § 2.8.0
("`BandStrip` absent share"), `dist/charts/BandStrip.d.ts`, `dist/charts/BandStrip.js`. Invariant
(AGENTS.md): *not measured never looks like zero or good*. 2.7.3 had no way to say it; ledger row 64
was filed for that.

**What shipped.** `BandSpan.absentFraction` (0..1, painted from the band's right edge) plus
`absentState="<states key>"` on the strip. The absent share is `alpha(absentSeries.color,
absentSeries.fillOpacity ?? 1)` (`BandStrip.js:67-71`), legended through the `states` entry, and
adds its own tooltip row (`absentState` doc: "a band in another state paints its share in this
state's color, and the tooltip adds this state's row"). A band whose own state *is* the absent key
gets share 0 and is just a flat-filled band (`absentShareOf`, `BandStrip.js:38-39`). Hatch stays
removed (`hatchFill`, `HatchPattern`, `hatchSizeFor`). `fold.merge` keeps the first datum's `x`, so
the repo's `foldedFrom`/`unmeasuredMembers` bookkeeping maps one-to-one onto
`absentFraction = unmeasuredMembers / foldedFrom` (what both strips already compute at
`availability-strip.tsx:159`, `link-speed-strip.tsx:196`). Both strips' `getBand` bodies need only
drop `mark` from the series and keep `absentFraction`.

**Verdict: the invariant can be kept — conditionally. Not a blocker for Wave 4; four conditions
the port must meet (each is a decision Wave 4 records, not a ledger row yet).**

| # | Finding | Status |
|-|-|-|
| 1 | The absent paint is the consumer's own `color` + `fillOpacity` on the `absent` series; basalt's doc says "color it `VX.neutral`". The availability strip's *clean* state is also `VX.neutral` at `CLEAN_ALPHA = 0.14`; absent is `VX.neutral` at 0.5 today. 2.x separates them by alpha only (3.5x), where 1.x also had hatch. | **Wave 4 decision.** Keep absent visibly stronger than clean and verify on the screenshot (both schemes); if the pair is not distinguishable in light mode, pick a different absent colour, which the API allows (`color` is free). Do not follow the doc's `VX.neutral` blindly. |
| 2 | A *fully* unmeasured band (`state: 'absent'`) has no right-edge position cue — the doc's "reads as no data by hue and by position" holds only for the partial share. Whole-band absent = flat absent colour, indistinguishable from "partial" except by width. | Acceptable: legend + tooltip name it ("Not measured"); but the screenshot must show a fully absent column next to a clean one. |
| 3 | A legend toggle of the absent state sets its share to 0 (`resolveAbsent`: `isVisible(absentKey) ? share : 0`), so a reader can hide absent and a folded band then reads as fully measured. The legend is the user's control, not a data fact. | Check whether `legend` can be made non-toggleable for the absent entry; otherwise record as a ledger row (`linewatch W4`). |
| 4 | `absentState` throws in dev (`requiredProp`) when a `BandSpan` carries `absentFraction` without it; a typo in the key silently drops the share (dev warning only). | Pin with a test (`absentState` names a `states` key) in Wave 4's rewrite of `availability-strip.test.ts`. |

**Not covered by BandStrip:** the latency band chart's hatched down/absent `rect`s and `category-grid`
(heatmap) absent cells are not `BandStrip` — D2 for those is `CartesianChart` marks (Wave 5) and
`Heatmap` null cells (Wave 7), evaluated there. `MirroredBars.getAbsentFraction` exists since 2.0.0
(MIGRATING table), unchanged by 2.8.

## Guard tests → 2.x fate

| Test | Asserts today | Fate | Why |
|-|-|-|-|
| `charts/pending.render.test.tsx` | six charts render the shipped pending caption (not the grid) under `isPending`, no ref-line legend while pending, `aria-busy` kept | **rewrite (W4/W5/W6)** | `isPending` → `state` on the 2.x charts; the *property* (pending is a third state, never `?? []`) is AGENTS.md law and stays pinned; assert through each kind's `state` |
| `charts/follower-tooltip.test.ts` | source-greps six charts for `onFollow: inView` + `useInViewport`; no hand-rolled `ariaLive={cursor.isSource}` | **rewrite (W4/W5/W6/W8)** | `tooltip.onFollow` survives (Appendix B) so the grep stays valid per chart as it is ported; delete the "no hand-rolled aria-live" half only if the chart is a kind; the viewport-gate rule is re-verified against 2.x `onFollow` |
| `charts/tooltip-header.test.ts` | latency band `formatHeader: (_key, p) => fmtTooltipDate(new Date(p.bucketStart))`, key is `densifyBuckets`' ISO start, badge carries the clock | **rewrite (W5)** | `fmtTooltipDate` is deleted, `formatHeader(x, d)` takes a `ChartX`; the property (header formats from the instant, never regexes the key) stays |
| `lib/axis.test.ts` | `bucketAxisLabel`/`bucketTickFormat`/`axisTickValues`/`runAxisKey`/`runTickFormat` (pure) | **keep + extend (W4)** | no basalt import; x becomes `Date`/number so key/format helpers get a `ChartX` adapter test, existing assertions hold |
| `charts/overlay-color.test.ts` | legend and marks read one descriptor: `OVERLAY_COLOR`, strokes read `primary.color`/`overlaySeries.color` | **rewrite (W5)** | marks become `lineY` in `CartesianChart.marks`; the property (colour declared once in `series`, marks read it) stays; selectors change with `PlotContext` |
| `charts/availability-heatmap.render.test.tsx` | pending caption, resolved path, default | **rewrite (W7)** | `Heatmap` + `state` |
| `charts/throughput-chart.render.test.tsx` | same three for `MirroredBars` | **rewrite (W4)** | `state` replaces `isPending`; keep the assertions about what is measured |
| `components/status-bar.render.test.tsx` | dash-not-dead-collector while pending, threshold rail sentence, untinted = no sentence, cell labels are headings | **keep; sparkline cells rewrite (W6)** | all non-chart assertions survive; `Sparkline` `state` replaces `isPending` |
| `lib/compact.contract.test.ts` | source greps `verdict-panel.tsx`/`coverage-callout.tsx` for gates critical/warn must not acquire | **keep untouched** | no basalt chart/state dependency; the page's honesty contract |
| `charts/availability-strip.test.ts` | `getBand` colour-hue pins; imports `VX`, `foldBands` | **specifier move (W2), rewrite (W4)** | `VX` → `basalt-ui/tokens`; `foldBands` import breaks at link time on 2.x (friction #1) so Wave 2's `bun test` fails here — W2 must stub that test's fold cases with `MIGRATION-STUB(w4)`; add the `absentState` pin (D2 #4) |
| `charts/link-speed-strip.test.ts`, `charts/throughput-chart.test.ts` | `foldBands(items, cap, merge)` over the real grouping, merge measured-ness | **rewrite (W4) — blocked on basalt friction #1** | `foldBands` is documented as exported (MIGRATING 2.7.3 § table, 2.8.1) but is **absent from the published `dist`** of both 2.7.3 and 2.8.1; plan Appendix B's "kept" came from `tsc`, which does not typecheck tests (D4). Without it the `merge` cannot be tested against the real grouping; the fold tests must not be deleted, so Wave 4 either gets the symbol upstream or tests `merge` directly and records that the grouping half is unpinned |
| `charts/latency-domain.test.ts` | latency y-domain maths; imports type `ChartSeries` | **keep (W5)** | pure; type import moves/fits 2.x `ChartSeries` |
| `lib/dashboard-store.test.ts` | store behaviour, `createSearchStore` | **keep + verify (W3)** | `basalt-ui/router-tanstack` → `/state`; the fallback, `?range=nonsense` and lane semantics are the assertions |

A guard deleted without a successor is a regression: none above is a delete.

## Captures (live container, 1.41, `http://127.0.0.1:7731/`)

Raw PNGs (40 `s-*`, 24 `v-*`, 22 `t-*`) are gitignored under `docs/waves/evidence/raw/` on the mini; this is a copy of the capture index that sits beside them. Captured by a delegated agent through the Chrome DevTools MCP; counts verified with `ls`.

Captured: 2026-10-15, approx. 12:20-12:58 CEST (+0200). Target `http://127.0.0.1:7731/` (served build assets `index-y6npszch.js`, `routes-bFLGObYE.js`). Chrome DevTools MCP, read-only: no source change, no POST, no commit. Speed-test "run" button never touched.

### State recipe (how every state was reproduced)

- Range: URL `?range=1h|24h|7d|30d|all` (values verified in `web/src/lib/range.ts`). The app appends `&minDuration=0` itself.
- Colour scheme: `localStorage["mantine-color-scheme-value"]` = `light` | `dark` | `auto`. The ThemeToggle button cycles it (default after first click is `auto`, which follows `emulate colorScheme`). Used `light`/`dark` explicitly.
- Compact: `localStorage["basalt:dashboard"]` = `{"v":1,"value":{"compact":true|false}}`. Toggled in UI via the "Compact — charts and findings only" button in the page bar; absent key = full.
- Path section expand state: `localStorage["basalt:section:path"]` = `{"v":1,"value":true}` (persists across reloads; default collapsed). All `s-*` shots were taken collapsed; all `v-*path*` and `t-*` shots expanded.
- Procedure per shot: set localStorage via `evaluate_script` on the current page, `navigate_page` to the URL, poll until `document.body.scrollHeight > 800` + 2.5-4 s settle, then `take_screenshot fullPage`.
- Viewport: desktop `resize_page 1280x800`; mobile via `emulate viewport 390x844x1` (NOT `resize_page` — the window cannot go below ~500 px wide, the first mobile attempt was 500 and was redone).
- Tooltips: the charts accept synthetic `pointerover/pointermove/mousemove` dispatched at plot coordinates (hit target is a `<rect>` inside the svg); tooltips are `position: fixed` nodes in `document.body`. Tooltip text was read from the DOM (`innerText`), not OCR. Viewport screenshots (no element-level shot possible: chart svgs have no snapshot uid). Every tooltip capture hovers x=50% of the plot, y=50%, at 7d / dark / full / 1280x800.

### Files (all in this directory)

- `s-<light|dark>-<1280x800|390x844>-<compact|full>-<1h|24h|7d|30d|all>.png` — 40 full-page shots of the page in that state. Full-page height varies (compact 1512-1801 px desktop; full 2046-2385 desktop; mobile 1901-3186).
- `v-<dark|light>-<section>-<view>.png` — 24 shots, default state (24h, full, 1280x800): section scrolled to ~90 px from top, viewport shot. Exception: `v-*-latency-per-anchor.png` is full-page (section is 1117 px tall). Sections/views: uptime [timeline, outages, pattern], latency [internet, per-anchor], speed [runs, by-hour, under-load], throughput [volume — single view, no tab control], path [vantage, link, transitions]. View tab labels: "Timeline / Outages / 30-day pattern", "Internet & router / Per target (4)", "Every run / By hour of day / Latency under load", "This machine / Link speed over time / Transitions".
- `t-*.png` — 22 tooltip shots (7d, dark, full):
  - `t-availability-strip-hover` strip mid; `t-availability-strip-loss-bucket` a packet-loss bucket
  - `t-latency-internet-hover`; `t-latency-anchor-{1..4}-hover` (1 Gateway, 2 Cloudflare, 3 Google, 4 Quad9)
  - `t-speed-runs-hover`; `t-bufferbloat-hover`; `t-throughput-hover`; `t-link-speed-strip-hover`
  - `t-speed-heatmap-{measured,failed,absent,neutral4}`; `t-availability-heatmap-{worst,typical,neutral4}`
  - `t-sparklines-hover-none` (hover shows nothing); `t-shared-cursor`; `t-keyboard-focus-0-focused`, `t-keyboard-focus-1-arrowright-x3`

### Tooltips (verbatim; header first, then rows)

Locale split noted: strip/heatmap/throughput/link headers are German-locale ("11. Okt., 23:00"), latency/speed/bufferbloat headers are en-US ("Sun Oct 11 2026" then time on its own line). Values are from the live data at capture time.

| Chart | Header | Row labels (example values) |
|-|-|-|
| Availability strip | `11. Okt., 23:00` + right-aligned `Cloudflare` | No loss `0.00%` / Worst cycle `0.0%` / Measured `120 of 120 expected cycles`. Loss bucket: header `13. Okt., 13:00`, first row `Packet loss 0.42%`, Worst cycle `10.0%` |
| Latency internet (band) | `Sun Oct 11 2026` / `23:00` | Internet `5.3 ms` / Router `1.1 ms` / p5 – p95 `4.9 ms – 5.5 ms` / Worst ping `46 ms` / Loss `0.0%` / Worst cycle `0.0%` / Measured `120 of 120 expected cycles` / Folded from `3 of 3 anchors` / Vantage `Home line`. Conditional extra row seen on a partial-loss bucket: Worst single anchor `0.0%` |
| Latency anchors 1-4 | same two-line header | Series name row = `Gateway` `1.1 ms` / `Cloudflare` `5.1 ms` / `Google` `5.3 ms` / `Quad9` `5.3 ms`, then p5 – p95 / Worst ping / Loss / Worst cycle / Measured / Vantage `Home line` (no Router, no Folded from) |
| Speed runs | `Sun Oct 11 2026` / `23:04` | Download `550.8 Mbps` / Upload `206.4 Mbps` |
| Bufferbloat | `Sun Oct 11 2026` / `23:04` | Idle ping `5.0 ms` / Loaded (down) `34 ms` / Loaded (up) `31 ms` |
| Throughput (MirroredBars) | `11. Okt., 23:00` | `Carried` (header-row label) / Download `373 kB/s · 1.3 GB` / Upload `38 kB/s · 139 MB` / Measured `120 intervals · 3600s` |
| Link-speed strip | `11. Okt., 23:00` | `Link speed` (header-row label) / Negotiated speed `1000 Mbit` |
| Speed heatmap, measured | `9. Okt.` / `06` | Download `406.2 Mbps` / Below fastest hour `27.2%` / Successful runs `1` |
| Speed heatmap, failed | `12. Okt.` / `09` | Failed runs `1 — ` + the raw Ookla CLI stderr text (see Surprises) |
| Speed heatmap, absent | `8. Okt.` / `12` | `No run` / `Not measured` |
| Availability heatmap, worst cell | `24. Sept.` / `01` | Loss `20.42%` / Worst cycle `100.0%` / Cycles fully down `24` / Measured `120 of 120 expected cycles` |
| Availability heatmap, typical | `29. Sept.` / `13` | Loss `0.00%` / Worst cycle `0.0%` / Cycles fully down `0` / Measured `120 of 120 expected cycles` |
| Status-bar sparklines (3) | none | No tooltip, no hover response. Only `role=img` + aria-label: "Worst packet loss per bucket", "Median round-trip time to the internet per bucket", "Download throughput per run" |

Heatmap states in live data: speed heatmap has all three (measured / failed 1 cell / absent 1 hatched cell). Availability heatmap: no failed state and no hatched absent cell occur; cells are `--vx-bad-solid` at 14-100 % alpha (a zero-loss cell is still faintly red-tinted at 14 %). Both heatmaps also have 23 `--vx-neutral` 4 % cells with NO tooltip (left-edge padding/outside window, presumably).

Shared cursor (`t-shared-cursor`): hovering Ping at 30 % shows `Sat Oct 10 2026 11:00` there while Speed chart simultaneously shows its own tooltip `11:03` (nearest run to the same instant) — cursor is synchronised, tooltips are per chart and appear in all in-view charts at once (also strip `11. Okt.` and throughput). The availability strip's own tooltip stays pinned at the top of the viewport when other charts are hovered.

Keyboard (`t-keyboard-focus-*`): each chart's plot is a `<rect tabindex=0>` with a long descriptive aria-label (e.g. "Internet latency with Router overlaid — median with p5 to p95 band, worst-ping envelope, and unmeasured periods marked"). Focus alone shows a focus outline but NO tooltip. First ArrowRight jumps to the first bucket (`Thu Oct 8 2026 12:00`, Measured `10 of 120 expected cycles`); each further ArrowRight advances one bucket (2 more -> `14:00`); ArrowLeft goes back one (`13:00`). Keyboard drives the shared cursor (strip and speed tooltips follow). Tab moves on to the next control (legend button "Internet"), tooltips hide.

### Console / network at 24h load (Part C)

Console: 0 messages (no error, no warn, no log). Network: 27 requests, all HTTP 200, none failed (6 assets, 3 woff2 fonts, 18 `/api/*` incl. a 30-day `probes?bucket=3600` for the pattern heatmap and a prior-period set for the "vs 24h before" deltas).

### Surprises / broken-looking in the 1.41 baseline

1. **`range=all` takes ~45-55 s to load, `30d` ~11 s**, 7d ~4 s, 24h/1h ~2.6 s (page body is blank until the data arrives — `scrollHeight` 0, no skeleton). Stacked abandoned 30d/all requests saturated the server: `/health` and `/api/status` timed out for >10 s at one point, load average ~10; it recovered on its own. Two navigations hit the 10 s MCP timeout because of this.
2. **Horizontal overflow**: `documentElement.scrollWidth` is 1300 at a 1280 viewport (+20 px) and 398 at 390 (+8 px). Matches the shell inset (20/8) — the `.bleed` full-bleed of the page bar. All full-page shots are 1300 px wide on desktop.
3. **Failed-run tooltip is enormous**: 1272 x 293 px, spans the whole viewport, and contains the raw speedtest CLI stderr (licence text, Ookla privacy blurb, and `Failed to save settings: ... Permission denied "/app/.config/ookla"`). The underlying cause (container cannot write its Ookla config dir) is a real runtime fault, not a UI one.
4. **Mixed tooltip locale/format** (German "11. Okt., 23:00" vs en-US "Sun Oct 11 2026 / 23:00") across charts; axis labels use a third format ("08.10 12:00").
5. Speed chart at plot mid shows `Sun Oct 11 00:00` own tooltip while synced charts show `Mon Oct 12 00:00` (x positions are evenly spaced over runs, not time; expected per AGENTS.md but visible).
6. Zero-loss availability-heatmap cells render in a faint red tint, and "Trend lines withheld — this window has an unmeasured gap" is shown at 24h/7d.
7. Sparklines carry no tooltip at all (no hit target) — only aria-labels.
8. The router-poller warning banner ("enabled but stored no line sample in this window") is present on every state.
9. Compact mode is only ~500 px shorter on desktop; the 1h/24h/7d compact shots are 1512/1512-1567/1537-1605 px tall.

### Not captured / caveats

- Element-level tooltip screenshots: not possible (no uid on chart svgs, hover tool needs uid); viewport shots used, tooltip text recorded from DOM.
- Tooltip hover was synthetic (dispatched events), not a physical pointer; keyboard test used real key presses.
- Path section was collapsed in every `s-*` shot (default), so those show only its summary line. Throughput has no view tab; path "vantage" view has no chart tooltip captured.
- Mobile tooltips (touch behaviour) and range variants of tooltips not captured (spec: 7d only).
- `s-*` desktop 24h/1h/7d shots for the first light-scheme batch were retaken with the longer settle where the first wait was short (light 7d full/compact); 1h/30d/all re-run after a blank-page episode caused by the server saturation (see Surprises 1). Final files are all verified non-blank (heights > 1500 px).
- The browser's localStorage keys set during capture were removed afterwards.


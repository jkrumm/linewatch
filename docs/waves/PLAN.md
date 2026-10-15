# linewatch on basalt-ui 2.7.3

**Goal:** linewatch's dashboard (`web/`) runs on `basalt-ui@2.7.3` in production: all 11 chart call
sites on the 2.x kinds (`CartesianChart`, `Lines`, `BandStrip`, `MirroredBars`, `Heatmap`,
`Sparkline`), the provider, router and stores on the 2.0 contracts, `@visx/*` gone from the
lockfile, no workaround for basalt anywhere in the repo, and the dashboard's honesty properties
(absent ≠ zero, `null` ≠ 1, every verdict unconditionally visible) intact. Proven against a
recorded 1.41 baseline with screenshots, bundle bytes and a live check on the mini.

**Gate (every wave):** `make check` green (API + collector typecheck, the dashboard's `tsr generate`
+ both `tsc` projects, `bun test`) plus `cd web && bun run lint` (`oxlint . && basalt-ui check-theme`)
and `bun run build`; `/review` clean on the wave's diff; zero new `theme-allow` /
`oxlint-disable … basalt/` waivers; the wave's evidence in `docs/waves/evidence/w<n>.md`, compared
against `docs/waves/evidence/baseline-1.41.md` from Wave 2 on.

**Target:** the latest `basalt-ui` 2.x on npm at bump time (2.8.1 on 2026-10-15; carries ledger rows 61–76, incl. row 64 = the BandStrip absent share). Where this plan pins 2.7.3, pin that; claims verified on 2.7.3 stay valid.

**Decisions taken 2026-10-15 (orchestrator, under the owner's standing autonomy):**
- **D1 = (b), a `basalt-2` branch.** Wave 1 (evidence only) runs on master. From Wave 2 every wave works in a worktree on branch `basalt-2` (`git worktree add ../linewatch-basalt-2 -b basalt-2`), commits and pushes `basalt-2` only; master and production stay on 1.41 with real charts until Wave 10 merges `basalt-2` into master (rollhook CD then ships it once). The plan file travels on `basalt-2`; the orchestrator points each wave at `~/SourceRoot/linewatch-basalt-2/docs/waves/PLAN.md`. Proven on basalt-ui-obsidian (Waves 2–6). No stubs ever reach production; no CD pause needed.
- **D2 answered by basalt-ui 2.8.0 (row 64):** `BandStrip` renders an absent share as its own flat fill (no hatch) — evaluate it against "not measured never looks like zero or good" in Waves 4/5/7; a gap there is a new ledger row, not a local workaround.

- **Correction 2026-10-15 (orchestrator):** linewatch has NO CD — only `check.yml`; master ships by `make up` on the mini from an up-to-date master checkout (AGENTS.md § Deploy, fixed on master). D1's premise was wrong but D1(b) stands. Wave 10 therefore: merge `basalt-2` into master, push, then `git checkout master && git pull && make up` in `~/SourceRoot/linewatch` (authorized), then verify.

**Fleet note:** feeds basalt-ui `docs/waves/argo-friction.md`: a basalt-rooted problem becomes a row
there, prefixed `linewatch W<n>`; never worked around locally; stay exact-pinned on the 1.x pin
(`basalt-ui` 1.41.0 in `web/package.json`) until Wave 2 (the bump) runs. A chart whose behaviour a
2.x kind cannot express stays a stub until the fixing basalt minor. This file is separate from any
`docs/waves/PLAN.md`; the orchestrator activates waves.

## Ground truth and decisions

Inventory and probe numbers: Appendix A–C. Contract: basalt-ui `docs/V2-SPEC.md`; per-symbol rows:
the installed `node_modules/basalt-ui/MIGRATING.md` § 2.0.0 and §§ 2.0.1–2.7.3; chart mapping:
basalt-ui `docs/waves/v2-chart-inventory.md` rows l1–l11. Worked shape: argo's
`docs/waves/PLAN.md`.

- **D1 — Master deploys on push; the bump is atomic and stubs the charts.** rollhook CD ships every
  merged `master` push with no path filter and no pause switch in this repo, and 1.x/2.x cannot
  coexist in one app. Wave 2 therefore lands the bump with every chart file that does not compile
  replaced by a `MIGRATION-STUB(w<n>)` stub (same exported signature, `ChartCard` with
  `state={{ empty: 'Migrating to basalt-ui 2.0' }}`). **Owner decision needed before Wave 2:**
  (a) let the stubs reach production for the hours between Wave 2 and Wave 7 — the alert path is
  untouched (heartbeat, watchdog and Uptime Kuma are native/independent; only the read-only tailnet
  dashboard shows placeholders); (b) keep the migration on a long-lived `basalt-2` branch and merge
  at cutover (`rd fan`/`rd merge` base on master, so waves would need manual landing); (c) pause
  rollhook CD for this repo if rollhook has a switch (Wave 1 checks). **Tendency: (c) if it exists,
  else (a)** — a dashboard of placeholders for a few hours costs nothing alerting-wise, a branch
  costs every wave its tooling.
- **D2 — Absent-state paint has no 2.x answer yet.** `hatchFill`/`HatchPattern` are deleted
  ("absent-state paint is a flat fill"), `BandSpan` has no `absentFraction`, `BandStripSeries` has no
  `mark`. linewatch's central invariant is that *not measured* must never render like *zero* or
  *good*. Wave 1 files these as ledger rows against 2.7.3 before the bump so basalt can answer while
  Waves 2–3 run; Waves 4/5/7 take whatever the fixing minor ships. **Owner decision if no minor
  lands by Wave 4:** accept a flat neutral fill plus a legend entry as the honest encoding
  (tendency: yes — it keeps "unknown" visually distinct from every state colour, which is what
  hatch was for) or hold the cutover.
- **D3 — Real-data evidence without a second harness.** The container serves the live dashboard on
  loopback `:7731`. Baseline and comparison are captured by `@verifier` driving the Chrome DevTools
  MCP against that origin (GETs only; `POST /api/speedtests/run` is never pressed, it saturates the
  line). Same time-window and same `?range=` per capture, timestamped, because live data moves; where
  a byte-identical comparison matters (chart marks), use `USE_MOCK` if the generator is seeded
  (Wave 1 checks, and records the answer).
- **D4 — Tests are not typechecked.** `tsconfig.app.json` excludes `*.test.ts(x)`, so the 123-error
  probe undercounts: five test files import from `basalt-ui/charts` (`VX`, `foldBands`,
  `ChartSeries`) and three render tests mount charts. `bun test` is a gate in its own right, and the
  bump wave must run it, not only `tsc`.

## Wave 1 — Baseline evidence on 1.41 <!-- status: done -->

Nothing ships. The before-picture every later wave is compared against.

- [x] Record the 1.41 state: `make check` verbatim, `bun test` pass/fail/file counts,
      `cd web && bun run lint` and `./node_modules/.bin/basalt-ui doctor` output, the `bun run build`
      output sizes (raw + gzip JS/CSS total and per chunk from `dist/`), and whether `USE_MOCK`'s
      generator is seeded (D3).
- [x] Screens of the one route (`/`) via `@verifier` against the live container: light/dark ×
      1280×800 / 390×844 × compact on/off × `?range=` 1h / 24h / 7d / 30d / all, plus the section
      tab views (`DashboardSection` `ViewTabs`) — every section, every named view. Gitignored raw
      PNGs under `docs/waves/evidence/raw/`, an index with the capture time in
      `baseline-1.41.md`.
- [x] Tooltip evidence for all 11 chart rows (l1–l11 of the inventory): hover shot of each of the five
      latency-band instances, both strips, throughput, speed, bufferbloat, both heatmaps (one cell
      per state: measured / failed / absent), and the status-bar sparklines; one keyboard-focus
      capture of the shared cursor across charts. Record the tooltip header text of each — it pins
      `formatHeader` (`charts/tooltip-header.test.ts`).
- [x] Map every guard test to its 2.x fate in `baseline-1.41.md`: `pending.render`,
      `follower-tooltip`, `tooltip-header`, `axis`, `overlay-color`, `availability-heatmap.render`,
      `throughput-chart.render`, `status-bar.render`, `compact.contract` — keep / rewrite / delete,
      each with a reason. A guard deleted without a successor is a regression.
- [x] Check D1(c): can rollhook CD for this repo be paused? Record the answer (and the exact switch
      if any) — do not pause anything.
- [x] File the D2 ledger rows (absent hatch, `BandSpan.absentFraction`, `BandStripSeries.mark`,
      `tooltip.follow`, `tooltip.label`, see Appendix B "unmapped") in basalt-ui
      `docs/waves/argo-friction.md` as `linewatch W1 …` rows, or list them under **Left behind** if
      the lead cannot land the PR.

**Evidence:** `docs/waves/evidence/baseline-1.41.md`.

**Left behind:**
- Wave 1 ran on master and committed docs/evidence only (`.gitignore` gains `docs/waves/evidence/raw/`). No app code changed, nothing pushed that CD would act on beyond docs.
- 1.41 gates: `make check` green (577 root + 343 web tests), lint, `doctor` clean, build green; bundle JS 1372859 B raw / 429148 gz, CSS 281513 / 44905. Wave 2 must reproduce 343 web tests.
- D1(c): **no pause switch** (not in this repo's workflows/compose, not in rollhook's README) — moot under D1(b).
- D3: `USE_MOCK` is a hard-coded `const` in `web/src/lib/api.ts:37`, and the generator anchors on `Date.now()` at load, so mock marks are not byte-reproducible; pin `NOW` locally if a wave needs that.
- **D2 verdict (paper, 2.8.0/2.8.1 `BandStrip`):** the invariant can be kept, with four Wave 4 conditions (absent vs clean are both `VX.neutral`, separated by alpha only — pick the absent colour deliberately and look at it in both schemes; a whole-band absent has no edge cue; the absent legend toggle zeroes the share; pin `absentState` with a test). Details in `baseline-1.41.md` § D2. Plan item "file D2 ledger rows" is moot for rows 1–3 of Appendix B's unmapped list (basalt rows 64/65 answered them in 2.8.0); not re-verified: `tooltip.follow` (2.8.1 still only has `onFollow`), `tooltip.label`.
- Guard map is in `baseline-1.41.md` (none deleted; nine rewrite/keep decisions). **Wave 2 consequence:** three test files import `foldBands` from `basalt-ui/charts`, which is not in the published 2.x `dist` (friction 1) — they fail at link time under `bun test`; stub those fold cases with `MIGRATION-STUB(w4)`, don't delete.
- Baseline oddities that are *not* migration regressions, to keep out of the 2.x diff: `range=all` takes 45–55 s (30d ~11 s), blank page until data lands, and stacked abandoned requests starved `/health`; 20 px / 8 px horizontal overflow; three tooltip date formats; failed-run speed-test tooltip is 1272×293 px with raw Ookla stderr containing `Permission denied "/app/.config/ookla"` — **a real container fault** (the speedtest cannot save its settings), outside this wave's scope, unfixed.

**basalt friction** (for the orchestrator to file in basalt-ui `docs/waves/argo-friction.md` as `linewatch W1 …`; basalt-ui was not edited):
1. `foldBands` is documented as exported (MIGRATING § 2.7.0-era table, line 4252 on 2.7.3, 4373 on 2.8.1; "returns with W5 BandStrip") but is **absent from the published `dist` of 2.7.3 and 2.8.1**; `BandFold` is present. `tsc` and `doctor` pass because tests are not typechecked; only `bun test` fails. Blocker for testing a strip's `merge` against the real grouping. Plan Appendix B's "kept" was wrong for the same reason.
2. `tooltip.follow: false` (source-only anchor, five latency-band instances share a column) still has no 2.x equivalent (2.8.1 `types.d.ts` has `onFollow` only). Candidate for Wave 5, state per the instruction there.
3. MIGRATING § 2.8.0 tells consumers to colour the absent state `VX.neutral`; a consumer whose "clean/no problem" state is also neutral gets the two separated by alpha alone. Doc advice, not a bug — candidate papercut: say the absent colour must differ from every measured state.
4. Candidate, to confirm in Wave 4: toggling the absent legend entry zeroes every band's `absentFraction` (`resolveAbsent`, `BandStrip.js:41-42`), so a reader can make a folded band look fully measured. May want a non-toggleable legend entry.

## Wave 2 — The 2.7.3 bump (atomic, D1) <!-- status: done -->

One worker on one change; the lead reviews and lands it. Sized from the probe: 123 `tsc` errors in
19 files (107 in 9 chart files, 4 in `status-bar.tsx`, 12 wiring/import), 6 hard `doctor` failures,
oxlint unable to parse its own config (Appendix C).

- [x] Dependencies: `basalt-ui` 2.7.3 exact; the now-required peers (`@mantine/modals`,
      `@mantine/notifications`, `@mantine/spotlight`, `@mantine/core`/`hooks` ≥ 9.7.0); the exact
      font peers at their published versions; `@tanstack/charts` 1.1.0 and `d3-scale` 4.0.2 exact;
      `shiki` + `@shikijs/langs` + `@shikijs/themes` ^4.5.0 (`doctor` requires them for
      `basalt-ui/content`, i.e. `Callout`/`GuideLink`); oxlint ≥ the preset's floor (the installed
      1.76.0 cannot parse the 2.x preset — argo needed ≥ 1.87); drop every `@visx/*` and the five
      deps `src/` never imports (`motion`, `remend`, `react-markdown`, `remark-gfm`, `zod` — verify
      with grep, `doctor` exact-peers decides). `basalt-ui sync`, then `doctor` until clean:
      `tsconfig` files extend `basalt-ui/configs/tsconfig.react-app.json`, `.oxlintrc.json` and
      `lefthook.yml` / `check.yml` keep the repo-root layout (AGENTS.md § dashboard).
- [x] Wiring: `main.tsx` → `BasaltProvider router theme` (drop the hand-built
      `QueryClientProvider`/`RouterProvider`); `lib/router.ts` → `createBasaltRouter({ routeTree,
      context?, query? })` carrying `defaultPreload: 'intent'` and the 30 s `staleTime` from
      `lib/query-client.ts` (then delete that file); `routes/__root.tsx` →
      `createRootRouteWithContext<BasaltRouterContext>()`; keep the `Register` augmentation. Delete
      the `@mantine/core/styles.layer.css` import (`styles.css` carries it). Telemetry: a dev-console
      stub, made real nowhere (this repo exports no OTel, AGENTS.md § Verify & Monitor).
- [x] Import moves: `VX`/`alpha` → `basalt-ui/tokens` (6 component files + chart files);
      `createSearchStore`/`field` → `basalt-ui/state` (`lib/dashboard-store.ts`);
      `routes/index.tsx` `PageBar` `secondary` → the `actions` tuple (first entry `primary: true`),
      and the `RangeField` index (`TS7053` at `index.tsx:293`).
- [x] Every chart file that does not compile becomes a `MIGRATION-STUB(w4|w5|w6|w7)` stub: l1/l8/l7
      → w4, l3 → w5, l4/l6/l9–l11 → w6, l2/l5 + `category-grid.tsx` → w7. Test files that import a
      removed export (`availability-strip.test.ts`: `VX`) take the specifier move; render tests of
      stubbed charts are skipped with the same `MIGRATION-STUB` marker, not deleted.
- [x] Gate: `make check`, `bun test` (D4), `bun run lint`, `bun run build` green on the merged head;
      `sync --check` clean; `doctor` clean; `grep -rn "MIGRATION-STUB" web/src` lists exactly the
      stubs; nothing else is visibly unfinished (D1).

**Evidence:** `w2.md` — `doctor` output, tsc/lint/test counts, stub list (file → owning wave),
bundle bytes against baseline, screens of the non-chart surfaces.

**Left behind:**
- Pinned `basalt-ui` **2.8.1** exact (2.9.0 not on npm). `make check` green (577 root), `cd web && bun test` 277 pass / 66 skip / 0 fail = 343 (baseline 343), lint 0 errors, `doctor` clean, `sync --check` clean, build green, 0 new waivers (the one live `theme-allow` is `live-chip.tsx`'s, pre-existing). `oxlint` pinned 1.87.0: 1.88.0 is inside bun's 3-day release-age cooldown.
- Stubs: charts → w4 (availability/link-speed strips, throughput), w5 (latency band; plus `routes/index.tsx`'s `renderExtraTooltipRows`/`InternetFoldRows`, removed — 1.41 source at `d63aca7`), w6 (speed, bufferbloat, status-bar's three sparklines), w7 (both heatmaps, `category-grid`). `getBand`/`bandSeries`/`bandFor`/`FILL_SERIES` removed with their tests skipped (w4); `foldBands` cases skipped `MIGRATION-STUB(w4)` per the plan. **Review gap accepted:** while stubbed there is no `getBand` / fold-merge-through-`foldBands` coverage and the stubs show "Migrating" even while a query is pending (the per-chart `pending.render` tests are skipped, w4–w7 un-skip them with the port). The pure helpers (`mergeColumns`, `foldStates`, `summariseLink`, `mergePoints`) stay exported and `mergeColumns`/`summariseLink`/`foldStates` tests live.
- The dashboard's default colour scheme and router/query defaults were verified against 2.8.1 source (`BasaltProvider` defaults `dark`; `createBasaltRouter` carries `defaultPreload: 'intent'`, `defaultPreloadStaleTime: 0`, 30 s `staleTime`, no focus refetch) — no override needed. Telemetry sink deliberately not wired.
- Bundle: JS 2374287 B raw / 525353 gz (baseline 1372859 / 429148), CSS 304293 / 48800. The delta is shiki chunks from `basalt-ui/content`, not charts.
- Wave 3 inherits: new lint warnings (`react(hooks)` on `dashboard-section.tsx`'s dynamic `usePersistedOpen`; `only-export-components` on route files), the `field.range` cast and AGENTS.md paragraphs naming deleted symbols (untouched this wave), `web/AGENTS.md` managed block already refreshed by `sync`, `RangeFilter` type check passes without the old `TS7053`. Screens of non-chart surfaces were NOT captured: the live container serves master's 1.41 build and `make up` of this tree would replace it — Wave 3 owns the screens (plan item), via a build of this branch.
- Four consumer `*.module.css.d.ts` files added (the strict preset forbids index-signature dot access); `shell/*.module.css.d.ts` and `components/{status-bar,table-card-swap}.module.css.d.ts` must be kept in step with their CSS by hand; `bufferbloat-chart.module.css` is unused until w6.

**basalt friction** (for the orchestrator to file as `linewatch W2 …`; basalt-ui not edited):
1. `basalt-ui sync` scaffolds `src/lib/nav.tsx` (`defineNav` + a Home entry) and records it in `.basalt/manifest.json`, with no shell-less/one-page opt-out; the file was deleted here and `sync --check` still passes, but the manifest keeps a hash for a file that does not exist.
2. `exactOptionalPropertyTypes` + `noPropertyAccessFromIndexSignature` in the preset tsconfig bite every Mantine prop passed `x | undefined` (`c`, `td`, `pl`, `style`) — consumer code needs conditional spreads, since Mantine's own prop types do not carry `| undefined`. Doc-worthy in MIGRATING § tsconfig.
3. The `react(refs)` rule in the 2.x oxlint preset errors on the render-time `ref.current = value` latest-value pattern (fixed here with an effect); not in MIGRATING's lint notes.
4. `foldBands` still absent from 2.8.1 `dist` (Wave 1 friction 1 / ledger row 80, unchanged).


## Wave 3 — Non-chart surfaces: shell, stores, controls, content <!-- status: done -->

Depth and verification on a base that already compiles. Surfaces: `BasaltProvider`/router,
`PageBar`, `Section`/`ViewTabs`, the search store and its three fields, `RangeFilter`/`NumberFilter`/
`FilterSet`, `StatCard`/`DeltaBadge`/`WidgetHeader`, `Callout`/`GuideLink`, `EmptyState`.

- [x] Verify what compiled but may differ (MIGRATING §§ 2.0.0–2.7.3, read for each symbol):
      `createSearchStore` field semantics in `basalt-ui/state` — URL lane drops a value equal to the
      definition's default; `?range=nonsense` still falls back instead of throwing; the
      `field.range` explicit `custom: false` overload still needed (or now fixed — then delete the
      cast in `routes/index.tsx` and the AGENTS.md paragraph); `persist: false` on `minDuration`;
      `url: false` on `compact`; `createPersistedState` for section views.
- [x] Shell-less page chrome: `PageBar` still publishes `--basalt-page-bar-h`, still folds past three
      secondary actions into `More` (now the `actions` tuple's max of five), and
      `shell/page-bar.module.css` / `root-layout.module.css` still hold against the 2.x gutter
      tokens (`--vx-space-app-shell-inset{,-mobile}`). Confirm `createBasaltRouter` works without
      `BasaltShell`/`nav` for a one-page app; if it does not, that is a ledger row, not a local shim.
- [x] `StatCard.tone` rails + `VisuallyHidden` sentence, `status-bar.tsx`'s hand-rolled cells
      (`WidgetHeader tier="widget"`, `DeltaBadge`) and the `CONTAINER_KEYS` / `useSizeClass`
      container tiers against the 2.x surface; `status-bar.render.test.tsx` green except its
      sparkline cells (Wave 6).
- [x] Screens of every non-chart region against the baseline, both schemes, both viewports, compact on
      and off; `compact.contract.test.ts` untouched and green (a verdict is never gated).
- [x] Docs that describe non-chart 1.x facts: `web/DESIGN.md` delta, AGENTS.md § basalt-ui bullets
      that name deleted symbols (`createBasaltQueryClient`, `PageBar` bookkeeping, `Zod is gone`
      stays), in the same commit as the code.

**Evidence:** `w3.md` — screens vs baseline for the non-chart regions, store behaviour table (URL,
localStorage, fallback), friction rows filed.

**Left behind:**
- Gates green on the branch: `make check` (577 root), `cd web && bun test` 280 pass / 66 skip / 0 fail, lint 0 errors / 10 warnings, `sync --check`, `doctor`, `check-theme --audit-allows` (1 live pre-existing waiver, 0 new), build. `/review` 0 blocking. Wave 4 inherits a green tree; nothing under `collector/` changed.
- **Two layout defects fixed** (neither is basalt's): the root `Container` had `px={0}` beating the gutter class (no gutter, bar overshot the viewport by 20 px on 1.41, 16 on 2.x — the "overflow" Wave 1 recorded as a baseline oddity), and 2.x `Section`'s anchor clears 12 px, not the sticky bar, so a verdict link landed the heading under it (now `ANCHOR_STYLE` → `--basalt-page-bar-h`). Both are pinned by tests.
- Store behaviour table is in `w3.md`: URL always carries `range` and `minDuration`; a URL visit does not write the mirror, a control write does; `?range=nonsense` falls back; `minDuration` is never persisted; `compact` is local-only. The `field.range` cast / `custom: false` paragraph was stale since 1.27.0 and is removed from AGENTS.md (the AGENTS.md chrome paragraph is rewritten for 2.x: shell-less `PageBar`, `actions` tuple, 16/8 gutter, the `Section` anchor).
- Observed vs 1.41, kept: live chip (primary action) renders at the right end of row 1; `NumberFilter` at its default prints its label `Min duration` where 1.41 printed `Any`; the status-bar grid is two-up at 1280 where 1.41 drew three-up (the code says two-up). Owner may want either reverted; not done.
- Bundle: entry `index-*.js` 824704 B raw / 252209 gz (baseline 760277 / 231954); initial load on `/` is entry + route chunk only (978250 / 300634); the 32 other chunks are lazy and not requested on `/`. Details in `w3.md`.
- The throwaway server and browser context are torn down. Process slip, disclosed: three baseline `s-*` PNGs were overwritten and re-captured from the live 1.41 container (same served asset); values moved, layout did not.
- Wave 4 does not inherit the `status-bar.render` sparkline cells (Wave 6), the 66 `MIGRATION-STUB` skips, or the `react(only-export-components)` warnings on stubbed chart files.

**basalt friction** (to file in basalt-ui `docs/waves/argo-friction.md` as `linewatch W3 …`; basalt-ui not edited):
1. `Section`'s anchor offset is `--vx-space-sticky-header-clearance` (12 px) only. `PageBar` publishes `--basalt-page-bar-h` for the shell-less case and `Section` does not read it, so the documented shell-less single-page shape (PageBar + Section) lands every `#anchor` under its own sticky bar. Consumers need a per-`Section` `style` override; `Section` could read `var(--basalt-page-bar-h, var(--vx-space-sticky-header-clearance))`.
2. No public handle on a `Section`'s persisted fold: `createPersistedState` returns a hook, so opening a section from a hash needs a dynamically chosen hook (`react(hooks)` warning in `dashboard-section.tsx`), and `writePersistedValue` is `@internal`. A controlled `open`/`onOpenChange` on `Section`, or an exported opener, would remove it.
3. `NumberFilter`'s pill prints only a value; at a default that matches no option it prints the `label`, so a "no filter" state cannot be named (`Any` on 1.x). Candidate `emptyLabel`.
4. The shipped oxlint preset's `react(only-export-components)` warns on every TanStack file route (`Route` + component in one file); the preset could exempt `routes/**` or that rule could take `allowExportNames: ['Route']`.
5. MIGRATING row for `PageBar` does not say the primary action moved to the end of row 1 (observed), nor that `Section`'s anchor no longer clears a shell-less bar (friction 1).

## Wave 4 — Charts A: strips and bars (l1, l7, l8) <!-- status: done -->

`availability-strip.tsx` (399 lines, `BandStrip`), `link-speed-strip.tsx` (441, `BandStrip`),
`throughput-chart.tsx` (278, `MirroredBars`) — they share `foldBands`/`fold`, `getBand`, the shared
`bandSeries` helpers and `lib/axis.ts`. 42 of the probe's errors.

- [x] `BandStrip` ports (l1, l8): `states` series without `mark`, `getBand` returning
      `{ state, fill?, marker? }`, `fold` with `minBandPx`, `tooltip.rows` replacing `label`/
      `TooltipRow`, `ariaLabel` required, `state` replacing `isPending`. Per-column alpha and the
      absent encoding follow D2 — if the fixing minor has not shipped, the chart stays
      `MIGRATION-STUB(w4)` and the ledger row names this step.
- [x] `MirroredBars` port (l7): `up`/`down` panes with `max`/`autoMaxFloor`, `getAbsentFraction`,
      `getBarOpacity`, `fold`, `tooltip.rows`. `throughput-chart.test.ts` / `.render.test.tsx`
      keep their assertions about *what is measured*; only the import moves.
- [x] `lib/axis.ts`: `axisTickValues` against the 2.x `xTicks`/`formatX` contract (x is now a `Date`
      or number where it was an ISO-string key — `formatX` takes the `ChartX`, not a string; keep
      the "key on the instant, never a display string" rule and `densifyBuckets` behaviour),
      `tooltip.formatHeader(x, d)` formatting from the instant (`tooltip-header.test.ts`).
- [x] `tooltip.onFollow: inView` on all three (`use-in-viewport.ts` stays; `follower-tooltip.test.ts`
      rewritten against the 2.x config shape, not deleted).
- [x] Compare against baseline: strips at 24 h / 7 d / 30 d, the `fold` on a narrow viewport, one
      absent column per chart.

**Evidence:** `w4.md` — before/after per chart, tooltip text diff, the ledger rows for anything
that stayed a stub.

**Left behind:**
- First step of the wave, done: `basalt-ui` 2.8.1 → **2.9.0** exact. `sync` clean, `doctor` clean, `check-theme --audit-allows` 1 live (pre-existing) / 0 dead, 0 new waivers. The 1.x compat removals touched nothing here except two docblock names (`StatCardTone` → `Tone`). Row 80: `foldBands` is exported, the three fold test files are un-stubbed and run against the real grouping. Row 81: `ABSENT_COLOR` (`VX.accent`) in `charts/band-shared.ts`, pinned by a test in each strip. Rows 84/85: `Section`'s own anchor clears the bar (computed 93 px = 81 + 12); `ANCHOR_STYLE` survives only on compact's plain `<section>`. Hash-open now uses controlled `open`/`onOpenChange` (no `writePersistedValue`, no `usePersistedOpen`, the `react(hooks)` warning is gone) — **review caught that clearing `open` on the first press swallows it** (basalt mirrors the controlled value into its fold), so the hook stays controlled once touched; verified in a browser.
- Strips (`availability-strip`, `link-speed-strip`) on `BandStrip`, throughput on `MirroredBars`, all real; x is `new Date(bucketStart)`; `Column.key` / `ThroughputPoint.key` deleted. `tooltip.label` has no 2.x slot: availability gets an `Anchor` row, the link strip none. `getBand`, `bandFor`, `bandStates`, `columnRows`, `pointRows`, `mergeColumns`, `mergePoints` stay exported for tests.
- Gates: `make check` green (web 341 pass / 17 skip / 0 fail; W3 was 280 / 66), lint 0 errors, `sync --check`, `doctor`, build green. The 17 skips are all w5/w6/w7 stubs (`grep MIGRATION-STUB web/src`). `/review`: 1 blocking (the chevron, fixed), the cheap findings taken (shared `band-shared.ts`, flat headline, memoised summary, stale axis docblocks); 2 of its 7 reviewers failed on shell denial (typescript, qa) — not re-run. Declined: `kpi.ts` unused exports and `routes/index.tsx` complexity (both pre-existing, untouched code).
- **D2 verdict, verified in a browser build (`w4.md`):** the four conditions hold for the strips (accent absent differs in hue from clean/loss in both schemes; whole-band absent is a flat accent band; the absent legend toggle is off; the colour is pinned). Throughput is weaker — see friction 2. Decision for Wave 9 to close: flat fill is accepted for the strips; the owner should look at throughput's grey-on-grey.
- Frame heights are the plot's, not the card's (the legend sits outside): strips 65 → a 44 px band, throughput 180 + 21 → a 180 px plot, both measured. A first guess of 98 drew a 77 px band.
- Tick thinning: basalt thins band labels itself; `axisTickValues` is unused by the three ported charts (`xTicks` takes values, not a width callback). It stays for Waves 5–6 to decide; AGENTS.md's "all six charts pass it" rule is rewritten for what is true now. `follower-tooltip.test.ts` is rewritten against `tooltip.onFollow` for the three ported charts; the other three join when ported. `tooltip-header.test.ts` and `overlay-color.test.ts` still grep the latency stub (Wave 5).
- Process note: the Chrome MCP may only write screenshots under the repo's workspace root; they were saved into the master checkout's gitignored `raw/` and moved. The throwaway server (`/tmp/lw-serve`) is torn down. `window` cannot be sized below 500 px; 390 was captured with `emulate`.
- Wave 5 inherits: a `Date` x on the bucketed charts (`bucketTickFormat` takes a `Date`), `foldedFromRows` / `ABSENT_*` in `band-shared.ts`, the legend-while-pending gate (friction 1), and the stubbed `renderExtraTooltipRows` / `InternetFoldRows` in `routes/index.tsx`.

**basalt friction** (for the orchestrator to file as `linewatch W4 …`; basalt-ui not edited):
1. `state={{ pending: true }}` still renders the legend (`MirroredBars`, `BandStrip`): a legend over a plot with no marks names an encoding for nothing. 1.41 suppressed it; consumers must pass `legend: false` while pending.
2. `MirroredBars` has no `absentState`: the absent share is a fixed `VX.neutral` over both panes, a grey like the Upload series (`VX.line2`), so row 81's "differs from every measured state" cannot be met by the consumer there; only the full-height shape separates them.
3. Legend swatches ignore `fillOpacity`: "No loss" (`VX.neutral` at 0.14) draws as solid charcoal in the legend against a pale band in the plot, so the legend does not mirror the real alphas 1.x's did.
4. `BandStrip`/`MirroredBars` frame `height` is the plot plus a measured ~21 px axis gutter with the legend outside it; the band height is only reachable by subtracting a magic number. A `bandHeight` / `plotHeight` prop would make the 44 px strip a declaration.
5. Row 86 covers `NumberFilter`'s stepper form only; the preset (`options`) form's pill still prints the filter label at an unmatched value, so a "no filter" state needs a literal `Any` row.
6. `tooltip.label` (a badge naming what a chart is a strip OF) has no 2.x slot; `tooltip.follow: false` for the latency band is still unanswered (Wave 5's question).

## Wave 5 — Charts B: the latency band (l3, ×5) <!-- status: active -->

`latency-band-chart.tsx` alone (876 lines, 31 errors; the only bespoke composition in the repo and
the only direct `@visx/shape` import). Rendered five times in `routes/index.tsx`.

- [ ] Re-express as `CartesianChart` with consumer `marks` (`@tanstack/charts/*` subpaths per
      `basalt/chart-engine-boundary`): `areaY` p5–p95 (`y1`/`y2`), `lineY` ×3 (median + two
      references), loss `dot`s, down-band and absent `rect`s, legend-only entries. The visx `Area`
      import and `LinePath`/`Group`/`curveMonotoneX` go (`chartCurve('monotone')` / `d3Curve`).
- [ ] The overlay logic that read `PlotContext` (`data`, `xScale`, `yScale`, `xMax`, `yMax` — all
      absent in the 2.x `PlotContext`) moves to `plot.rows(key)` / `plot.visible`; `overlay-color.test.ts`
      and `latency-domain.test.ts` keep their assertions, rewritten where they touched the old
      shape.
- [ ] Tooltip: header + rows as data; the source-only anchor (`tooltip.follow: false` — there is no
      `follow` key in 2.7.3) is a D2/ledger item if the five instances sharing one column cannot be
      expressed any other way; `cursorResolution="leading"` and the shared cursor
      (`chartCursor()` / `cursorGroup`, replacing the implicit page-wide scope) verified across all
      six interactive charts as far as they exist at this point.
- [ ] Compare against baseline: all five instances, both schemes, the p5–p95 envelope against the
      baseline pixel of the same window, loss dots, the hover tooltip at the left edge, centre, right
      edge.

**Evidence:** `w5.md` — before/after of the five instances, tooltip rows, ledger rows.

## Wave 6 — Charts C: lines and sparklines (l4, l6, l9–l11) <!-- status: pending -->

`speed-chart.tsx` (214, `Lines`), `bufferbloat-chart.tsx` (129, `Lines`), and the three sparkline
cells in `status-bar.tsx` (`Sparkline`, `mark: 'line' | 'bar'`). 20 of the probe's errors.

- [ ] `speed-chart`: two lines, dynamic dashed reference lines with the reference legend
      (`deriveLegend`/`ChartLegend` are internal now — `legend.placement: 'header'` or a
      `refLines` label; if neither carries the reference labels, ledger row), `SeriesStyle` folded
      into `ChartSeries`, compact height via `height`, `TS7006` untyped `p` callbacks gone with
      the typed `x`/`getValue`.
- [ ] `bufferbloat-chart`: three lines (two dashed), `height: { base: 190, wide: 260 }`, the
      `bufferbloat-chart.module.css` floor; `pending.render.test.tsx` rewritten around `state`.
- [ ] `status-bar.tsx`: `LineSparkline`/`BarSparkline` → `Sparkline`; `useChartSize` is deleted (the
      host measures), loss bar sparkline keeps pooled max and null gaps; sparkline `state` for
      pending/empty (added in 2.2.0); `status-bar.render.test.tsx` fully green. The bar stays the
      one standing deviation from `StatCard` (AGENTS.md).
- [ ] Compare against baseline: speed chart reference lines at 7 d / 30 d, bufferbloat at both
      heights, status-bar cells at six-cell density and mobile.

**Evidence:** `w6.md` — before/after per chart, status-bar render test output.

## Wave 7 — Charts D: heatmaps, the bespoke grid goes (l2, l5) <!-- status: pending -->

`availability-heatmap.tsx` (216), `speed-heatmap.tsx` (253), `category-grid.tsx` (313; the bespoke
grid that only exists because the 1.x `Heatmap` kind had no consumers). 18 errors plus the grid's
bespoke tooltip (`ChartTooltipFloat`/`TooltipBody` deleted).

- [ ] Both heatmaps on `Heatmap`: absolute intensity, gradient legend, per-cell `rows`, no cursor
      (heatmaps join none), the 30-day clamp, three states (measured / failed / absent). `null`
      is "a flat neutral cell, never a zero" in 2.x — that matches the repo's rule; verify the
      *failed* state is still distinguishable from *absent* (D2).
- [ ] Delete `category-grid.tsx`, its tooltip and hit-testing; the `ChartFrame`/`Group`/
      `HatchPattern` imports leave with it. `availability-heatmap.render.test.tsx` rewritten.
- [ ] `Heatmap` x-label striding (2.2.0 `Heatmap` strides to the container class's tick count)
      against the 30-day layout at 390 px.
- [ ] Compare against baseline: cell counts, intensity ramp endpoints, the absent/failed cells,
      tooltip content per state.

**Evidence:** `w7.md` — before/after, state matrix, deleted-file list.

## Wave 8 — No stub left; the guard layer and the docs <!-- status: pending -->

- [ ] `grep -rn MIGRATION-STUB web/src` empty; `grep -n "@visx" web/bun.lock web/package.json` empty;
      no `theme-allow`/`oxlint-disable` naming a deleted rule id (a deleted id waives nothing).
- [ ] Rewrite AGENTS.md § "The dashboard runs on basalt-ui" for 2.x: drop `basalt/hand-rolled-plot`,
      `ChartTooltipFloat` and `charts/follower-tooltip.test.ts` as written, `withBorder`/card idiom
      stays, `onFollow: inView`, the one-cursor rule, the `axisTickValues` rule — each only if it is
      still true; add what Waves 4–7 learned. Update `docs/dashboard-charts.md`, `web/DESIGN.md`
      (series dictionary), `web/AGENTS.md` managed block via `basalt-ui sync`.
- [ ] `basalt-ui check-theme --audit-allows` exits 0; `basalt-ui sync --check`, `doctor`,
      `make check`, `bun test` and the build green on the merged head; bundle bytes recorded against
      baseline (the 2.x charts runtime is a new chunk — note, don't fix).
- [ ] Confirm every ledger row filed in Waves 1–7 has either an upstream fix landed or a named
      stub/decision recorded; list the open ones for the cutover review.

**Evidence:** `w8.md` — grep outputs, `doctor`/`check-theme` output, bundle table.

## Wave 9 — Visual check against the baseline, BEFORE deploy <!-- status: pending -->

Nothing ships. Run from `make up` on the working tree (the local equivalent; AGENTS.md § Deploy) so
the check sees the container build, not only vite.

- [ ] `make up` on the merged head; `make verify` green. Repeat Wave 1's matrix with `@verifier`:
      light/dark × both viewports × compact × all ranges × every section view.
- [ ] Repeat the tooltip captures (all 11 rows, three cell states, keyboard cursor) and diff text
      against `baseline-1.41.md`.
- [ ] Console and network check: no error/warn on load or on any interaction, no failed request,
      `POST /api/speedtests/run` never fired.
- [ ] Verdict: per region "same / improved / regressed (why)". Any regression is a fix or a ledger
      row before Wave 10; D2's flat-fill decision is closed here.

**Evidence:** `w9.md` — side-by-side index of every capture.

## Wave 10 — Deploy and prove it live <!-- status: pending -->

- [ ] Land on `master` (direct-to-master, per AGENTS.md); rollhook CD ships it. If D1(c) paused CD,
      resume it now. `make deploy` only reports how it ships — it is not the deploy.
- [ ] On the mini: `make verify` green, `make logs` shows no new errors, the `config_change` event
      for the container start is in the record (`make db-counts` / the event timeline), and the
      served build is the merged head.
- [ ] Both Uptime Kuma push monitors (`Home Line - Push`, `Home Line - Watchdog`) green through the
      deploy; `make heartbeat-status` prints a healthy verdict; the native collector, heartbeat and
      watchdog were never touched (nothing under `collector/` changed — assert with `git diff`).
- [ ] `@verifier` loads the live origin: spot-check one screen per region against Wave 9's
      captures; recorded.
- [ ] If anything fails: the next PR, not a rollback narrative.

**Evidence:** `w10.md` — the commands and outputs above, the served commit.

## Wave 11 — Fresh-agent DX trial <!-- status: pending -->

A fresh agent with only the repo, its AGENTS.md and the shipped `basalt-*` skills/rules (no plan,
no memory of this migration) adds one new thing on basalt surfaces linewatch uses — **on the
existing page, since AGENTS.md forbids a second route**: a new `Section` with a `StatCard` row, a
`Lines` chart (hourly loss, a `Heatmap`-free shape), a `Callout` verdict and a `RangeFilter`-scoped
query. The branch is throwaway unless the lead keeps it.

- [ ] Brief the trial agent with the user-visible ask only; capture its transcript path.
- [ ] Every basalt-rooted wrong turn (wrong import path, a rule/skill that misled, a type that lied,
      a `doctor` miss) becomes a row in `argo-friction.md` as `linewatch W11 …`; not-basalt wrong
      turns (this repo's AGENTS.md) become edits to AGENTS.md instead.
- [ ] Re-run `make check`, `bun run lint`, `basalt-ui doctor` on the trial branch; record whether
      the guards caught what the agent got wrong, or the agent caught it by reading.
- [ ] Verdict in `w11.md`: could a fresh agent do it unaided in one context, and which rule/skill
      change would have saved the most steps.

**Evidence:** `w11.md`.

---

# Appendix A — Inventory (every `basalt-ui` reference, excluding `node_modules`, `.claude/worktrees`, `dist`)

Measured at `6a72239` (basalt-ui 1.41.0). Method: a regex over `web/src` + `vite.config.ts` +
`index.html` for `import … from 'basalt-ui…'`, then `git grep` for non-import references.

## Package, config and CLI surfaces

| Surface | Where | 1.41 use | 2.x fate |
|-|-|-|-|
| dependency pin | `web/package.json` `"basalt-ui": "1.41.0"` | exact | `2.7.3` exact |
| `basalt` config block | `web/package.json` `{ "roots": ["src"] }` | `check-theme` roots | `config-keys` check passes on 2.7.3 |
| CSS | `src/main.tsx`: `@mantine/core/styles.layer.css`, `basalt-ui/styles.css` | both imported | delete the Mantine layer import (`styles.css` imports it, MIGRATING § 2.0 "Provider and wiring"); no `@mantine/dates`/`schedule` use |
| vite | `web/vite.config.ts`: `basaltAppPlugin`, `basaltViteConfig` from `basalt-ui/vite` | `port`, `allowedHosts`, `apiTarget`, `version` | `./vite` subpath kept in 2.7.3 exports; no tsc error; verify args in Wave 2 |
| oxlint preset | `web/.oxlintrc.json` extends `./node_modules/basalt-ui/configs/oxlint.json` | oxlint 1.76.0 | 2.7.3 preset needs newer oxlint: probe "Failed to parse oxlint configuration file" (`react` plugin rules `refs`, `globals`, `immutability`, `incompatible-library`, `preserve-manual-memoization`, `set-state-in-effect` not found) |
| tsconfig | `web/tsconfig*.json` | does not extend the preset | `doctor` `tsconfig-base` fails: extend `basalt-ui/configs/tsconfig.react-app.json` |
| lefthook | repo-root `lefthook.yml` (3 jobs in `web/`: oxlint, `check-theme`, `sync --check`) | local bin | `doctor` accepts (check-theme job found); preset gained a pre-commit hook in 2.4.0 — re-read § 2.4.0 |
| CI | `.github/workflows/check.yml` (basalt-managed, moved from `web/.github`) | `sync --check`, lint, build | managed file; `sync` rewrites it; repo-root placement is a repo-specific deviation |
| managed layer | `web/.basalt/manifest.json`, `web/AGENTS.md` managed block, `web/.claude/rules/basalt-{batteries,charts,controls,mantine,state,tokens}.md`, `web/.claude/skills/basalt-{app,charts,design}`, `web/DESIGN.md` | written by 1.41.0 | `doctor` `install-parity` fails until `basalt-ui sync` |
| CLI | `basalt-ui check-theme` (lint script), `sync --check` (hook, CI), `doctor` | local bin | unchanged commands; `check-theme` reports 0 findings on 2.7.3 (probe) |
| `index.html` | no basalt import | theme colour comes from `basaltAppPlugin` | unchanged |
| `src/**/*.css` | `bufferbloat-chart.module.css`, `status-bar.module.css`, `table-card-swap.module.css`, `page-bar.module.css`, `root-layout.module.css` | no `basalt-ui/...` imports, tokens by `var(--vx-*)` | `--vx-space-app-shell-inset{,-mobile}` kept? verify in Wave 3 |
| no `basalt-ui/css`, `basalt-ui/agent*`, `basalt-ui/data*`, `basalt-ui/forms`, `basalt-ui/table`, `basalt-ui/commands` imports | | | nothing to migrate on those subpaths |

## Import statements (48, 30 files)

| File | Subpath | Symbols |
|-|-|-|
| `src/main.tsx` | `basalt-ui/styles.css` · `basalt-ui` | CSS · `BasaltProvider`, `createBasaltTheme` |
| `src/lib/query-client.ts` | `basalt-ui` | `createBasaltQueryClient` |
| `src/lib/dashboard-store.ts` | `basalt-ui/router-tanstack` · `basalt-ui/state` | `createSearchStore`, `field` · `createLocalStore` |
| `src/routes/index.tsx` | `basalt-ui` · `/charts` · `/content` · `/controls` | `PageBar`, `ThemeToggle` · `TooltipRow`, `VX` · `Callout` · `FilterSet`, `NumberFilter`, `RangeFilter` |
| `src/components/dashboard-section.tsx` | `basalt-ui` · `/controls` · `/state` | `Section` · `ViewTabs` · `createPersistedState`, types `EnumField`, `FieldHandle` |
| `src/components/status-bar.tsx` | `basalt-ui` · `/tokens` · `/charts` | `DeltaBadge`, `WidgetHeader` · `CONTAINER_KEYS` · `BarSparkline`, `LineSparkline`, `VX`, `useChartSize` |
| `src/components/link-comparison.tsx` | `basalt-ui` · `/content` · `/tokens` | `StatCard` · `Callout` · `CONTAINER_KEYS` |
| `src/components/vantage-card.tsx` | same three | `StatCard` · `Callout` · `CONTAINER_KEYS` |
| `src/components/live-chip.tsx` | `basalt-ui` · `/charts` | `useSizeClass` · `VX` |
| `src/components/outage-table.tsx` | `basalt-ui` | `EmptyState` |
| `src/components/transition-timeline.tsx` | `basalt-ui` | `EmptyState` |
| `src/components/verdict-panel.tsx` | `basalt-ui/charts` · `/content` | `VX` · `Callout`, type `CalloutKind` |
| `src/components/coverage-callout.tsx` | `basalt-ui/content` · `/charts` | `Callout` · `VX` |
| `src/components/guided-chart.tsx` | `basalt-ui/charts` · `/content` | `ChartCard` · `GuideLink` |
| `src/components/server-change-note.tsx` | `basalt-ui/charts` | `VX` |
| `src/components/stat-strip.tsx` | `basalt-ui/charts` | `VX` |
| `src/charts/latency-band-chart.tsx` | `basalt-ui/charts` (+ direct `@visx/shape`) | `CartesianChart`, `ChartSeries`, `Group`, `HatchPattern`, `LinePath`, `PlotContext`, `TooltipRow`, `VX`, `alpha`, `curveMonotoneX`, `fmtTooltipDate`, `hatchFill` · `Area` |
| `src/charts/availability-strip.tsx` | `basalt-ui/charts` | `BandFold`, `BandSpan`, `BandStrip`, `BandStripSeries`, `ChartMargin`, `TooltipRow`, `VX`, `alpha` |
| `src/charts/link-speed-strip.tsx` | `basalt-ui/charts` | same eight |
| `src/charts/throughput-chart.tsx` | `basalt-ui/charts` | `BandFold`, `ChartMargin`, `ChartSeries`, `MirroredBars`, `MirroredBarPane`, `TooltipRow`, `VX` |
| `src/charts/speed-chart.tsx` | `basalt-ui/charts` | `ChartCard`, `ChartLegend`, `MultiLine`, `SeriesStyle`, `VX`, `deriveLegend` |
| `src/charts/bufferbloat-chart.tsx` | `basalt-ui/charts` | `ChartCard`, `MultiLine`, `VX` |
| `src/charts/availability-heatmap.tsx` | `basalt-ui/charts` | `ChartCard`, `ChartFrame`, `TooltipRow`, `VX` |
| `src/charts/speed-heatmap.tsx` | `basalt-ui/charts` | same four |
| `src/charts/category-grid.tsx` | `basalt-ui/charts` | `ChartTooltipFloat`, `Group`, `HatchPattern`, `TooltipBody`, `TooltipHeader`, `VX`, `alpha`, `hatchFill` |
| `src/charts/availability-strip.test.ts` | `basalt-ui/charts` | `VX`, `foldBands` |
| `src/charts/link-speed-strip.test.ts`, `throughput-chart.test.ts` | `basalt-ui/charts` | `foldBands` |
| `src/charts/latency-domain.test.ts` | `basalt-ui/charts` | type `ChartSeries` |
| `vite.config.ts` | `basalt-ui/vite` | `basaltAppPlugin`, `basaltViteConfig` |

Also: `@visx/{axis,curve,event,grid,group,responsive,scale,shape,threshold}` 4.0.0 are in
`web/package.json` (9 pins; only `@visx/shape` is imported, in `latency-band-chart.tsx:3`).
`motion`, `remend`, `react-markdown`, `remark-gfm`, `zod` are listed and never imported from `src/`.
`@mantine/modals`, `@mantine/notifications`, `@mantine/spotlight` are not listed (now required peers).

# Appendix B — Symbol → 2.7.3 fate

Sources: installed `MIGRATING.md` § 2.0.0 (charts, state, wiring, tokens tables) and §§ 2.0.1–2.7.3,
`v2-chart-inventory.md`, and the installed `dist/charts/*.d.ts` where MIGRATING is silent. "tsc"
= produced a probe error.

| Symbol (1.41) | Fate in 2.7.3 | Evidence |
|-|-|-|
| `BasaltProvider` (`theme`, `defaultColorScheme`, children) | props become `router` (required), `telemetry?`, `fallback?`, `theme?` — **no children** | tsc `main.tsx:17` |
| `createBasaltTheme` | kept; `inputs: 'desktop'` etc. removed (unused here) | no error |
| `createBasaltQueryClient` | deleted → `createBasaltRouter({ routeTree, context?, query? })` | tsc `query-client.ts` |
| `createSearchStore`, `field` (`basalt-ui/router-tanstack`) | move to `basalt-ui/state` (same names) | tsc TS2307 `dashboard-store.ts:1` |
| `createLocalStore`, `createPersistedState`, `EnumField`, `FieldHandle` (`basalt-ui/state`) | kept | no error |
| `PageBar` (`actions` object with `secondary`) | `actions` is a tuple, first `primary: true`, ≤5 | tsc `index.tsx:331` |
| `ThemeToggle`, `Section`, `StatCard`, `DeltaBadge`, `WidgetHeader`, `EmptyState`, `useSizeClass` | kept in `basalt-ui` | no error |
| `CONTAINER_KEYS` (`basalt-ui/tokens`) | kept | no error |
| `Callout`, `CalloutKind`, `GuideLink` (`basalt-ui/content`) | kept; `basalt-ui/content` now needs `shiki`/`@shikijs/*` peers (`doctor`) | doctor `subpath-peers` |
| `ViewTabs`, `FilterSet`, `NumberFilter`, `RangeFilter` (`basalt-ui/controls`) | kept (`ViewTabs` deleted from `./content`, still in `./controls`) | no error |
| `basaltAppPlugin`, `basaltViteConfig` (`basalt-ui/vite`) | kept | no error |
| `VX`, `alpha` (`basalt-ui/charts`) | **move** to `basalt-ui/tokens` | tsc ×20 (VX ×16, alpha ×4) |
| `ChartCard`, `CartesianChart`, `ChartSeries`, `PlotContext`, `BandStrip`, `BandFold`, `BandSpan`, `BandStripSeries`, `MirroredBars`, `MirroredBarPane` | kept names, **new contracts** (V2-SPEC § 9) | tsc ×60+ on usage |
| `foldBands` | kept | no error |
| `MultiLine` | → `Lines` | tsc |
| `LineSparkline`, `BarSparkline` | → `Sparkline` (`mark: 'line' \| 'bar'`) | tsc |
| `LinePath`, `curveMonotoneX`, `Group` | deleted → `lineY` in `marks` / `ChartSeries.curve` / `chartCurve('monotone')`; "marks carry their own position" | tsc |
| `ChartFrame` | deleted (host private) → `CartesianChart` `marks`, matrix → `Heatmap` | tsc |
| `TooltipRow`, `TooltipHeader`, `TooltipBody`, `ChartTooltipFloat` | deleted → `tooltip.rows(d, ctx)` data + `tooltip.formatHeader(x, d)` | tsc |
| `ChartLegend`, `deriveLegend`, `SeriesStyle` | internal / folded into `ChartSeries`; external legend = `legend.placement: 'header'` | tsc |
| `useChartSize`, `ChartMargin` | deleted ("the host measures", "margins are measured; band kinds own their top inset") | tsc |
| `fmtTooltipDate` | deleted; `formatX`/`tooltip.formatHeader` default to date formats | tsc |
| `HatchPattern`, `hatchFill` | **deleted, no replacement** ("absent-state paint is a flat fill") | tsc |
| `@visx/shape` `Area` (direct) | gone with visx | package removal |
| `tooltip.onFollow` | kept (`boolean`) | no error on it |
| `xTickValues`, `cursorResolution`, `formatX`, `tooltip.formatHeader` | not flagged by the probe, but they sit on charts whose props already fail — **re-verify** each against the final types | — |

**Unmapped (candidate friction rows — nothing in MIGRATING or the 2.7.3 types answers them):**

1. `BandSpan.absentFraction` — per-column "share of this bucket not measured" (`availability-strip.tsx:161-170`, `link-speed-strip.tsx:198-210`; tsc ×8). 2.x `BandSpan` is `{ state, fill?, marker? }`; only `MirroredBars` has `getAbsentFraction`.
2. `BandStripSeries.mark` (`availability-strip.tsx:203-227`, `link-speed-strip.tsx:226-253`; tsc ×8) — no equivalent; the per-state fill/alpha mapping is unspecified.
3. `hatchFill` / `HatchPattern` (`latency-band-chart.tsx`, `category-grid.tsx`) — deleted by design, but the repo's honesty rule (absent ≠ zero ≠ good) depended on it; "flat fill" collides with state colours.
4. `tooltip.follow: false` (`latency-band-chart.tsx` — "anchor as a source", needed because five instances share a column) — only `onFollow` exists (tsc TS2561).
5. `tooltip.label` on `BandStrip` / `MirroredBars` (tsc ×2) — replaced by `rows`/`formatHeader`, no one-line equivalent for the column header.
6. `PlotContext` overlay access (`data`, `xScale`, `yScale`, `xMax`, `yMax`; tsc ×5) — the hatch/down-band `rect`s in the latency band need pixel scales; the 2.x context is row-based (`plot.rows`, `plot.visible`). Whether scale access exists for `rect` marks is unverified.
7. A reference-line legend on `Lines` (`speed-chart.tsx`'s `deriveLegend(refSeries)` workaround for `refLines` having no `label`) — 2.x answer unverified.
8. `BasaltProvider`/`createBasaltRouter` without `BasaltShell` and `nav` for a shell-less single-page app — MIGRATING describes the shell path; no row for a page-bar-only app.
9. `field.range` explicit `custom: false` re-inference and `RangeFilterProps.field`'s pinned `boolean` (the cast in `routes/index.tsx`) — whether 2.x fixed it is unverified (the cast is in tsc'd code but the module-not-found error masked the field types).
10. `createBasaltQueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } })` — `query` option merges over 1.x defaults per MIGRATING; the 30 s override is expected to carry over, unverified.
11. `Heatmap` three-state cells (measured / failed / absent) — null = "flat neutral"; whether *failed* has its own paint is unverified (`availability-heatmap`, `speed-heatmap`).
12. `ChartCursorScope`-less shared cursor (`routes/index.tsx:389` docblock) — `chartCursor()` / `cursorGroup` is the 2.x spelling; per-chart wiring unverified.

# Appendix C — tsc fallout probe (throwaway branch, never pushed)

Method: `git switch -c tmp/basalt-2.7.3-probe`; `web/package.json` `basalt-ui` 1.41.0 → 2.7.3 (nothing
else touched, so peers and `@visx/*` stayed); `bun install`; `bun run typecheck`
(`tsr generate && tsc -p tsconfig.app.json && tsc -p tsconfig.node.json`); `bunx basalt-ui doctor`;
oxlint and `check-theme`. Branch deleted, tree restored (`git branch --list 'tmp/*'` empty).

**`tsc -p tsconfig.app.json`: 123 errors in 19 files.** `tsconfig.node.json` (vite config): 0.
Tests are excluded from `tsconfig.app.json` (D4), so they are not in this number.

| File | Errors |
|-|-|
| `src/charts/latency-band-chart.tsx` | 31 |
| `src/charts/link-speed-strip.tsx` | 18 |
| `src/charts/availability-strip.tsx` | 18 |
| `src/charts/speed-chart.tsx` | 9 |
| `src/charts/category-grid.tsx` | 8 |
| `src/charts/bufferbloat-chart.tsx` | 7 |
| `src/charts/throughput-chart.tsx` | 6 |
| `src/charts/speed-heatmap.tsx` | 5 |
| `src/charts/availability-heatmap.tsx` | 5 |
| `src/routes/index.tsx` | 4 |
| `src/components/status-bar.tsx` | 4 |
| `src/main.tsx`, `lib/query-client.ts`, `lib/dashboard-store.ts` | 1 each |
| `components/{verdict-panel,stat-strip,server-change-note,live-chip,coverage-callout}.tsx` | 1 each |

Chart files: 107 errors (87%). Non-chart: 16, of which 5 are the mechanical `VX` move, 4 are
`status-bar` sparkline names, 7 wiring.

| Code | Count | Typical cause |
|-|-|-|
| TS2305 (no exported member) | 50 | `VX` ×16, `TooltipRow` ×7, `alpha` ×4, `Group`, `HatchPattern`, `hatchFill` ×2 each, `ChartFrame`, `ChartMargin`, `MultiLine`, … |
| TS7006 / TS7031 (implicit any) | 24 / 4 | callbacks on untyped chart props once the generic collapses to `unknown` |
| TS2353 (unknown object-literal key) | 20 | `absentFraction` ×8, `mark` ×8, `label` ×2 |
| TS2322 (not assignable) | 10 | `ChartSeries<Point>[]` vs `<unknown>[]`, `(key: string) => string` vs `(x: ChartX) => string`, `BandFold<Column>` |
| TS2339 | 5 | `PlotContext` has no `data`/`xScale`/`yScale`/`xMax`/`yMax` |
| TS2724 / TS18046 | 3 / 3 | `BarSparkline`, `LineSparkline`, `ChartTooltipFloat` renamed; `'c' is of type 'unknown'` |
| TS7053, TS2561, TS2345, TS2307 | 1 each | `RangeField` index, `tooltip.follow`, `readonly unknown[]`, `basalt-ui/router-tanstack` |

Representative messages:

- `src/charts/latency-band-chart.tsx(514,26): TS2339: Property 'data' does not exist on type 'PlotContext<Point>'.`
- `src/charts/availability-strip.tsx(161,50): TS2353: … 'absentFraction' does not exist in type 'BandSpan'.`
- `src/charts/throughput-chart.tsx(212,9): TS2322: Type '(key: string) => string' is not assignable to type '(x: ChartX) => string'.`
- `src/lib/dashboard-store.ts(1,42): TS2307: Cannot find module 'basalt-ui/router-tanstack' …`
- `src/routes/index.tsx(331,11): TS2353: … 'secondary' does not exist in type 'PageBarActions'.`

**`bunx basalt-ui doctor` (in `web/`): 6 hard failures, 0 warnings.**

```
✖ install-parity: basalt-ui resolves at node_modules/basalt-ui (2.7.3), but .basalt/manifest.json was last written by 1.41.0 … Run `basalt-ui sync`
✖ tsconfig-base: tsconfig.json … does not extend the shipped preset … set "extends": "basalt-ui/configs/tsconfig.react-app.json"
✖ dropped-subpaths: src/lib/dashboard-store.ts:1 imports basalt-ui/router-tanstack.
✖ app-wiring: src/main.tsx does not use createBasaltRouter.
✖ exact-peers: motion@13.4.0 (basalt-ui pins 14.1.0); remend@1.3.1 (basalt-ui pins 1.4.0)
✖ subpath-peers: shiki, @shikijs/langs, @shikijs/themes for basalt-ui/content (verdict-panel.tsx); @tanstack/charts for basalt-ui/charts
✓ guard-scan, oxlint preset, lefthook check-theme job, ai-major-parity, retired-lint-rules, config-keys
```

Other probe readings: `bunx oxlint .` → "Failed to parse oxlint configuration file" (the 2.7.3
preset names `react` plugin rules oxlint 1.76.0 lacks); `basalt-ui check-theme` → "no off-palette
colors"; `bun test` not run on the probe (D4; the tests that import `VX` fail at link time).
Required peers per the 2.7.3 `package.json`: the three `@fontsource-variable/*` (5.3.0 exact),
`@mantine/{core,hooks,modals,notifications,spotlight}` (^9.7.0), `@tanstack/{react-query,react-router}`,
`react`, `react-dom`; optional subpath peers include `@tanstack/charts` 1.1.0 and `d3-scale` 4.0.2
(`./charts`), `shiki` + `@shikijs/*` (`./content`).

**Blast radius:** 48 `basalt-ui` import statements in 30 files (plus `package.json`, `.oxlintrc.json`,
`lefthook.yml`, `check.yml`, three tsconfigs), ~5.2 kLOC in the chart, status-bar and route files that
change; **123 `tsc` errors in 19 files** (107 in 9 chart files); **11 chart call sites** (9 chart
source files incl. `category-grid`, 4 waves), 6 hard `doctor` failures, oxlint unable to run until bumped;
deploy target the single-user tailnet dashboard on the Mac mini (rollhook CD on every master push;
alerting path independent); rating: **medium**.

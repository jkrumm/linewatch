# web/src/routes — Agent Instructions

Read this before changing the page, its controls, its store (`web/src/lib/dashboard-store.ts`)
or its chrome. The lint gate and the basalt-ui guards are in [`web/AGENTS.md`](../../AGENTS.md);
the charts the page hosts are in [`web/src/charts/AGENTS.md`](../charts/AGENTS.md).

- **The dashboard is one page, one range control, and no navigation chrome.** Do
  not add a route, a sidebar or a second range selector; the five-route version
  re-scoped the data silently as the reader navigated, which is why it is gone
  (`web/src/routes/index.tsx`'s docblock has the full history). Every figure is
  taken over the selected window — including the Speed percentiles, which are
  computed client-side (`lib/speed-stats.ts`) precisely because
  `GET /api/speedtests/summary` only takes whole days. The one block the range
  does not scope is the 30-day heatmap, and it says so on itself. A section's
  _evidence_ may sit behind a named view switch; a **conclusion never may** — every
  verdict renders in the band above the sections, unconditionally.
- **Compact mode is the one control that can hide part of the page, and what it
  may hide is declared, not decided per block.** It is a `{ url: false }` field on
  `lib/dashboard-store.ts`'s one store, and that field's docblock holds the split and
  the reasoning; `lib/compact.contract.test.ts` pins the half that matters by
  grepping `verdict-panel.tsx` for a gate its critical/warn lists must never
  acquire. It is a source test on purpose — the mirror is `createPersistedState`,
  which is SSR-safe, so compact always resolves to `false` under
  `renderToStaticMarkup` and a render test could only ever observe the non-compact
  branch. Two consequences worth holding: basalt's `Section` draws its title and its
  `tabs` in one header row whose height is the switch's, so they go together or not
  at all — which is why compact drops `Section` itself rather than passing it fewer
  props; and because compact drops the Path & hardware section outright,
  `EvidenceLink` **leaves compact** rather than merely scrolling, and
  `DashboardSection` re-scrolls on mount while the hash still names it. A verdict
  that points somewhere has to land somewhere.
- **Every control on the page reads one store, `lib/dashboard-store.ts`, and Zod
  is gone from the route.** `createSearchStore` (`basalt-ui/state`) takes typed
  fields, so the range, the outage-duration bound and the density toggle each
  declare their own lanes once — `range` on the URL with a localStorage mirror
  under it, `minDuration` URL-only (`persist: false` — a filter you narrowed once
  should not narrow every later visit), `compact` local-only (`url: false`). The
  URL is still the truth for the first two: a link to a reading carries `?range=`
  (and `minDuration=0` — `validateSearch` always resolves both, so the URL states
  its defaults), and `?range=nonsense&minDuration=abc` falls back to `24h`/`0`
  instead of throwing out of `validateSearch`. Measured on the 2.8.1 build: a
  control write puts `range` in the localStorage mirror (`basalt:dashboard`), a URL
  visit does not, and a bare `/` then opens on the mirrored range with
  `minDuration` back at 0. **The store's own navigate already passes
  `resetScroll: false`**, so never hand-roll one beside a field write.
  `field.range` is written inline with no `custom` flag and `<RangeFilter
  field={…} />` takes the handle uncast — both since basalt-ui 1.27.0.
- **The page's chrome is basalt's `PageBar`, and the sticky height is its own.**
  Shell-less (`BasaltProvider` + `createBasaltRouter`, no `BasaltShell`, no nav —
  basalt documents a shell-less single page as closed by `PageBar`), so both rows
  render in flow with `title` leading and the whole bar publishes its measured
  height as `--basalt-page-bar-h` in the LAYOUT phase. **`Section` does not use
  it**: since 2.0 its anchor clears only `--vx-space-sticky-header-clearance`
  (12px — the shell's header sits outside the shell's own scrollport), so
  `DashboardSection` passes `style={{ scrollMarginTop: 'var(--basalt-page-bar-h)' }}`
  and a section anchor would otherwise land its heading under the bar. Do not
  reintroduce a measured header height or a `--lw-header-h`. The full bleed across
  `__root.tsx`'s Container gutters and the hairline under the bar arrive through
  `PageBar.className` (`shell/page-bar.module.css`). **The gutter is basalt's,
  stated once**: `--vx-space-app-shell-inset{,-mobile}` (16/8 on 2.x; they were
  20/8) set the Container's `padding-inline` in `shell/root-layout.module.css`,
  and `.bleed` cancels the same var at the same 52.5em step. **The Container
  takes no `px` prop** — an inline `px={0}` beats the class, which is how the page
  had no gutter at all and the bleed overshot the viewport by the inset (20 px on
  1.41, 16 on 2.x) until Wave 3. `scrollWidth === innerWidth` at both viewports is
  the check. `actions` is the 2.x tuple, first entry `primary: true` (the live
  chip), at most five; the bar folds by its measured width, so the version string
  stays on `filtersEnd`.

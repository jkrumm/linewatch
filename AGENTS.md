# linewatch — Agent Instructions

Uptime + throughput history for the home internet line. Mac mini only. Read
[`docs/DESIGN.md`](docs/DESIGN.md) before changing anything structural — it
carries the measurements the design rests on, not just the design.

## The one fact that must not be forgotten

**ICMP inside a container on this host is fabricated.** Colima's NAT answers echo
requests itself, including for RFC 5737 black-hole addresses. Verified
2026-07-30, `--network host` included. Any future "let's simplify by moving the
collector into the container" produces a dashboard that reports perfect uptime
forever and is silently wrong.

TCP connect from a container *is* honest (`192.0.2.1:443` correctly times out),
so a TCP-based probe is the legitimate fallback if ICMP ever becomes awkward.
Throughput through the VM is unaffected, so speed tests belong in the container.

## Shape

| Piece | Where | Why |
|-|-|-|
| `collector/{probe,ping-parser,vantage,link-sampler,wifi}.ts` | native, launchd | real ICMP + the host's own vantage + 1 Hz link state + the radio; no npm deps |
| `collector/heartbeat{,-verdict}.ts` | native, launchd, 60 s | pushes the Uptime Kuma heartbeat; its own agent so a dead collector is still reportable |
| `collector/watchdog{,-ladder,-state,-report}.ts` | native, launchd, 15 s | decides and acts on a wedged line; **ships in shadow mode** |
| API + SQLite + Ookla + router poll + UI | Docker (`:7731`) | restart policy, rollhook CD |

The collector POSTs batches with a bearer token and **spools to
`collector/spool.jsonl` on failure**, replaying on the next successful cycle. Do
not "simplify" the spool away — without it every redeploy writes a fake outage
into the record.

**Alerting is a missed heartbeat, and that is the design.** Uptime Kuma runs on
the homelab, on a different WAN, and the Tailscale ACL has no `tag:homelab →
tag:mac` grant — so it cannot probe this line even in principle. The mini pushes
to it every 60 s (`Home Line - Push`, 240 s to DOWN); a home-line outage severs
the push and the alert leaves the homelab over a WAN the outage does not touch.
Silence means the line or the mini is gone; an explicit `down` push means
linewatch stopped measuring while the line works. **`GET /api/status`'s own `up`
field cannot be used for this** — no ingest means no outage row can open, so a
dead collector reports a flawless line forever. `collector/heartbeat-verdict.ts`
checks sample freshness for that reason and its tests pin it.

**The watchdog ships disarmed, and both of its switches are load-bearing.**
`LINEWATCH_WATCHDOG_ARMED` in the plist decides whether an authorised rung is
*performed*; without it the machine still walks the whole ladder and writes
`would_*` notes, which is the only thing that makes a shadow run worth its
weeks. `LINEWATCH_ROUTER_WRITE` in the container decides whether the executor
can reach the device at all, and the watchdog **reads that capability from
`GET /api/router` rather than assuming it** — the two processes are configured
separately, so guessing would make a shadow run report actions that never
happened. `make watchdog-readiness` measures the arming conditions;
`make watchdog-disarm` is the stand-down, one file, `touch`-able from a phone
in the seconds the link is up.

The ledger lives at `~/.local/state/linewatch/watchdog-state.json`, **never
beside `spool.jsonl`** — a `git clean` that reset the reboot budget and the
latch is the single failure that turns this into a reboot loop. An unreadable
ledger disarms rather than resets: an empty one has a full budget and no latch,
which is exactly the wrong reading after a crash. Every state transition lives
in `decide()`, not the runner, because the runner executes for real about once a
month and the tests are the only thing that exercises this monthly code daily.

**The database is in the `linewatch-data` named Docker volume and the host
cannot open it.** Read it with `make db-counts` / `make db-shell`, never by
opening the file — [`docs/storage.md`](docs/storage.md) has the rule, the
corruption that forced it, and the backup/restore targets.

## The dashboard runs on basalt-ui, and the guards are the contract

`web/` is a **basalt-ui** app (Mantine v9 + TanStack Charts). The stack, the token rule, the
local-bin rule and the rule precedence are stated once, in the managed block of
[`web/AGENTS.md`](web/AGENTS.md) — this section holds only what is specific to this
repo. The enforcement layer was inert for most of this project's life (no `init`, no
lint, no hook, no CI) and the dashboard grew **two card idioms** before anything could
say they disagreed; the guards below exist so that cannot happen silently again.

- **`cd web && bun run lint` is the gate** — `oxlint . && basalt-ui check-theme`.
  It runs pre-commit (root `lefthook.yml`) and in CI (`.github/workflows/check.yml`).
  Both configs live at the **repo root**, not in `web/`: `basalt-ui init` seeds them
  into the package directory, which is a directory neither GitHub nor lefthook reads.
- **No shade-pinned Mantine colours** (`c="yellow.7"` is one fixed swatch in both
  schemes, so a step legible on dark is the one that fails contrast on light) — use
  `VX.status.*` or a bare hue.
- **One card idiom: `<Card py="xs" px="sm">`.** Never `withBorder` — card depth is
  `--vx-shadow-card`, which already bakes a 1px ring into the shadow, so `withBorder`
  draws a second real edge on top of it. Never an explicit `radius` or `padding`; the
  theme pins both.
- **Reach for the shipped prop before wrapping a shipped component.** `StatCard.tone`
  draws the threshold rail this repo used to hand-roll as a 35-line positioned `Box`
  — and adds the `VisuallyHidden` label the hand-rolled one never had, so the verdict
  was colour-only. A wrapper around a design-system component is how the second idiom
  starts.
- **`components/status-bar.tsx` is the one standing deviation from the one-card-idiom
  rule.** `StatCard` cannot render its own header at bar density (six cells, ~230px
  each), so its cells are hand-rolled — but they still reproduce `StatCard.tone`'s 3px
  rail, its `VisuallyHidden` threshold sentence and a `WidgetHeader tier="widget"` label
  per cell, pinned by `status-bar.render.test.tsx`. The bar is still one card; the
  deviation is the cell markup, never the accessible surface. History:
  [`docs/dashboard-charts.md`](docs/dashboard-charts.md).
- **After a `basalt-ui` upgrade, run `./node_modules/.bin/basalt-ui sync`** — `sync --check`
  gates the drift in CI and pre-commit. The hook and the workflow both call the local bin
  (never `bunx`, see `web/AGENTS.md`). Since 1.23.0 the CLI also resolves the package from
  the **repo root**, so `./web/node_modules/.bin/basalt-ui doctor` from the git root answers
  for `web/`.
- **`web/DESIGN.md` is this app's thin delta** on the managed `web/.claude/rules/basalt-*.md`
  (its series dictionary and any deliberate deviation) — it is **not**
  [`docs/DESIGN.md`](docs/DESIGN.md), which is the collector and data design and has nothing
  to do with the visual system.
- **A guard finding is fixed at the source, not silenced.** `theme-allow <rule-id> —
  <reason>` waives that node/line only; `theme-allow-file <rule-id> — <reason>`
  waives the whole file. A bare comment waives everything but reports
  `theme-allow-unscoped`; a typo in the id slot waives **nothing** (fails closed).
  The annotation must **start** its comment and reaches the first **code** line
  below it — inside `{cond && (…)}` that means `//`, since `{/* */}` there is a
  syntax error. Nothing here uses `theme-allow-file`; every waiver is node-scoped.
  `./node_modules/.bin/basalt-ui check-theme --audit-allows` exits 1 on a dead waiver.
- **The dashboard's `<head>` is `basaltAppPlugin`'s, not `index.html`'s.**
  `basaltAppPlugin` (`web/vite.config.ts`) resolves `theme-color` from `SURFACE.bg`
  so it tracks a retune; `manifest`/`icons` stay off (tailnet dashboard, no
  `public/`). `check-theme` reads `index.html` as of 1.20.0, so a hex put back
  there fails the build.
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
  `CategoryGrid`; on the speed heatmap *failed* and *absent* share one flat fill and only the
  tooltip separates them (D2, accepted — `docs/waves/evidence/w7.md`).
- **Every chart takes `tooltip.onFollow: inView`, never `true`.** `onFollow` is basalt's
  boolean (a follower shows its tooltip while a sibling owns the cursor); `inView` is
  `charts/use-in-viewport.ts`, which tracks the NODE, so an off-screen chart does not draw over
  the tooltip the reader is looking at. `charts/follower-tooltip.test.ts` pins it as a source
  test (a follower state needs a sibling's live cursor, which `renderToStaticMarkup` cannot
  produce). The gate was measured against 1.x's clamping float; 2.x's behaviour without it is
  not re-measured, so it stays as the cheap precaution. There is no `tooltip.follow` and none is
  needed: the tooltip anchors to the cursor's column, so every chart sharing it lines up on the
  instant being read. History: [`docs/dashboard-charts.md`](docs/dashboard-charts.md).
## Conventions

- Bearer auth on the five routes that write to the historical record or to the
  line itself: `POST /api/probes`, `POST /api/interventions`, `POST
  /api/router/poll`, `POST /api/router/actions/reconnect` and `POST
  /api/router/actions/reboot`. The last two carry a **second, independent gate**,
  `LINEWATCH_ROUTER_WRITE`, unset by default: the bearer stops someone else
  acting, the capability switch stops *us* — a bad deploy, a watchdog gone
  wrong, a test pointed at the wrong host. Everything
  else is open on the tailnet — including `POST /api/speedtests/run`, which is a dashboard button
  with no token to present and is **rate-limited instead** (429 within
  `speedtestMinIntervalS`, 5 min by default, measured against the newest
  `speed_test` row so a container restart cannot reset it). Saturating the line
  is its only abuse and the limit caps that. `grep -rn hasValidBearer src/` is
  the source of truth; keep this list in sync with it.
- `GET /api/probes` **must** bucket in SQL, and so must any new range route.
  Never return raw rows for a long range — `probe_sample` grows ~4.2M rows/year.
  The router range routes cap with an explicit `limit` instead.
- Outages are materialised on write by `services/outage-detector.ts`, not derived
  on read. Single-cycle blips are recorded honestly and filtered in the UI.
- `probe_cycle` records what each cycle measured **through** — default-route
  interface, path class, negotiated media/link speed/duplex, the NIC's
  *supported* ceiling (`link_max_mbit`, which is what tells a cable fault from a
  100 Mbit adapter), gateway, DHCP lease start, link-sampling coverage, NIC
  error counters. `on_home_line` is three-state: 1 / 0 / **null = unknown**. Never
  coalesce null to 1 on a read path, and never default an unparseable field to a
  plausible value; that fabrication is the exact bug the table exists to prevent.
  `ts` is UNIQUE so a spool replay is idempotent.
- `link_change` events are materialised on write, like outages — by the probe
  ingest when the host-side vantage changes, by the same ingest for each
  sub-cycle transition the collector's 1 Hz link sampler reports
  (`detail.source: "link-sampler"`, de-duplicated by an explicit ts+kind check
  because `event.ts` must never gain a unique index), and by the router poller
  from the carrier side. **1 Hz resolves transitions of ~2 s and longer: no
  recorded transition means none was observed above that resolution, never that
  the link was stable.** `intervention` is written by `POST /api/interventions`.
  All four `event` kinds are now written. `config_change` records container
  starts, so a deploy stops being indistinguishable from the router refusing to
  answer; `note` carries poller telemetry (non-clean polls only — a clean poll
  evidences itself in the rows it stored, and one note per poll would be 52k
  rows a year in the table the UI timeline reads).
- `wifi_sample` records the radio every 10th cycle (5 min — `system_profiler
  SPAirPortDataType` costs 4.8 s median, so per-cycle is not affordable). Call
  it **an alternate radio path currently attached**, never "the standby path":
  the service order puts a cellular hotspot above Wi-Fi, and Wi-Fi is only the
  effective alternate because no cellular device is attached today. `ssid`,
  `bssid`, `mac`, `security`, `country_code`, neighbour rows and a stored `snr`
  are deliberately absent and must stay absent; the parser reads only the
  connected interface's `Current Network Information` block and stops at `Other
  Local Wi-Fi Networks`. `tx_rate_mbps` is a PHY/MCS rate, not throughput — no
  verdict may call the radio faster than the wire off it (measured: 9.99 ms RTT
  on Wi-Fi vs 5.24 ms on Ethernet).
- The router **poller** is read-only, and writes live in one place:
  `services/router/actions.ts`, off unless `LINEWATCH_ROUTER_WRITE=1`. A reboot
  reports **three** outcomes, not two: `executed` when the device acknowledged,
  `failed` when it rejected the operation (HTTP 200, `errorcode: 1` — the
  firmware validates the operation before acting, which is what makes a wrong
  name distinguishable from a successful reboot), and `unknown` when the
  transport died, which is the expected signature of success and is settled only
  by the probe record. Never read `unknown` as either. That
  module is the only thing in this repo that can write to the device, and its
  surface is deliberately tiny. The reason is not style: `/js/gdprProxy.js`
  routes every verb — `go`/`gl`/`gs`/`so`/`ao`/`do`/`op`/`cgi` — to the same
  `/cgi_gdpr?9` with the verb inside an AES-encrypted body, so **no firewall,
  proxy or URL rule can tell a line-statistics read from a factory reset**. Code
  is the only layer where that distinction can exist. So the OID never crosses a
  module boundary: `sendAction` takes one of four *intents*, the intent→operation
  map is module-private and frozen, membership is asserted at runtime at the
  single send site, and a test greps the module for destructive operation names.
  Do not add `act(oid: string)`; it would put all eight read call sites one
  argument from an action, and the factory-reset constants are declared five
  lines from the PPP ones in the router's own JavaScript.
- **The `ACT_*` names in that JavaScript are identifiers, not the strings they
  stand for.** `var ACT_OP_PPP_CONN = "ACT_PPP_CONN"` — the whole family drops
  `_OP` between name and value. Sending the identifier gets HTTP 200 with
  `errorcode: 1`, measured. The same fact settles the reboot name that read as
  ambiguous across two firmware pages.
- No schema table stores a MAC — **or a device name**: `router_host.host_name` was dropped in
  migration 0005 because a fifth of the stored names were vendor defaults of the
  form prefix + 12 hex digits, i.e. a MAC with its separators stripped, which no
  value-level MAC pattern catches. `parseHosts` does not read the field and
  `redact.ts` blanks name-shaped keys; do not add either back. **Dropping the
  column does not erase what it held** — SQLite returns the old pages to the
  freelist without zeroing them, so the values stay recoverable from the file and
  its WAL until `make db-vacuum` runs. Migration 0005 is only half the fix; the
  vacuum is the other half, and it has to run after the migration has applied.
- The router poller logs in **fresh every poll** (cadence from
  `LINEWATCH_ROUTER_CRON`, 10 min by default) and never repairs a held session:
  holding it meant an eviction started a 15-minute re-login backoff that
  swallowed the next three polls, measured at 20 of 55 due polls stored. Do not
  reintroduce a session kept alive between polls "to be polite" — a failed login
  must stay a missing sample, never a carried-forward reading.
- This is a public repo: no real MAC, hostname, ISP name, city, public IP or
  credential in tracked files, fixtures and tests included.
- The dashboard's fetch layer has a single `USE_MOCK` switch. Keep it working;
  it is how the UI is developed before real data accumulates. **The mock must not
  be more generous than the API** — it once returned a `title` on every verdict
  that the server has never sent, so the whole verdict band shipped with empty
  headlines and the client's own type said the field was required.
- **The dashboard is one page, one range control, and no navigation chrome.** Do
  not add a route, a sidebar or a second range selector; the five-route version
  re-scoped the data silently as the reader navigated, which is why it is gone
  (`web/src/routes/index.tsx`'s docblock has the full history). Every figure is
  taken over the selected window — including the Speed percentiles, which are
  computed client-side (`lib/speed-stats.ts`) precisely because
  `GET /api/speedtests/summary` only takes whole days. The one block the range
  does not scope is the 30-day heatmap, and it says so on itself. A section's
  *evidence* may sit behind a named view switch; a **conclusion never may** — every
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

  Implementation history and the measurements behind all seven rules above:
  [`docs/dashboard-charts.md`](docs/dashboard-charts.md).

## Validate

`make check` (typecheck + `bun test`). The ping parser is tested against real
macOS `ping` output fixtures — including the 100%-loss case, where `ping` **exits
non-zero and prints no round-trip summary line**. That is a valid measurement,
not an error; never gate on the exit code.

Drive containers via `make`, never raw `docker` (the global docker-makefile rule,
and a hook enforces it).

## Deploy

There is **no CD**: `.github/workflows/` holds only `check.yml`, and no rollhook webhook ships
this repo (verified 2026-10-15 — a merged fix stayed undeployed until `make up`). The API, SQLite
store, router poller and dashboard (`docs/DESIGN.md`) ship by **`make up` on the mini from an
up-to-date `master` checkout**: it builds and recreates the container, waits for `/health` and
proves the container is the working tree. So pull `master` first; never `make up` from a feature
branch or a dirty tree. `make deploy` only prints this. The native collector, heartbeat and
watchdog are launchd agents with their own `make *-setup` / `make *-teardown`; a change under
`collector/` reaches the mini through those.

## Verify & Monitor

- **Health URL:** `http://127.0.0.1:7731/health` — `GET /health`, the endpoint the
  container's own healthcheck probes (`docker-compose.yml`); the port is published
  on loopback only. `make verify` curls it and exits non-zero when the stack is not
  answering.
- **Uptime Kuma:** the line monitor is `Home Line - Push`, fed every 60 s by
  `collector/heartbeat.ts`, 240 s to DOWN. **Silence is the alert** — it runs on the
  homelab's different WAN, so a severed push is the home-line outage signature. A
  second push monitor, `Home Line - Watchdog`, carries the watchdog's own liveness.
  `make heartbeat-status` prints the verdict without pushing.
- **OTel `service.name`:** none — this repo carries no OpenTelemetry
  instrumentation and exports no traces, metrics or logs. The Uptime Kuma
  heartbeat above is the whole monitoring surface; there is no OTel resource to key
  a dashboard on.

## Gotchas

- **Migrations run at module load, and the import order is load-bearing.**
  `src/db/client.ts` migrates as a side effect of being imported, not from a
  statement in `src/index.ts`: ES imports are evaluated before any statement in the
  importing module's body, so a `runMigrations()` call at the top of `index.ts`
  still runs *after* `services/outage-detector-instance.ts`, which queries at module
  scope. On a fresh database that ordering crashed the process with `no such table:
  outage`, and the test suite missed it because tests use a pre-migrated DB. Keep
  migration an invariant of importing the client.
- **`make logs` is a bounded tail now** (`--tail=200`, then exits). It no longer
  follows; `make logs-follow` does. `make collector-logs` / `heartbeat-logs` /
  `watchdog-logs` are unchanged and still follow their host-side logs.
- **Container ICMP is fabricated** — see "The one fact that must not be forgotten"
  at the top. The collector stays native; a containerised probe reports a flawless
  line forever.

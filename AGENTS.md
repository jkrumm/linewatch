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

## Boot order trap, already hit once

`src/db/client.ts` runs migrations **at module load**, not from a statement in
`src/index.ts`. ES imports are evaluated before any statement in the importing
module's body, so a `runMigrations()` call at the top of `index.ts` still runs
after every transitively imported module — including
`services/outage-detector-instance.ts`, which queries at module scope. On a fresh
database that ordering crashed the process with `no such table: outage`, and the
test suite did not catch it because tests use a pre-migrated DB. Keep migration
an invariant of importing the client.

## The dashboard runs on basalt-ui, and the guards are the contract

`web/` is a **basalt-ui** app (Mantine v9 + visx). The stack, the token rule, the
local-bin rule and the rule precedence are stated once, in the managed block of
[`web/CLAUDE.md`](web/CLAUDE.md) — this section holds only what is specific to this
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
  (never `bunx`, see `web/CLAUDE.md`). Since 1.23.0 the CLI also resolves the package from
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
- **A single-plot cartesian chart composes `CartesianChart` and draws only marks —
  lint-enforced (`basalt/hand-rolled-plot`), not a preference.** Every chart on this
  page is now on a shipped kind (`CartesianChart`, `BandStrip`, `MirroredBars`) and
  the waivers are gone. **Do not hand-compose a plot again**: if a shape doesn't fit,
  the answer is a kind upstream, not a waiver here. History:
  [`docs/dashboard-charts.md`](docs/dashboard-charts.md).
- **`ChartTooltipFloat` portals to `document.body`; never its predecessor `ChartTooltip`**
  (a plain `<div>` that mounts silently unpainted inside `<svg>`). `series` is the single
  source of truth — legends and tooltip rows are DERIVED from it (`basalt/chart-legend-literal`
  warns otherwise); `speed-chart.tsx`'s reference legend goes through `deriveLegend(refSeries)`
  until `refLines` takes a `label`.
- **Every chart takes `tooltip.onFollow: inView`, never `true`** — `ChartTooltipFloat` has no
  viewport gate of its own and clamps an off-screen follower over the tooltip the reader is
  looking at; `charts/use-in-viewport.ts` tracks the NODE, and
  `charts/follower-tooltip.test.ts` pins both halves. Only the latency band anchors as a source
  (`tooltip.follow: false`), because three charts share its column.
  History and measurements: [`docs/dashboard-charts.md`](docs/dashboard-charts.md).
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
  is gone from the route.** `createSearchStore` (basalt-ui 1.26.0) takes typed
  fields, so the range, the outage-duration bound and the density toggle each
  declare their own lanes once — `range` on the URL with a localStorage mirror
  under it, `minDuration` URL-only (`persist: false` — a filter you narrowed once
  should not narrow every later visit), `compact` local-only (`url: false`). The
  URL is still the truth for the first two: a link to a reading carries `?range=`,
  and `?range=nonsense` falls back instead of throwing a `ZodError` out of
  `validateSearch` (`z.enum().default()` only defaults an ABSENT key, so a
  hand-edited URL used to take the page down). Two things that are easy to get
  wrong here: **the store's own navigate already passes `resetScroll: false`**, so
  never hand-roll one beside a field write; and **`field.range` must be written
  with an explicit `custom: false`** — called inline inside `fields`, its `const C
  extends boolean` re-infers against `AnyField`'s widened `RangeField` and every
  read of `search.range` silently widens to `RangeOption | 'custom'`, a value this
  store can never hold. The reciprocal gap is upstream and costs one cast in
  `routes/index.tsx`: `RangeFilterProps.field` pins that same argument to its
  default `boolean`, so the control cannot take a `custom: false` handle.
- **The page's chrome is basalt's `PageBar`, and the sticky height is its own.**
  Shell-less, so both rows render in flow with `title` leading and the whole bar
  publishes its measured height as `--basalt-page-bar-h` in the LAYOUT phase —
  which is what every section anchor's `scroll-margin-top` clears. The
  `useElementSize` + `useLayoutEffect` publisher, the `--lw-header-h` variable and
  its `96px` fallback are all gone; do not reintroduce a measured header height.
  Two consumer-side facts: the full bleed across `__root.tsx`'s Container gutters
  and the hairline under the bar arrive through `PageBar.className`
  (`components/page-bar.module.css`) because they are the only part of the layout
  basalt cannot know. **The gutter itself is basalt's, stated once**: since 1.30.0
  `--vx-space-app-shell-inset{,-mobile}` (20/8) are emitted for exactly this
  shell-less case, so `routes/root-layout.module.css` sets the Container's
  `padding-inline` from them and `.bleed` cancels the same var at the same 48em
  step — never a second copy of the number, and never a Mantine spacing key. And
  the bar renders **three** secondary actions inline before
  folding the rest into a `More` dropdown — which is why the version string sits on
  `filtersEnd` rather than becoming a fourth.
- **Axis label vs. scale key are different things.** Bucketed charts key on the
  bucket's ISO start (`formatX`/`bucketTickFormat`); run charts key on the run's ISO
  instant (`runAxisKey`/`runTickFormat`). Never a pre-formatted display string as the
  domain key — it collapses distinct buckets/runs onto one x position and drops a
  measurement. Same rule for the tooltip header.
- **Every chart shares one cursor, keyed on the instant.** All six charts sit in one
  `ChartCursorScope`; every cartesian x scale is a `scalePoint` over the domain's
  keys, so positions are evenly spaced regardless of the real time gaps — expected,
  not a bug. Heatmaps join no cursor (hit-test per cell, never broadcast).
- **`tooltip.formatHeader` must format from the instant, never regex the domain
  key.** A UTC ISO key regexed for `YYYY-MM-DD` and rebuilt as a LOCAL `Date` can
  name the wrong calendar day. Pinned by `charts/tooltip-header.test.ts`.
- **All six charts pass `lib/axis.ts`'s `axisTickValues` as `xTickValues`**, computed
  from the chart's own resolved plot width — never a tick count or basalt's default
  spacing (both overlap at typical densities).
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

## Validation

`make check` (typecheck + `bun test`). The ping parser is tested against real
macOS `ping` output fixtures — including the 100%-loss case, where `ping` **exits
non-zero and prints no round-trip summary line**. That is a valid measurement,
not an error; never gate on the exit code.

Drive containers via `make`, never raw `docker` (the global docker-makefile rule,
and a hook enforces it).

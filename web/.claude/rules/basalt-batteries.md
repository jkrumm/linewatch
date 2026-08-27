---
source: basalt-ui
description: The adapter batteries — query, forms, notifications, commands, data, content, agent — plus app bootstrapping (vite preset, CSS layer order, init/sync). One doctrine each: use the shipped seam, don't re-roll it.
paths:
  - 'src/**'
  - 'apps/**/src/**'
  - '**/vite.config.ts'
  - '**/index.html'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `basalt-ui check-coverage --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — none · oxlint rules — basalt/agent-no-raw-usechat, basalt/agent-resume-guard, basalt/ai-sdk-major -->
<!-- not guarded: — -->
<!-- /basalt:coverage -->

# Basalt Batteries — the adapter surfaces

Each battery is a subpath with **one** doctrine: the shipped seam is the seam, and re-rolling it is
the failure this rule exists to prevent. Every peer named below is OPTIONAL — install it before
importing the battery. The API is in the shipped types, the JSDoc and `llms.txt` at the install
directory; what follows is only what a reader gets wrong without being told.

## `./query` — TanStack Query

`@tanstack/react-query` is a REQUIRED peer (`BasaltProvider` needs it at build time). Import the
hooks from `basalt-ui/query`, never dual-import from `@tanstack/react-query`.

- **One factory per resource**, keyed `[resource, action, ...params]`, built with `queryOptions`;
  components import the factory, never a raw string key.
- **`queryFn` wraps the call in `unwrap()`** — it throws on the error branch AND on a `null` data
  with no error (a 204, a silent transport failure). Both are caller bugs, so both must surface.
- **Render a query with `QueryState`, don't write the switch.** Rendering only the empty branch is
  the bug it retires: a consumer's library showed `No images` on a 500 because nobody wrote the other
  three branches. Precedence is error-without-data → empty → loading → children, plus a cached-data
  banner when a refresh fails over existing data. `LoadingState`/`ErrorState` ship beside it for a
  page that must place the branches in different DOM positions.
- **`QueryState` takes `useQuery`, not `useSuspenseQuery`** — a suspense read never hands you an
  undefined `data` or an error branch, so there is nothing to decide. Suspense + an error boundary
  and `QueryState` are the two ways to render a query; pick ONE per read. Inside a
  loader-prefetched route, `useSuspenseQuery` + `ensureQueryData` is the pair.
- **`query` is a structural subset checked at runtime** — a composed or hand-rolled result passes
  with no cast, and a missing `isError` throws naming the field rather than rendering a false claim.
- Decode an unknown error with `toErrorMessage(err, fallback?)` / `errorStatus(err)`; invalidate by
  resource PREFIX after a mutation; `BasaltQueryDevtools` is lazy and production-excluded, so import
  it unconditionally and never the raw devtools package.

## Eden Treaty — three silent `any`s (stated once)

Stated here because they reach both `./query`'s `unwrap` and `./agent`'s transport. Three
patterns silently degrade Treaty inference to `any`, with no TypeScript error at the point of
breakage: a route that is not method-chained back onto the app instance; client and server packages
whose tsconfig path aliases do not resolve identically; and a `t.Object`/`t.Union` **response schema
on a streaming route** (Eden #231, still open). For a stream: no response schema, an explicit
`: AsyncGenerator<AgentPart>` return annotation, and validation at yield time via `parseAgentPart`.
Check these three first whenever Eden types regress.

## `./forms` — `@mantine/form`

- **`useBasaltForm` is the entry**: `mode: 'uncontrolled'` by default (no per-keystroke re-render)
  and `schemaResolver(schema, { sync: true })` when a `schema` is passed. Type a schema param as
  `StandardSchemaV1` from `basalt-ui`, never `ZodSchema` — Valibot, Zod 4, ArkType and Effect all
  satisfy it structurally.
- **`validate` is deliberately omitted** from its options — a cross-field or async rule that the
  schema cannot express drops to a raw `useForm`.
- **`field(form, path)` is the one spread** every uncontrolled Mantine field needs (it bundles
  `getInputProps` + `key`); writing the two by hand is how one gets forgotten.
- **`FormErrorSummary` goes at the TOP of the form** so assistive tech lands on it after a failed
  submit. It renders `null` on a clean form, so include it unconditionally.
- **`useFormDraft` persists through `createPersistedState`** — wire `saveDraft` into
  `onValuesChange` for autosave, call `clearDraft()` in the success path, keep `key` stable across
  renders (changing it recreates the store and loses the draft) and bump `version` on a shape change.
- Errors are inline field errors; a toast is for submit-level failure only.

## `./notifications` — `@mantine/notifications`

- **`notify({ intent, message })` is the surface**, plus the four `notifySuccess/Error/Warning/Info`
  wrappers and `notifyPromise` for an async operation. Intent — not a color — is what maps to the
  Mantine color, the correct aria `role` (polite vs assertive) and the per-intent `autoClose`, so
  **never pass a raw color instead of an intent**.
- **`defineNotifications` + `emit` is the typed registry**: augment `BasaltRegister.notifications`
  once and unknown kinds become tsc errors. `defineNotification` only TYPES a single spec — only
  `defineNotifications(map)` registers, and `emit` before that registration is a runtime no-op.
- **A spec carries no `title`/`icon`** by design; those stay per-call so a varying title is not
  forced into the registry.
- **Colors beyond the four intents live OUTSIDE the registry** — call Mantine's raw
  `notifications.show({ color })` directly, and accept the stated cost: a raw toast is invisible to
  the persisted history, the bell and the center, because only `notify`/`notifyPromise` record.
- History is a module-level persisted ring buffer; `useNotificationHistory` reads it, and
  `NotificationBell` (built for the shell's `globalActions`) opens a `NotificationCenter`, which also
  mounts standalone in any Drawer or panel.
- The overlay MOUNT is basalt-mantine.md's — one place, one statement.

## `./commands` — the command bus

- **`defineCommands` + `runCommand`, `defineOverlays` + `overlays.open`** — augment
  `BasaltRegister` once per registry and unknown ids are tsc errors. The augmentation is type-only
  and erased, so both factories stash their map at module scope: call the factory once, at app boot,
  before anything runs a command.
- **A TS circular-inference footgun**: `overlays.open(...)` inside a `run` in the same module that
  augments `BasaltRegister.commands` can make the map infer as `any`. Annotate that `run`'s return
  type explicitly, or split overlay-opening commands into their own file.
- **Projections, not parallel lists**: `toSpotlightActions()` (respecting each command's `when()`),
  `toShortcutList()` / `ShortcutsHelp` for display, `toHotkeyBindings()` / `useCommandHotkeys()` for
  the live keys. Never hand-author a second list of the same commands.
- Reach for `openSpotlight`/`closeSpotlight` from `basalt-ui/commands`, not Mantine's global
  `spotlight` — `BasaltOverlays` mounts against basalt's own store.
- **Imperative overlay vs route**: `overlays.open` for an ephemeral confirm or quick edit; a route
  for anything that must be shareable, refreshable or back-button-addressable.

## `./data` — TanStack Table + Virtual

- **Read the props before hand-rolling anything**: title/icon/subtitle + count, an `actions`
  toolbar slot, `facets`, global search, client- or server-side pagination, column pinning, sticky
  header, `maxHeight`/`minWidth`, per-column `meta.align` and `meta.numeral` are all there.
  `meta.align` is a `ColumnMeta` augmentation, so a typo is a tsc error and a bad VALUE throws naming
  the column — declare alignment once instead of on both the `th` and the `td`.
- **Adopt it for ownership, not for a line count.** One consumer's port ran 29–38 lines LONGER:
  accessor blocks cost more than bespoke `<Table.Td>` rows. What it buys is the `type="native"`
  scroll footgun, alignment stated once, and sorting/filtering/pagination no longer being yours.
  A table with no sorting, no pagination, no filter and no alignment to declare is a layout grid —
  adopting the component there buys nothing.
- **`manualPagination` imposes a contract on every other prop**: `data` becomes one server page
  while the bar still claims `of N`, so sorting (`manualSorting` or `enableSorting={false}`),
  filtering (`manualFiltering`) and the count (`rowCount`) must each be resolved explicitly.
  Unresolved, it throws in dev naming every breach and degrades to the honest table in production.
  Read the throw; don't work around it.
- **The escape hatch is the same subpath**: `useReactTable`/`flexRender`/the row models are
  re-exported, so a bespoke table needs no direct `@tanstack/react-table` import — and it scrolls
  through the identical `Table.ScrollContainer type="native"` node.
- **`BasaltVirtualList` above a few hundred rows**; below that a plain `Stack`/`Table` is cheaper.
  It sets `useFlushSync: false` for React 19 itself — do not override it.

## `./content` — prose, markdown, MDX

- **Three entries, one typography layer**: `Prose` (JSX children), `Markdown` (a string — CMS,
  files, streamed model output), `mdxComponents` (an MDX pipeline's component map). `Markdown` wraps
  its own `Prose`; MDX output does not, so wrap it or use `ArticleLayout`.
- **`streaming` is a RENDERING mode, not a trust claim.** `contentTrust` is the independent security
  input and the sole input to the image-origin allowlist: **any surface rendering agent or model
  output must pin `contentTrust="untrusted"`** — an auto-fetched image is the classic
  prompt-injection exfiltration channel. Link/script hardening is always on, streaming or not, and
  `sanitizeSchema` only ADDS to the default schema.
- **Every optional peer degrades, except one.** No `shiki` (or an unknown language) renders a plain
  mono block; no `beautiful-mermaid` leaves the fence as code; `remend`'s streaming repair and the
  markdown renderer resolve lazily. Six mermaid diagram types are covered — anything else is a
  consumer escape hatch outside `Markdown`.
- **`ArticleLayout` is the docs frame** (meta header, sticky scroll-spy TOC, prev/next); every
  linking content component takes `renderLink` as the router bridge and defaults to a plain anchor.
- **The Article model is data + pure operators**, generic over the taxonomy — the app declares which
  categories and tags exist (`satisfies readonly Article<Cat, Tag>[]`, deliberately no factory).
  Filter state is store fields, and the filter UI is `FilterSet`/`ViewTabs`/`MultiSelectFilter`,
  re-exported here so a content-only consumer has one import path (basalt-controls.md).
- Build-time content tooling (`content-collections`) is a RECIPE, not a dependency; its vite plugin
  must run FIRST because other transforms resolve its virtual module.

## `./agent` + `./agent-chat` — streaming chat

- **`./agent` is headless and Mantine-free; the chrome is `./agent-chat`.** `./agent` ships no
  markdown renderer at all (`agent → content` is lint-blocked), so `PartList` takes a
  consumer-supplied `components.text`; basalt's own is `./content`'s `Markdown`.
- **Every switch over `AgentPart` ends with `default: return assertNever(part)`** — that is what
  makes a new variant a compile error instead of a silently dropped part.
- **`aiSdkTransport` is the recommended default** (optional peer `ai`, resolved lazily on first
  stream); `edenTransport` is the zero-extra-dependency alternative. Neither is deprecated. The
  transport is an injected seam, so a mock is just an object with a `stream` generator.
- **`useAgentStream` runs ONE turn; `useAgentThreadRuns` runs N keyed by thread id.** Reach for the
  latter for the many-short-chats shape, with `createThreadsStore` as its persisted registry.
- **basalt ships the outcome-resolver SEAM, never an LLM call.** `heuristicOutcome` is a demo
  fallback; production derives `{ title, summary, status }` from the finished run. The outcome shape
  is deliberately DIFFERENT from the transcript so raw prompts and thinking cannot leak into a feed.
- **Stream resumption is a client contract, not a backend**: a `StartPart` carries the token, the
  transport implements `resume`, and a mount-time reconnect is attempted before an orphaned thread
  falls back to interrupted. A transport that does neither behaves exactly as before.
- **Three lint guards protect this discipline** — an unguarded `resume`, a raw `useChat`, and an `ai`
  major mismatch — and they honour `basalt-agent-allow`, never `theme-allow`. `doctor`'s
  `ai-major-parity` is the cross-package counterpart, because a lint run only ever sees one
  package's manifest.

## App bootstrapping — `./vite`, CSS order, `init`

- **`basaltViteConfig` is config-only and always will be; `basaltAppPlugin` is the plugin half** —
  spread it into your own `plugins` array. Keeping plugins out of the preset is why adopting it never
  injects one you did not ask for. Position is free (`vite-plugin-pwa` self-orders by `enforce`); the
  one real caveat is a plugin emitting files from its own `closeBundle` after the PWA plugin's.
- **CSS layer order is load-bearing**: every `@mantine/*/styles.layer.css` first, then
  `basalt-ui/styles.css`. An unlayered Mantine import outranks `@layer basalt` regardless of
  specificity.
- **Head, manifest and theme colors come from the token palette** — never hand-compute a
  `theme-color` hex or an anti-FOUC background, and set `colorScheme` to whatever the app passes as
  `defaultColorScheme` or you ship a flash of the wrong surface. Icons are bring-your-own: either
  the six default filenames under `public/`, or an `icons` array naming what you actually have (an
  entry reaches the head only when it names a `rel`; every entry becomes a manifest icon). The
  service worker is opt-in and degrades to a warning without its peer.
- **`init` on an existing app is a lint-debt event, not a no-op** — the shipped preset turns on
  whole oxlint plugins the repo was never linted against, so previously-clean code lands with real
  findings. Triage them; do not blanket-disable a plugin. It also patches `basalt.roots` (everything
  derives from it) and a `lint:basalt` script, and it KEEPS an existing `.oxlintrc.json`, which
  leaves the whole basalt lint half off until you extend the preset.
- **The lefthook preset overrides YOU on a colliding key** — a `run:`/`glob:` under one of its
  command names is discarded silently, while `env:`, `exclude:`, `skip:` and your own command names
  merge; `BASALT_BIN` is the sanctioned seam. A broken `extends` target is a hard fail: lefthook
  merges a missing target into ZERO commands and still exits 0.
- **Then run `doctor` and read it to the last line.** `SKIPPED` is a third outcome that exits
  non-zero on its own — a check that could not run is not a check that passed.

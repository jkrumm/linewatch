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
<!-- GENERATED from src/surfaces.ts — `bun scripts/check-coverage.ts --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — none · oxlint rules — basalt/agent-no-raw-usechat, basalt/agent-resume-guard, basalt/ai-sdk-major, basalt/forms-field-key, basalt/query-fn-unwrap -->
<!-- not guarded: — -->
<!-- /basalt:coverage -->

# Basalt Batteries — the adapter surfaces

Each battery is a subpath with **one** doctrine: the shipped seam is the seam, re-rolling it is the
failure this rule prevents. Every peer is OPTIONAL — install before importing. Full API: the
shipped types, JSDoc and `llms.txt` at the install directory — this file is only what a reader gets
wrong without being told.

**Not guarded, honestly**: `forms`, `notifications`, `commands`, `data` and `content` carry zero
guard kinds or oxlint rules — the `not guarded: —` line above is real, not aspirational. Nothing
fails a build if you re-roll one of these seams by hand; follow the doctrine below on trust.

**Deprecation, as a consumer sees it.** A `basalt/deprecated-export` warn means the export still
works but leaves in a stated `removeIn` minor (autofix renames the import, keeps your local
binding). The replacement and removal minor are always in `MIGRATING.md` § Unreleased the moment
the deprecation ships — that file, not the warning text, is where you confirm what to migrate to.
Maintainer mechanics: package `CLAUDE.md` § Deprecation lifecycle.

## Query — `createBasaltQueryClient`/`unwrap` (root barrel, C1: `./query` dropped)

`unwrap()` throws on the error branch AND on a `null` data with no error — both are caller bugs.
Render with `QueryState`, never a hand-written switch (precedence: error-without-data → empty →
loading → children). One factory per resource via `queryOptions`, never a raw string key.

## Eden Treaty — three silent `any`s (stated once)

Reaches both `unwrap` and `./agent`'s transport: an un-chained route, mismatched tsconfig path
aliases, and a response schema on a streaming route (Eden #231) all silently degrade inference to
`any`. Check these three first when Eden types regress.

## `./forms` — `@mantine/form`

`useBasaltForm` (`mode: 'uncontrolled'`, `StandardSchemaV1` never `ZodSchema`) +
`useFormSubmit`/`useFieldArray`/`FormErrorSummary`/`useFormDraft`. A field is two calls, never one
object (`basalt/forms-field-key` guards + autofixes it) — dropping `key` keeps stale text through
`form.reset()`.

## `./notifications` — `@mantine/notifications`

`notify({ intent, message })` — intent, never a raw color, drives the Mantine color AND the aria
`role`. `defineNotifications`/`emit` is the typed registry; only persisted-history calls
(`notify`/`notifyPromise`) reach the bell/center. `notifyUndo` owns the undo-window contract.

## `./commands` — the command bus

`defineCommands`/`runCommand`, `defineOverlays`/`overlays.open` — call each factory once, at app
boot. Project via `toSpotlightActions`/`toShortcutList`/`toHotkeyBindings`, never a hand-authored
second list. `overlays.confirm`/`confirmDelete` need no registry entry.

## `./data/table` + `./data/virtual` — TanStack Table + Virtual (C1: no bare `./data`)

Read the props before hand-rolling anything (facets, pagination, `meta.align`/`meta.numeral`).
`manualPagination` imposes a contract on sorting/filtering/count — unresolved, it throws in dev.
`BasaltVirtualList` above a few hundred rows only.

## `./content` — prose, markdown, MDX

`Prose`/`Markdown`/`mdxComponents` share one typography layer. `streaming` is a rendering mode, not
a trust claim — any surface rendering agent/model output pins `contentTrust="untrusted"`. Every
optional peer degrades gracefully except the sanitizer, which is always on.

## `./agent` + `./agent-chat` — streaming chat

`./agent` is headless/Mantine-free; `./agent-chat` is the chrome. Every `AgentPart` switch ends
`default: return assertNever(part)`. `useAgentStream` runs one turn, `useAgentThreadRuns` runs N by
thread id. Stream resumption reconnects a MOUNT (page reload mid-stream), it never continues a
click — `retry()`/`regenerate()` always start a fresh stream from the cached input.

**Why the three lint guards exist** (a consumer's build fails on one of these; all honour
`basalt-agent-allow`, never `theme-allow`): `basalt/agent-resume-guard` — an unguarded
`resumeStream()`/`useChat({ resume: true })` re-fires under StrictMode with no dedup, use
`useAgentThreadRuns` instead. `basalt/agent-no-raw-usechat` — bypassing the basalt hooks loses the
unmount-abort and supersede guards. `basalt/ai-sdk-major` (+ `doctor`'s `ai-major-parity`) — a v5
stream parsed by a v7 reader throws; nothing else pins the `ai` major across packages.

## App bootstrapping — `./vite`, CSS order, `init`

`basaltViteConfig` is config-only; spread `basaltAppPlugin` into your own `plugins`. CSS layer
order is load-bearing: every `@mantine/*/styles.layer.css` first, then `basalt-ui/styles.css` — an
unlayered Mantine import outranks `@layer basalt` regardless of specificity. `init` on an existing
app is a lint-debt event, not a no-op — triage the new findings, don't blanket-disable a plugin.
Run `doctor` after and read it to the last line (`SKIPPED` exits non-zero on its own).

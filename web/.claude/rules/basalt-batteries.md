---
source: basalt-ui
description: The adapter batteries — query, forms, table, content, agent. Use the shipped seam.
paths:
  - 'src/**'
---

<!-- basalt:coverage -->
<!-- GENERATED from src/surfaces.ts — `bun scripts/check-coverage.ts --write`. Do not hand-edit. -->
<!-- backed by: guard kinds — none · oxlint rules — basalt/agent-no-raw-usechat, basalt/ai-sdk-major, basalt/forms-field-key, basalt/query-fn-unwrap -->
<!-- not guarded: — -->
<!-- /basalt:coverage -->

# Basalt Batteries

`.` requires react, Mantine and TanStack Router/Query; install a battery's own peer before importing its subpath.

## Query

- Wrap every API-client `queryFn` response in `unwrap()` from `basalt-ui` (it throws on the error branch and on `null` data); a mock returning plain data needs none, and the lint sees only an inline `queryFn` calling `fetch(`. [basalt/query-fn-unwrap]
- The client comes from `createBasaltRouter`; extend it via its `query:` option. [type createBasaltRouter]
- Register every kind in `defineNotifications` (augment `BasaltRegister` `notifications`) before calling `emit('kind', payload)`; an unregistered kind is a type error. [type emit]

## Forms

- A field is two calls: `key={fieldKey(form, path)}` and `{...inputProps(form, path)}`, from `basalt-ui/forms`. [basalt/forms-field-key] A boolean field (`Checkbox`/`Switch`) adds `{ type: 'checkbox' }`; read a field error as `inputProps(form, path).error`, never `form.errors.x` (TS4111), and hand it to `FormRow error` only for a raw control. [type inputProps]
- `useBasaltForm` takes a Standard Schema validator, not a `ZodSchema`. [type useBasaltForm]

## Table

- Tables are `BasaltDataTable` with columns from `createColumnHelper` (`basalt-ui/table`, TanStack Table v9: `sortFn`, not v8's `sortingFn`); column `meta` is `{ align, numeral, priority, kind }`, `kind` one of `entity`, `status`, `number`, `money`, `relative-time`, `meter`, `text` (figures are sans `tabular-nums`, `meta.numeral: false` opts out; units go in the header; a cell holds one line, only `kind: 'text'` wraps); a streamed table's fallback is the same table with `isLoading` and `skeletonRows`. [type createColumnHelper] [type BasaltDataTable]

## Content

- Render model or agent output with `contentTrust="untrusted"`; `streaming` is a rendering mode, not a trust claim. [type Markdown]

## Agent

- Chat uses `basalt-ui/agent` (`useAgentThreadRuns`, `ThreadFeed`, `Composer`); never `useChat` or `Chat` from `@ai-sdk/react`. A turn is live only while `runs.get(id)?.status` is `'submitted'` or `'streaming'`; a failed turn keeps its entry as `'error'`. [basalt/agent-no-raw-usechat] [type ThreadRunState]
- Keep `ai` and `@ai-sdk/*` on one major across packages; an intentional split is waived with `basalt-agent-allow`, never `theme-allow`. [basalt/ai-sdk-major]
- End every switch over `AgentPart` with `default: return part satisfies never`. [type AgentPart]

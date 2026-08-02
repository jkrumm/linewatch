---
source: basalt-ui
description: Streaming-agent layer for basalt-ui apps — Eden-native transport, AgentPart exhaustive handling, StickToBottom, chat history, AND the multi-thread ThreadWorkspace (concurrent runs + a distilled-outcome feed + detail panel). Headless layer in ./agent; the Mantine chrome and markdown rendering (basalt-ui/content's Markdown) ship from the root entry. Covers authoring doctrine and the Eden #231 footgun.
paths:
  - 'src/**/*agent*'
  - 'src/**/chat*'
  - 'src/**/transport*'
  - 'apps/**/src/**/*agent*'
  - 'apps/**/src/**/chat*'
---

# Basalt Agent — Streaming Chat Layer

basalt-ui ships `./agent` — a headless, Mantine-free streaming-chat layer with an injected
transport seam, exhaustive part rendering, auto-scroll, and persisted history. `./agent` ships no
markdown renderer of its own — `agent/** -> content` is lint-blocked by design, so `PartList` takes
a consumer-supplied `components.text`; basalt's own renderer is `basalt-ui/content`'s `Markdown`.

## AgentPart discriminated union

```ts
import type { AgentPart } from 'basalt-ui/agent'
// StartPart | TextPart | ReasoningPart | ToolCallPart | SourcePart | ErrorPart
```

`StartPart` is a no-op resumption signal, not renderable content — see "Stream resumption" below.

Every switch over `AgentPart` MUST end with `default: return assertNever(part)`. This is
enforced by tsc — adding a new variant without a case is a compile error.

## AgentTransport — the injected seam

```ts
import { useAgentStream, edenTransport, type AgentPart } from 'basalt-ui/agent'

// Wrap your Eden call:
const transport = edenTransport<AgentPart>((input, signal) =>
  api.chat.post({ body: { message: input }, fetch: { signal } }),
)

// Wire into the hook:
const { parts, status, send, stop, regenerate } = useAgentStream({ transport })
```

`edenTransport` is zero-dep: it awaits the Eden `{data, error}` envelope, throws on error,
and yields from the `AsyncGenerator<TPart>` data value.

The transport seam is generic (`AgentTransport<TPart, TInput>`) — consumers can extend AgentPart
with domain variants and pass a custom input type. For a mock (tests/playground), implement the
interface directly without `edenTransport`:

```ts
const mockTransport: AgentTransport = {
  async *stream(input) {
    yield { type: 'text', text: `Echo: ${input}` }
  },
}
```

## Eden #231 — the critical stream footgun

**Issue (STILL OPEN):** applying a `t.Object` or `t.Union` response schema to an Elysia
`async function*` stream route collapses the streamed union to `any` in Eden Treaty.

**Mitigation (required doctrine):**

1. **NO response schema on the stream route.** Leave the `.post(handler)` call schema-free for
   the streaming generator.
2. **Validate at yield-time.** Check part shape before yielding, not in the Elysia schema layer.
   Use `parseAgentPart` from `basalt-ui/agent` to narrow untrusted values arriving over the wire:

   ```ts
   import { parseAgentPart } from 'basalt-ui/agent'

   // On the client — e.g. parsing raw NDJSON lines from a custom transport:
   const raw: unknown = JSON.parse(line)
   const part = parseAgentPart(raw) // AgentPart | null
   if (part !== null) handlePart(part)

   // On the server — guard before yielding from external tool output:
   const candidate = buildPartFromTool(toolResult)
   const part = parseAgentPart(candidate)
   if (part !== null) yield part
   ```

   `parseAgentPart` performs structural narrowing against every variant in the discriminated union
   and returns `null` for unknown types or malformed shapes — no exceptions thrown.

3. **Explicit return type annotation.** The handler MUST declare `: AsyncGenerator<AgentPart>`.

```ts
// ✓ Correct — explicit return type, no response schema:
app.post('/chat', async function* ({ body }): AsyncGenerator<AgentPart> {
  // validate body.message here, not via t.Object schema
  yield { type: 'text', text: 'Hello' }
  yield { type: 'text', text: ' world' }
})

// ✗ Wrong — response schema collapses the union to `any`:
app.post(
  '/chat',
  async function* ({ body }): AsyncGenerator<AgentPart> {
    yield { type: 'text', text: 'Hello' }
  },
  {
    response: t.Object({ type: t.Literal('text'), text: t.String() }), // drops to any
  },
)
```

## Two additional Eden silent-`any` footguns

These apply to ALL Eden Treaty usage (not just streams):

1. **Non-chained routes.** Elysia routes MUST be method-chained (`app.get(...).post(...)`). A
   standalone `app.get(...)` that is not chained back drops the `App` type to `any`, losing all
   Treaty type safety.

2. **Mismatched tsconfig path aliases.** Client and server packages MUST share or extend one root
   `tsconfig` so path aliases (`~/*`, `@/*`) resolve identically. A mismatch causes Eden's type
   extraction to fail silently and degrade to `any`.

Both footguns produce no TypeScript error at the point of breakage — they only manifest as `any`
types on the Treaty client.

## useAgentStream

```ts
const { parts, status, send, stop, regenerate } = useAgentStream({ transport })
// status: 'idle' | 'streaming' | 'done' | 'error'
// send(input): starts a new stream, resets parts
// stop(): aborts the in-flight stream via AbortController
// regenerate(): re-runs the last input
```

## PartList — exhaustive rendering

```tsx
import { PartList } from 'basalt-ui/agent'
import { Markdown } from 'basalt-ui/content'

// Default headless renderers (plain HTML elements):
<PartList parts={parts} />

// With basalt's own Markdown for the text renderer:
<PartList
  parts={parts}
  components={{
    text: ({ part }) => <Markdown streaming density="chat">{part.text}</Markdown>,
  }}
/>
```

`PartList` ships five headless default renderers (zero Mantine):

- `text` → `<div className="basalt-agent-text">`
- `reasoning` → `<details className="basalt-agent-reasoning">`
- `tool` → `<div className="basalt-agent-tool">` with labelled input/output `<pre>`
- `source` → `<a className="basalt-agent-source">`
- `error` → `<div className="basalt-agent-error" role="alert">`

`./agent` deliberately ships no markdown renderer of its own — `agent/** -> content` is
lint-blocked by design (the Mantine-free boundary). The package's only markdown renderer is
`basalt-ui/content`'s `Markdown`; `threadPartRenderers` (re-exported from the root `basalt-ui`
entry) already wires it in as the `text` renderer for `ThreadTranscript`/`ThreadWorkspace`.

## BasaltStickToBottom (optional peer)

```tsx
import { BasaltStickToBottom } from 'basalt-ui/agent'
;<BasaltStickToBottom style={{ height: '400px', overflow: 'auto' }}>
  <PartList parts={parts} />
</BasaltStickToBottom>
```

**Install:** `bun add use-stick-to-bottom`

Lazily loaded — `use-stick-to-bottom` is an optional peer. Falls back to a plain scrollable div
while loading. Surfaces a scroll-to-bottom button (`.basalt-agent-scroll-to-bottom`) when the user
scrolls up.

## createChatHistoryStore

```ts
import { createChatHistoryStore } from 'basalt-ui/agent'

// Call once at module scope with a stable key:
const useChatHistory = createChatHistoryStore({ key: 'main-chat', version: 1, max: 100 })

// In a component:
const { messages, append, clear } = useChatHistory()
append({ id: crypto.randomUUID(), role: 'user', parts: [...], createdAt: Date.now() })
```

Built on `createPersistedState` — SSR-safe, cross-tab via the `storage` event. Ring-buffered to
`max` (default 100). Increment `version` when the `ChatMessage` shape changes to clear stale data.

## Multi-thread workspace (shipped)

For the "many short chats" pattern — each prompt a short-lived thread, the feed showing only a
distilled outcome (title + summary), a right-hand detail panel to open and continue — basalt-ui
ships a full workspace. The headless multi-thread layer lives in `./agent` (Mantine-free); the
ready-built Mantine chrome ships from the root `basalt-ui` entry.

### Headless (`basalt-ui/agent`)

```ts
import { createThreadsStore, useAgentThreadRuns, heuristicOutcome } from 'basalt-ui/agent'
import type { AgentThread, AgentOutcome, OutcomeResolver, ThreadStatus } from 'basalt-ui/agent'

// Call ONCE at module scope — same doctrine as createChatHistoryStore:
const useThreads = createThreadsStore({ key: 'main-threads', version: 1 })
```

- `createThreadsStore({ key, version, maxThreads?, maxMessagesPerThread? })` — the multi-thread
  analog of `createChatHistoryStore`: a persisted, ring-buffered registry of `AgentThread`s (each
  carrying its own `ChatMessage[]`, a distilled `AgentOutcome | null`, a `ThreadStatus`, and a read
  flag). Threads are newest-first; `create()` returns the new id and never touches `activeId`.
- `useAgentThreadRuns({ transport, store, resolveOutcome })` — the CONCURRENT run manager. Unlike
  `useAgentStream` (one in-flight turn), it runs N streams keyed by thread id, so many short chats
  stream and resolve in the background independently. `start(threadId, input)` / `stop(threadId)` /
  `stopAll()`; `runs` is the live per-thread `{ status, parts }` map for the detail view.
- `AgentOutcome = { title; summary; status: 'done' | 'attention' | 'error' }` — the distilled feed
  projection, deliberately a DIFFERENT shape from the transcript so raw prompt/thinking can never
  leak into the feed (the enforced boundary).

### Outcome resolver — the summarize-to-outcome seam

basalt ships ONLY the seam, never an LLM call. `OutcomeResolver = (thread) => AgentOutcome |
Promise<AgentOutcome>` — the app supplies it. In production derive `{ title, summary }` from the
finished run (e.g. a structured final step of your own model) and return it. `heuristicOutcome` is
a demo-only fallback that truncates the last assistant text — never the production path.

### Ready-built UI (`basalt-ui`, Mantine)

```tsx
import { ThreadWorkspace } from 'basalt-ui'
;<ThreadWorkspace
  useThreads={useThreads}
  transport={transport}
  resolveOutcome={resolveOutcome}
  newThreadPlaceholder="Ask anything…"
/>
```

`ThreadWorkspace` is the flagship composite: a `ThreadFeed` of distilled `ThreadOutcomeCard`s + an
anchored new-thread `Composer` on the left, a `ThreadDetailPanel` (full transcript + a continue
composer) on the right, collapsing to a single pane below 768px. The lower-level pieces
(`ThreadFeed`, `ThreadOutcomeCard`, `ThreadDetailPanel`, `Composer`, `ThreadTranscript`,
`threadPartRenderers`) are exported too for bespoke layouts. Motion (feed insert, panel slide) runs
on the shared `MOTION_*` tokens and honours `useReducedMotion`.

**Boundary:** the headless layer (`createThreadsStore`, `useAgentThreadRuns`, the outcome types)
stays Mantine-free in `./agent`; the components are Mantine-coupled and ship from the root entry.
Never add `@mantine/*` under `src/agent/**` — it is oxlint-enforced Mantine-free.

**No custom part types at the workspace level.** `ThreadWorkspace`, `ThreadDetailPanel`, and
`ThreadTranscript` render the framework's `AgentPart` union only — they are not generic over a
consumer-extended part type. If you need custom rendering for the existing part shapes, drop to
the headless layer instead: compose your own transcript from `PartList` (`basalt-ui/agent`) with a
custom `components` renderer map, rather than passing a wider type through `ThreadWorkspace`.

## Stream resumption — the reconnect seam

basalt-ui ships the CLIENT-SIDE contract for resuming a run after a disconnect (reload, network
drop) — NOT a concrete backend. A real resumable transport (e.g. Redis-backed run state) is the
consumer's responsibility; this section documents the seam a consumer transport plugs into.

### StartPart

A sixth `AgentPart` variant, emitted once at the top of a run:

```ts
export type StartPart = {
  readonly type: 'start'
  readonly runId: string
  readonly resumeToken?: string
}
```

Not renderable content — `PartList`'s exhaustive switch returns `null` for it, and it's stripped
before the consumer ever sees it: `useAgentStream` skips it in its accumulation loop; `useAgentThreadRuns`
skips it too but additionally reads `resumeToken` off it and stashes it on the persisted
`AgentThread` via `store.setResumeToken`. `parseAgentPart` validates it like every other variant
(`runId` required string, `resumeToken` optional string).

### AgentTransport.resume

```ts
export type AgentTransport<TPart = AgentPart, TInput = string> = {
  stream: (input: TInput, signal?: AbortSignal) => AsyncGenerator<TPart>
  resume?: (resumeToken: string, signal?: AbortSignal) => AsyncGenerator<TPart>
}
```

Optional — a transport that doesn't support resumption simply omits `resume`. `edenTransport`
takes an optional second `resumeCall` parameter (same shape as `call`, but keyed on `resumeToken`
instead of the original input) and only adds a `resume` method to the returned transport object
when `resumeCall` is provided (no `resume: undefined` key otherwise):

```ts
const transport = edenTransport<AgentPart>(
  (input, signal) => api.chat.post({ body: { message: input }, fetch: { signal } }),
  (resumeToken, signal) => api.chat.resume.post({ body: { resumeToken }, fetch: { signal } }),
)
```

### ThreadsStore.resumeToken / setResumeToken

`AgentThread` carries an optional `resumeToken?: string`, set from the run's most recent
`StartPart` and cleared once the run finalizes. `ThreadsStore.setResumeToken(id, token)` is the
setter — same shape/pattern as `setStatus`/`setOutcome`.

### Mount-time resume-before-interrupted

`useAgentThreadRuns`'s mount-reconciliation effect previously marked every orphaned thread
(`'pending'`/`'streaming'` with no live controller — e.g. after a reload mid-stream) straight to
`'interrupted'`. It now attempts a resume first:

1. Find the thread's last `role === 'user'` message (no new user message is created on resume — it
   was already appended before the disconnect).
2. If `transport.resume` is defined AND the thread has a `resumeToken` AND that last user message
   exists, call `transport.resume(resumeToken, signal)` and feed the resulting generator through
   the SAME accumulate/finalize logic as a fresh `start()` call (both share one internal
   `consumeAndFinalize` helper). The resumed run occupies the `runs` map exactly like a live turn —
   reusing the existing `'streaming'` status; there is no separate `'resuming'` ThreadStatus.
3. Any failure — no `resume()`, no `resumeToken`, no user message, or the resume itself throwing —
   falls back to `'interrupted'`, exactly as before.

Resumption is strictly additive: a transport that never emits `StartPart` and never implements
`resume` behaves identically to today (every orphaned thread still lands on `'interrupted'`).

## aiSdkTransport — the RECOMMENDED DEFAULT transport

For LLM chat use cases, `aiSdkTransport` (backed by the `ai` npm package, an OPTIONAL peer) is the
recommended default — `edenTransport` remains fully supported as the zero-extra-dependency
alternative (see above); neither is deprecated.

```ts
import { useAgentStream, aiSdkTransport } from 'basalt-ui/agent'

const transport = aiSdkTransport({ api: '/api/chat' })
const { parts, status, send } = useAgentStream({ transport })
```

**Install:** `bun add ai`. Like `BasaltStickToBottom`, `ai` is lazily resolved via a memoized
dynamic `import()` on first `stream()`/`resume()` — importing `basalt-ui/agent` (or calling
`aiSdkTransport(...)`) never eagerly resolves it. Unlike that, there is no "plain text" degrade
path if `ai` is missing: the rejected import propagates through the async generator
into the consumer's existing error handling (`useAgentStream` → `status: 'error'`;
`useAgentThreadRuns` → its `onFailureStatus`).

**Why diffing is needed.** AI SDK's `readUIMessageStream` yields the FULL accumulated `UIMessage`
snapshot on every update (a growing `parts` array; existing parts' content grows in place) — it is
not itself a delta stream. basalt-ui's whole part-accumulation model is delta-based, so
`aiSdkTransport` diffs consecutive snapshots internally and yields only the new `AgentPart` deltas.
One consequence: `ToolCallPart` gained an optional `toolCallId` field, since AI SDK's tool parts
carry one and re-emit on every state transition (`input-available` → `output-available`) at the
SAME array index — a consumer's own coalescing can key on `toolCallId` to update a tool block in
place instead of rendering a near-duplicate second block.

**Chat id binding.** `aiSdkTransport(options)` mints one stable chat id at construction — the
returned object is immediately usable with `useAgentStream`. Call `.forThread(threadId)` to bind a
transport to a caller-supplied id instead — the form `useAgentThreadRuns` expects when `transport`
is a per-thread factory (see "Multi-thread workspace" above):

```ts
const transport = aiSdkTransport({ api: '/api/chat' })
useAgentThreadRuns({
  transport: (threadId) => transport.forThread(threadId),
  store,
  resolveOutcome,
})
```

**Scope gaps (v1):** `source-document`, `file`, `reasoning-file`, `data-*`, `step-start`, `custom`,
and `dynamic-tool` UIMessage parts have no `AgentPart` equivalent yet and are silently skipped by
the diff — not an oversight, a deliberate v1 boundary (see the code comment in
`ai-sdk-transport.ts`). Tool parts in the `'input-streaming'` state (partial/`DeepPartial` input)
are also skipped — only `'input-available'` and later states emit, to avoid flooding the consumer
with incomplete fragments.

## Deferred (advisory — not shipped)

The following are explicitly deferred and MUST NOT be scaffolded:

- Voice/audio streaming
- `streamdown` integration (Tailwind-only)
- Elysia stream route scaffold in app code (consumer's responsibility)
- `agent-parts.ts` helper files beyond the basalt surface

> The full thread-chat composite (`ThreadWorkspace`) is now **shipped** — see "Multi-thread
> workspace" above. It was previously on this list; a real consumer drove it, so it graduated per
> the "build-when-driven" rule rather than being scaffolded speculatively. `aiSdkTransport` graduated
> the same way — see the section above; it is no longer deferred.

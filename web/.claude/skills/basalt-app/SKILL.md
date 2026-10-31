---
name: basalt-app
description: Scaffold, wire, verify or upgrade a basalt-ui app — `basalt-ui init`, `doctor`, `sync`, and the 1.x to 2.0 upgrade path.
when_to_use: User is adding basalt-ui to an app, wiring BasaltProvider / BasaltShell / the vite preset, upgrading basalt-ui, refreshing the shipped rules, or wiring a freshness check in CI. Also when /basalt-design reports no DESIGN.md.
---

Procedure only; the law is `.claude/rules/basalt-*.md`.

## Scaffold

1. `bun add basalt-ui && bunx basalt-ui init` (the only `bunx` call; use `./node_modules/.bin/basalt-ui` after).
2. Check the seeded `src/main.tsx` (`init` writes it when absent; on a TanStack Start app it seeds none: render `<BasaltProvider><Outlet /></BasaltProvider>` with no `router` in the root route component or a pathless layout, `context.queryClient` set in `getRouter()`); `spotlight={false}` drops Basalt's Cmd+K for an app with its own. `basalt-ui/styles.css` is the only stylesheet import:

```tsx
// @check
import 'basalt-ui/styles.css'
import { createRoot } from 'react-dom/client'
import { BasaltProvider, createBasaltRouter } from 'basalt-ui'
import { routeTree } from './routeTree.gen'
const router = createBasaltRouter({ routeTree })
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
createRoot(document.getElementById('root')!).render(<BasaltProvider router={router} />)
```

3. Import extension layer CSS (`@mantine/dates` for `basalt-ui/controls-dates`, `@mantine/schedule`) after `basalt-ui/styles.css` (core must precede them in `@layer mantine`).
4. Install the peers of each subpath you import: read its `Install: bun add …` line in `node_modules/basalt-ui/llms.txt`; a subpath with no `Install:` line needs only the required peers listed at the top of that file.
5. In `vite.config.ts` spread `...basaltViteConfig({ port, apiTarget })` and register, in this order, `plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), ...basaltAppPlugin({ name, description })]`. Run `bun add -d @tanstack/router-plugin` and import `tanstackRouter` from `@tanstack/router-plugin/vite`.
6. Run `vite build` once so the router plugin writes `src/routeTree.gen.ts` (`tsc -b` fails without it). Follow the repo's own convention for that file: commit it or gitignore it, never both.
7. In `src/routes/__root.tsx`: `<BasaltShell brand={{ name }} nav={NAV}><Outlet /></BasaltShell>`; build `NAV` with `defineNav` in `src/lib/nav.tsx`. basalt has no auth seam and loaders fire before any gate component renders: gate an authenticated app in the root route's `beforeLoad` (throw `redirect`).
8. Add a page as a file route, and link to it with `navTarget`:

```tsx
// @check
import { Link, createFileRoute, linkOptions } from '@tanstack/react-router'
import { PageBar, defineNav, navGroup, navTarget } from 'basalt-ui'
// src/routes/dashboard.tsx — the nav item's `label` is the page name (breadcrumb); export the component too (react/only-export-components)
export const Route = createFileRoute('/dashboard')({ component: Dashboard })
export function Dashboard() {
  // a PageBar only fills slots (actions, sync, tabs, filters); the body has no title
  return <PageBar actions={[{ key: 'export', label: 'Export', primary: true }]} />
}
// src/lib/nav.tsx
export const NAV = defineNav({
  groups: [
    navGroup({ id: 'main', label: 'Main' }, [
      { id: 'dashboard', label: 'Dashboard', link: linkOptions({ to: '/dashboard' }) },
    ]),
  ],
})

// anywhere
export const ToDashboard = () => <Link {...navTarget(NAV, 'dashboard')}>Dashboard</Link>
```

9. Fill in `DESIGN.md` (identity, series dictionary, deviations).

## Add a table

A table is `BasaltDataTable` with columns from `createColumnHelper`; it has no `count` prop (with `title`, the header counts the rows itself):

```tsx
// @check
import { money } from 'basalt-ui/format'
import { BasaltDataTable, createColumnHelper } from 'basalt-ui/table'

type Row = { id: string; name: string; revenue: number }
const col = createColumnHelper<Row>()
const columns = [
  col.accessor('name', { header: 'Name' }),
  col.accessor('revenue', {
    header: 'Revenue',
    sortFn: 'basic', // v9 `sortFn`, not v8 `sortingFn`
    meta: { align: 'right' }, // table number columns are mono-numeral by default (Wave 37 revisits the table face); `numeral: false` opts out
    cell: (c) => money(c.getValue(), { currency: 'USD' }),
  }),
]
export const Revenue = ({ rows }: { rows: Row[] }) => (
  <BasaltDataTable data={rows} columns={columns} getRowId={(r) => r.id} />
)
```

## Add a form dialog

A form dialog is a `defineOverlays` entry opened from a `BasaltDataTable` row action; success is an `emit` of a kind registered in `defineNotifications`. The form component lives in a `*-modal.tsx`:

```tsx
// @check
import { Button, TextInput } from '@mantine/core'
import { defineNotifications, defineOverlays, emit, overlays } from 'basalt-ui/commands'
import { fieldKey, inputProps, useBasaltForm } from 'basalt-ui/forms'

export const NOTIFICATIONS = defineNotifications({
  'item:saved': { intent: 'success', toMessage: (p: { name: string }) => `Saved ${p.name}` },
})
function ItemForm({ name }: { name: string }) {
  const form = useBasaltForm({ initialValues: { name } })
  const save = form.onSubmit((v) => {
    overlays.close() // after the mutation succeeds
    emit('item:saved', { name: v.name })
  })
  return (
    <form onSubmit={save}>
      <TextInput key={fieldKey(form, 'name')} {...inputProps(form, 'name')} label="Name" />
      <Button type="submit">Save</Button>
    </form>
  )
}
export const OVERLAYS = defineOverlays({
  'item:edit': { title: 'Edit item', render: (p: { name: string }) => <ItemForm name={p.name} /> },
})
declare module 'basalt-ui' {
  interface BasaltRegister {
    notifications: typeof NOTIFICATIONS
    overlays: typeof OVERLAYS
  }
}
// BasaltDataTable rowActions entry
export const editAction = {
  key: 'edit',
  label: 'Edit',
  icon: <i />,
  onClick: (row: { name: string }) => overlays.open('item:edit', { name: row.name }),
}
```

## Stream a slow section

The shell holds no promise; the loader returns the slow promise unawaited (settled, so a failure renders the chart's error state), and the fallback is the same chart pending (it fills the final box):

```tsx
// @check
import { Await, createFileRoute } from '@tanstack/react-router'
import { Suspense } from 'react'
import { Lines } from 'basalt-ui/charts'
import type { ChartSeries, ChartState } from 'basalt-ui/charts'
import { VX } from 'basalt-ui/tokens'
type P = { t: number; v: number }
declare const fetchPoints: () => Promise<P[]>
const series = [
  { key: 'v', label: 'Value', color: VX.accent, getValue: (p) => p.v },
] satisfies ChartSeries<P>[]
const chart = (data: P[], state: ChartState) => (
  <Lines ariaLabel="Value" data={data} x={(p) => p.t} series={series} state={state} />
)
export const Route = createFileRoute('/live')({
  loader: () => ({
    points: fetchPoints().then(
      (data) => ({ data }),
      (error: unknown) => ({ data: [], error }),
    ),
  }),
  component: Live,
})
export function Live() {
  const { points } = Route.useLoaderData()
  return (
    <Suspense fallback={chart([], { pending: true })}>
      <Await promise={points}>
        {(r) => chart(r.data, { error: r.error, empty: r.data.length === 0 })}
      </Await>
    </Suspense>
  )
}
```

## Add a chat

1. Install the `basalt-ui/agent` peers from its `Install:` line in `llms.txt`.
2. Implement `ThreadsStore` (in memory here), bind one transport per thread, compose the feed:

```tsx
// @check
import { Button } from '@mantine/core'
import { useState } from 'react'
import { ThreadFeed, ThreadFeedRow, aiSdkTransport, useAgentThreadRuns } from 'basalt-ui/agent'
import type { AgentPart, AgentThread, AgentTransport, ThreadsStore } from 'basalt-ui/agent'

type Thread = AgentThread<AgentPart>

function useMemoryStore(): ThreadsStore<AgentPart> {
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeId, select] = useState<string | null>(null)
  const patch = (id: string, change: (t: Thread) => Thread) =>
    setThreads((all) => all.map((t) => (t.id === id ? { ...change(t), updatedAt: Date.now() } : t)))
  return {
    threads,
    activeId,
    select,
    hydrated: true,
    error: undefined,
    create: () => {
      const id = crypto.randomUUID()
      const now = Date.now()
      const blank: Thread = {
        id,
        messages: [],
        outcome: null,
        status: 'pending',
        read: true,
        createdAt: now,
        updatedAt: now,
      }
      setThreads((all) => [blank, ...all])
      return id
    },
    appendMessage: (id, m) => patch(id, (t) => ({ ...t, messages: [...t.messages, m] })),
    setOutcome: (id, outcome) => patch(id, (t) => ({ ...t, outcome })),
    setStatus: (id, status) => patch(id, (t) => ({ ...t, status })),
    setResumeToken: (id, token) =>
      patch(id, ({ resumeToken: _old, ...t }) =>
        token === undefined ? t : { ...t, resumeToken: token },
      ),
    markRead: (id) => patch(id, (t) => ({ ...t, read: true })),
    remove: (id) => {
      setThreads((all) => all.filter((t) => t.id !== id))
      select((current) => (current === id ? null : current))
    },
    clear: () => {
      setThreads([])
      select(null)
    },
  }
}

const base = aiSdkTransport<AgentPart>({ api: '/api/chat' })
// A mock (swap it in for `base.forThread(threadId)`). A text part is a DELTA: parts with the same
// `id` are appended in order.
export const mock: AgentTransport<AgentPart> = {
  async *stream(input) {
    const id = crypto.randomUUID()
    for (const word of `Echo: ${input}`.split(' ')) yield { id, type: 'text', text: `${word} ` }
  },
}

export function Chat() {
  const store = useMemoryStore()
  const { runs, start, stop } = useAgentThreadRuns({
    transport: (threadId) => base.forThread(threadId),
    store,
    resolveOutcome: (t) => ({
      title: 'Chat',
      summary: `${t.messages.length} turns`,
      status: 'done',
    }),
  })
  return (
    <>
      <Button onClick={() => store.select(store.create())}>New chat</Button>
      <ThreadFeed
        threads={store.threads}
        activeId={store.activeId}
        onSelect={store.select}
        renderRow={(t) => {
          const run = runs.get(t.id)
          const live = run === undefined ? {} : { liveParts: run.parts, liveStatus: run.status }
          return (
            <ThreadFeedRow
              key={t.id}
              thread={t}
              expanded={t.id === store.activeId}
              onToggle={() => store.select(t.id === store.activeId ? null : t.id)}
              {...live}
              onSend={({ text }) => start(t.id, text)}
              onStop={() => stop(t.id)}
            />
          )
        }}
      />
    </>
  )
}
```

3. `ThreadFeedRow` carries the `Composer`; tune it with `composerProps`.

## Verify

1. `./node_modules/.bin/basalt-ui doctor`; read to the last line (`SKIPPED` exits non-zero); fix every finding it prints and rerun until it is clean.
2. Run the repo's own gate (e.g. `make check`), which runs lint, the theme guard (`basalt-ui check-theme`) and typecheck; fix every finding at its source, and every type error without `as never` or `any`.

## Refresh after any upgrade

1. `./node_modules/.bin/basalt-ui sync` (`--check` in CI, `--force` overwrites local edits); read its output: edited files are skipped, retired files are deleted, the AGENTS.md block is rewritten.
2. A bump with a board: build the OLD version first (`vite build --outDir /tmp/before-dist`; the new CLI shoots it), bump, build, read `basalt-ui doctor --from <old version>`, then `shot /a /b --dist /tmp/before-dist --out <app-dir>/.shots/before` and the same with `--dist dist --out <app-dir>/.shots/after` (`--out` inside the app dir; each route its own argument). `shot` finds `playwright` in any ancestor `node_modules`: `bun add --cwd "$(dirname "$PWD")" playwright` keeps it out of the repo's manifest. A locked or API-backed app shoots its lock screen on every route: serve fixtures on `127.0.0.1` and pass `--api /api=http://127.0.0.1:<port>` (read-only unless `--api-allow-writes`) plus `--local-storage key=@env:NAME`.

## Upgrade 1.x to 2.x

1. Be on `1.41.0` with its deprecations cleared and the gate green first (2.0 retires the deprecation lifecycle, so a consumer below 1.41 stalls on removed names). Then `bun add basalt-ui@latest`, the peers each imported subpath needs from its `Install:` line in `llms.txt` (exact pins: `bun add` accepts a mismatch silently, `doctor` `exact-peers` names it) and an `oxlint` the shipped preset supports; then `./node_modules/.bin/basalt-ui sync` (prunes retired managed files, rewrites the AGENTS.md block).
2. `./node_modules/.bin/basalt-ui doctor`; in a monorepo it targets the app package (`basalt.app` in the root `package.json` when two qualify). Fix each check: a tsconfig that does not extend the shipped base, retired `basalt/*` rule ids, dead `basalt` config keys, dropped subpaths.
3. Fix `tsc` in this order, because errors cascade: (a) specifier moves, mechanical, CSS imports included (`MIGRATING.md` § Subpaths, peers and gates; `basalt-ui/tokens.css` is gone and only `vite build` reports it: emit `basalt-ui tokens:css --out src/tokens.css` and import that file; a provider-free page also needs `basalt-ui fonts:css --out src/fonts.css`); (b) wiring: `createBasaltRouter` + `BasaltProvider` + `interface Register` (until `Register` exists every router and query-client use is `never`: dozens of unrelated errors); (c) removed root exports; (d) charts, one file at a time, not mechanical: hand-composed marks become `Lines`/`Bars`/`Sparkline`/`Heatmap` or `CartesianChart`.
4. Read what compiles clean but behaves differently (`MIGRATING.md` § Agent runtime: `runs.has(id)` no longer means live; § Table v9: closed sort registry, debounced search; § Transitions) and grep your code for each. Fix the preset's newly-`error` React rules (`react/refs`, `react/set-state-in-effect`, `react/immutability`, `react/globals`) at the source, never with a waiver. Then run the Verify steps above.

## Not a React app

1. `bunx basalt-ui tokens:css --out src/tokens.css` and `bunx basalt-ui fonts:css --out src/fonts.css`.
2. Set `"basalt": { "profile": "tokens-only" }` in `package.json` by hand.

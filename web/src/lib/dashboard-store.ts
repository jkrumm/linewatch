import { createSearchStore, field } from 'basalt-ui/router-tanstack'
import { createLocalStore } from 'basalt-ui/state'
import { RANGE_LABEL, RANGE_OPTIONS } from './range'

/**
 * Every piece of state the dashboard's own controls read or write, in one store.
 *
 * It replaces three lanes that used to be described separately — a `createSearchParamStore` for the
 * range, a Zod object for `minDuration`, and a `createPersistedState` for compact — and the win is
 * not the line count. Each lane declares, once, whether it belongs in the URL and whether it
 * survives a reload, and basalt resolves all three the same way: URL ⊳ localStorage ⊳ fallback.
 *
 * - **`range` stays in the URL.** `validateSearch` always returns a value, so every link to a
 *   reading still carries `?range=`; the localStorage lane sits UNDER the URL, so a bare `/` opens
 *   on the range this reader last chose. `?range=nonsense` falls back rather than throwing —
 *   `z.enum().default()` only defaulted an ABSENT key, so a hand-edited URL used to take the
 *   dashboard down.
 * - **`minDuration` is URL-only** (`persist: false`). It is a filter on the outage table, and a
 *   reader who narrowed one list once should not find every later visit narrowed; a link that
 *   states the filter is exactly the case that has to keep working. It could not ride the old store
 *   at all — that one was typed `T extends string` over a closed list, and this is an open numeric
 *   bound.
 * - **`compact` is local-only** (`url: false`). See its own docblock below.
 *
 * The storage layout resets once on this upgrade: `createSearchStore` keeps one entry per STORE,
 * where the deprecated pair kept one bare value per param (basalt-ui `MIGRATING.md` § Stores). So
 * the first load after deploy opens on `24h` in full view, whatever was persisted before.
 */
export const dashboard = createSearchStore({
  key: 'dashboard',
  fields: {
    // `field.range` and not `field.enum`, because `RangeFilter` is typed over a range field — its
    // `from`/`to` params ride along unused. The param name defaults to the field's own name, so
    // `?range=7d` deep links are unchanged.
    //
    // **`custom: false` is written out, and it is load-bearing at the TYPE level.** It defaults to
    // `false`, but a `field.range(…)` called INLINE inside `fields` re-infers its `const C extends
    // boolean` against `AnyField`'s widened `RangeField`, so `custom` comes out `boolean` and every
    // read of `search.range` widens to `RangeOption | 'custom'` — a value this store can never
    // hold. Stating it restores the inference site. (Hoisting the field to its own `const` fixes it
    // too; this is the smaller of the two.)
    range: field.range({ presets: RANGE_OPTIONS, fallback: '24h', custom: false }),
    minDuration: field.number({ fallback: 0, min: 0, int: true }, { persist: false }),
    /**
     * Compact mode: the dashboard with its supporting detail dropped, and every conclusion still on
     * screen.
     *
     * **What it hides, and the one rule it is written around.** This page's standing contract is
     * that a section's *evidence* may sit behind a named view switch but a *conclusion* never may —
     * every finding renders in the verdict band above the sections, unconditionally
     * (`components/dashboard-section.tsx`, and `routes/index.tsx`'s docblock). A "show me less"
     * control is exactly the shape that breaks that rule by accident, so the split is explicit
     * rather than left to whoever adds the next block:
     *
     * - **Hidden:** the per-section stat strips (`DashboardSection.meta`), the *informational*
     *   coverage rows (`CoverageCallout`'s `kind === 'info'` branch — "Coverage 100.0% — 2880 of
     *   2880 expected cycles recorded", which is the statement that nothing is wrong),
     *   `ServerChangeNote`, the routine verdict group, each section's heading row (title AND view
     *   switch — see below), and the Path & hardware section entirely.
     * - **Never hidden:** the status bar, the verdict band's critical and warn findings, the
     *   `warn`/`bad` coverage callouts, and the charts.
     *
     * **The heading row goes as a unit, and it has to.** basalt's `Section` draws its title and its
     * `tabs` in one header row whose height is set by the taller of the two — the switch. Hiding
     * the title alone therefore saves nothing at all; hiding the whole header saves the row, which
     * is why compact drops `Section` itself rather than passing it fewer props. The cost is real
     * and accepted: a reader in compact cannot reach a section's other views (the outage table,
     * per-target latency, the 30-day pattern). Compact is the mode for watching, not for reading
     * evidence, and the switch is one click away in the other mode.
     *
     * **Path & hardware is dropped whole** rather than reduced. It is the one section whose content
     * is reference — hardware that has not changed since the machine was plugged in — which is why
     * it is also the only `collapsible` one. It is also the reason `EvidenceLink` leaves compact
     * rather than merely scrolling.
     *
     * The routine group is the one judgement call in that list, and it is a judgement call, not an
     * oversight. `triageVerdicts` sorts findings into critical / warn / routine, and *routine*
     * means, by construction, the ones that need no action — the collapsed row says so in words
     * ("N routine findings — nothing to act on"). Dropping it in a mode the reader has explicitly
     * opted into is not hiding a conclusion that asks for something; a critical or warn finding is,
     * and neither is droppable here. If `triageVerdicts` ever starts routing an actionable finding
     * to `routine`, this is the second place that breaks.
     *
     * **Persisted, not in the URL** (`url: false`). The range and the outage filter are in the URL
     * because they change what the page *reports* and a link to a reading has to carry them.
     * Density changes what one reader wants to look at, and a URL that pins someone else's density
     * is a worse link, not a better one. Same reasoning basalt's `Section` fold already follows.
     */
    compact: field.boolean(false, { url: false }),
  },
}).labels({ range: RANGE_LABEL })

/**
 * One store per section, holding which view of its evidence is drawn.
 *
 * **`persist: false` on purpose, which in a local store is the in-memory lane** — shared across
 * every mount of the section for the session, gone on reload. That is the `useState` this replaces,
 * minus the part that made it wrong: a remount (a compact toggle, a query-key rotation that drops
 * the tree) no longer resets the view the reader chose. It deliberately does NOT persist, because
 * the page's one hard rule about views is that a verdict's "see the Uptime section ↓" link lands on
 * the PRIMARY view — and a view handed back from yesterday's localStorage is a link landing
 * somewhere the finding's numbers are not.
 *
 * Option labels are NOT declared here: they live beside the `render` thunks in `routes/index.tsx`
 * (`DashboardSection.views`), which is the one place a view's name and its content can be read
 * against each other. `DashboardSection` derives `ViewTabs`' options from that array.
 */
const viewLane = { persist: false } as const

export const uptimeViews = createLocalStore({
  key: 'section-uptime',
  fields: { view: field.enum(['timeline', 'outages', 'pattern'], 'timeline', viewLane) },
})

export const latencyViews = createLocalStore({
  key: 'section-latency',
  fields: { view: field.enum(['internet', 'per-anchor'], 'internet', viewLane) },
})

export const speedViews = createLocalStore({
  key: 'section-speed',
  fields: { view: field.enum(['runs', 'by-hour', 'under-load'], 'runs', viewLane) },
})

export const throughputViews = createLocalStore({
  key: 'section-throughput',
  fields: { view: field.enum(['volume'], 'volume', viewLane) },
})

export const pathViews = createLocalStore({
  key: 'section-path',
  fields: { view: field.enum(['vantage', 'link', 'transitions'], 'vantage', viewLane) },
})

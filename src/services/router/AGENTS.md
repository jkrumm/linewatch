# Router poller — Agent Instructions

Read this before changing anything under `src/services/router/`. The bearer rule and the
`LINEWATCH_ROUTER_WRITE` gate for the router routes are in [`src/AGENTS.md`](../../AGENTS.md).

- The router **poller** is read-only, and writes live in one place:
  `services/router/actions.ts`, off unless `LINEWATCH_ROUTER_WRITE=1`. A reboot
  reports **three** outcomes, not two: `executed` when the device acknowledged,
  `failed` when it rejected the operation (HTTP 200, `errorcode: 1` — the
  firmware validates the operation before acting, which is what makes a wrong
  name distinguishable from a successful reboot), and `unknown` when the
  transport died or the answer carried no readable errorcode, which is the
  expected signature of success and is settled only by the probe record. Never
  read `unknown` as either. Polls and both actions share one lock
  (`services/router/lock.ts`), and a failed reboot is a `note`, not an
  intervention. That
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
  must stay a missing sample, never a carried-forward reading. The one exception
  is **`pollWithRetry` in `services/router/scheduler.ts`**: a *scheduled* poll that
  stored no line reading (login failed, threw, or lost its first read) gets one more
  whole poll 30 s later — a new login, never the old session — because about one poll
  in four did exactly that (2026-11-15, 75% coverage against the 80% the watchdog
  needs). Two logins per cadence tick is the cap; `skipped` and the on-demand route
  never retry.

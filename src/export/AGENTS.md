# OTLP export and retention — Agent Instructions

Read this before changing `src/export/`, `src/services/retention.ts` or `scripts/otlp-backfill.ts`. What is exported and why:
[`docs/DESIGN.md`](../../docs/DESIGN.md) §Export and retention.

- **The export reads SQLite back; no write path calls it.** The probe ingest, the outage detector, the router poller and the
  speed-test runner know nothing of it, because the watchdog's API sits on those writes. Do not add an `export(...)` call
  next to an insert "to make it faster": a hook inside the ingest transaction exports rows that roll back and can fail the write.
- **The cursor moves only after the agent accepted the batch**, and lives in the `export_cursor` table so `make db-restore`
  rewinds it with the rows. Delivery is at-least-once; a stream's key is its `id`, except `outage_close`, which keys on `ended_at`
  because outages of different scopes close out of id order.
- **`start` splits the history between backfill and live tail.** Rows at or below it are the backfill's, above it the tail's.
  Never reset a cursor row to re-export: it duplicates gauge points in ClickHouse, which does not deduplicate them.
- **A null column emits no point, and a null attribute is absent.** `on_home_line` is three-state and null is unknown; a 0 or
  a `false` there is a claim. The same rule as `probe_cycle` in [`src/AGENTS.md`](../AGENTS.md).
- **No hostname, address or key in a point's attributes** (this repo is public and so is the schema mapping): `addr`,
  `gateway_addr`, `external_ip`, the SSID and any MAC stay out. A new attribute needs the same check.
- **Retention deletes only what is exported and only after every backfill finished**, in 5,000-row batches with a pause, never
  a VACUUM (it would hold the API's one connection). Its 30-day floor sits above the longest lookback anything automatic reads
  (the watchdog's 48 h arming window): re-check that list before lowering it.

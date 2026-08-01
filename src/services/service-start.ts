import { db } from '../db/client.js'
import { event } from '../db/schema.js'

/**
 * Records that this process started, as a `config_change` event.
 *
 * Container downtime is otherwise invisible in the schema, and it is not a
 * hypothetical gap: the 07:10 → 08:17 hole on 2026-08-01 is six missed router
 * polls over 67 minutes, almost certainly a `make up` rebuild — it ends in a
 * boot poll and lines up with a commit — but nothing in the record separates it
 * from 67 minutes of the router refusing to answer. Every coverage figure
 * computed from `router_line_sample` alone therefore blames the router for the
 * deploys, and understates coverage by an unknown amount.
 *
 * `config_change` rather than `note`: `docs/DESIGN.md` reserves this kind for
 * exactly this, and keeping it distinct means a coverage query can subtract
 * downtime windows without also matching poller telemetry.
 *
 * Deliberately not a `probe_sample` gap check or a shutdown hook. A process can
 * be killed without running one, so "started at T" is the only fact that is
 * always recordable; the window between two consecutive starts is what a reader
 * reconstructs from it.
 */
export function recordServiceStart(version: string): void {
  db.insert(event)
    .values({
      ts: Date.now(),
      kind: 'config_change',
      detail: JSON.stringify({
        source: 'service',
        reason: 'service_start',
        version,
        // Bun's own uptime at this point, so a crash-restart loop is legible as
        // one: several starts seconds apart with a tiny value here.
        processUptimeS: Math.round(process.uptime()),
      }),
    })
    .run()
}

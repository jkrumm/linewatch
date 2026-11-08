import { sql } from 'drizzle-orm'
import { db } from './client.js'
import { outageDetector } from '../services/outage-detector-instance.js'

/**
 * Empties the process-global database singleton and re-syncs the outage
 * detector to it. Test-only.
 *
 * `bun test` runs every file in one process, so the route tests that import
 * `db/client.ts` (`LINEWATCH_DB=:memory:`) share ONE database. Each such file
 * calls this in `beforeAll` and `afterAll`: it neither inherits rows from the
 * file before it nor leaves any for the file after it, so any file order passes.
 * Import it dynamically, after the file has set its environment — it pulls in
 * `db/client.ts`, which reads config at import time.
 */
export function resetSharedDb(): void {
  const tables = db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%drizzle%'`,
  )
  for (const { name } of tables) db.run(sql.raw(`DELETE FROM "${name}"`))
  outageDetector.load()
}

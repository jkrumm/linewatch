/**
 * Runs the retention pass once, now — the same code the daily job runs. Used to
 * apply a new window on demand (`make db-retain`); `make db-vacuum` then returns
 * the space. Refuses before the backfill has finished.
 */
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { runRetention } from '../src/services/retention.js'

const days = config.retentionDays
if (days === null) {
  console.error('LINEWATCH_RETENTION_DAYS is not set: pass it, e.g. LINEWATCH_RETENTION_DAYS=90')
  process.exit(2)
}
const result = await runRetention(db, { days })
console.log(JSON.stringify(result, null, 2))
process.exit(result.ran ? 0 : 1)

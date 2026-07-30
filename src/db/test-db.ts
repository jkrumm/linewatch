import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from './schema.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsFolder = join(moduleDir, '../../drizzle')

/**
 * Fresh in-memory database with the real migrations applied. Test-only —
 * exercises the actual `drizzle/` SQL rather than a hand-rolled schema copy,
 * so a test can never pass against a shape the real app doesn't have.
 */
export function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder })
  return db
}

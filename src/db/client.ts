import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import * as schema from './schema.js'

const dbDir = dirname(config.dbPath)
if (dbDir !== '.' && !existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true })
}

const sqlite = new Database(config.dbPath, { create: true })
// WAL lets the API (writer) and any concurrent read (e.g. a long bucketed
// query) proceed without blocking each other; busy_timeout absorbs the brief
// lock windows WAL still has instead of surfacing SQLITE_BUSY to a caller.
sqlite.exec('PRAGMA journal_mode = WAL')
sqlite.exec('PRAGMA busy_timeout = 5000')

export const db = drizzle(sqlite, { schema })

// Resolve the migrations folder relative to this source file so it works
// regardless of process cwd (native `bun run src/index.ts` vs the container's
// `/app` working directory).
const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsFolder = join(moduleDir, '../../drizzle')

export function runMigrations(): void {
  migrate(db, { migrationsFolder })
}

// Migrate at module load, not from an entrypoint statement. ES imports are
// evaluated before any statement in the importing module's body, so a
// `runMigrations()` call at the top of index.ts still runs *after* every
// transitively imported module — including ones that query at module scope
// (services/outage-detector-instance.ts). On a fresh database that ordering
// crashed the process with `no such table: outage`. Migrating here makes a
// migrated schema an invariant of importing the client at all.
runMigrations()

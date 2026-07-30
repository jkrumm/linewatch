import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import * as schema from './schema.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))

/**
 * `<repo>/data` is where docker-compose.yml mounts the `linewatch-data` volume,
 * so inside the container it *is* the database and outside it is a hole in the
 * ground. Derived from this file's own location rather than the process cwd, so
 * it holds for `bun run src/index.ts` from anywhere.
 */
const CONTAINER_OWNED_DIR = resolve(moduleDir, '../../data')

/**
 * Written by `make db-import` / `make up` into the now-vestigial host `./data`
 * directory. Redundant with the path check above for the standard layout, and
 * the only signal that survives if someone points `LINEWATCH_DB` at a copy of
 * that directory somewhere else.
 */
const MOVED_MARKER = 'MOVED-TO-DOCKER-VOLUME'

/** Raised when a host process tries to open the container-owned database. */
export class DatabaseOnVolumeError extends Error {}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * True for a process running inside a container. `LINEWATCH_DOCKER` is set by
 * docker-compose.yml; `/.dockerenv` is created by the daemon in every container
 * and is the fallback for a hand-run container that forgot the env var. Both are
 * false on the macOS host, which is the case that has to fail.
 */
function inContainer(): boolean {
  return Boolean(process.env['LINEWATCH_DOCKER']) || existsSync('/.dockerenv')
}

/**
 * Refuse a host-side open of the database that lives in the Docker volume.
 *
 * The volume exists because SQLite's fcntl locks do not propagate across the
 * macOS-host / Docker-VM boundary, which corrupted this database on 2026-07-30
 * (docs/storage.md). Removing the bind mount makes that race impossible — but it
 * does not make a host-side open *fail*: it makes it silently succeed against
 * nothing, creating a brand-new empty database while every write goes somewhere
 * the container will never read. Silent divergence is worse than a loud crash,
 * so turn it into a loud crash.
 *
 * The trigger is **the path, not a marker file**. An earlier version armed the
 * guard only when `data/MOVED-TO-DOCKER-VOLUME` existed — a gitignored file that
 * only `make db-import` ever wrote, and that db-import refuses to re-write once
 * the volume holds rows. A fresh clone (or `git clean -xdf`) of this repo against
 * a volume holding a year of history therefore disarmed the guard completely,
 * with no supported way to re-arm it. `<repo>/data` being container-owned is true
 * by construction instead: it is the mount point, so nothing has to remember
 * anything.
 *
 * No-ops inside the container, and no-ops for any path outside `<repo>/data`
 * that carries no marker — so tests (`:memory:` via db/test-db.ts, or a temp
 * path) and a native dev run against a scratch path are unaffected.
 */
function assertContainerOwned(dbPath: string): void {
  if (inContainer()) return
  const resolved = resolve(dbPath)
  const onVolumeMount = isInside(CONTAINER_OWNED_DIR, resolved)
  const marked = existsSync(join(dirname(resolved), MOVED_MARKER))
  if (!onVolumeMount && !marked) return
  throw new DatabaseOnVolumeError(
    [
      `Refusing to open ${resolved} from the host.`,
      '',
      "The database lives in the 'linewatch-data' Docker volume, mounted at",
      `${CONTAINER_OWNED_DIR} inside the container, so the host and the container can`,
      'never hold the same SQLite file open — that corrupted it on 2026-07-30',
      '(btreeInitPage error 11; 945 of ~1400 rows recovered).',
      'Opening it here would silently create a NEW empty database and write into nothing.',
      '',
      '  • Serve the real data:      make up   (then http://127.0.0.1:7731)',
      '  • Row counts (scriptable):  make db-counts',
      '  • Ad-hoc SQL:               make db-shell',
      '  • Verified snapshot:        make db-backup',
      '  • Native run for dev:       bun run dev   (throwaway DB in ./.dev-data)',
      '',
      'See docs/storage.md.',
    ].join('\n'),
  )
}

assertContainerOwned(config.dbPath)

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

import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import * as schema from './schema.js'
import { runHeavyRead, type WorkerRequest, type WorkerResponse } from './heavy-reads.js'

/**
 * The worker half of `heavy-read-client.ts`: one read-only connection, one read at a
 * time. Reads queue here instead of on the main thread's event loop.
 */
declare const self: Worker

let db: BunSQLiteDatabase<typeof schema> | null = null

function reply(message: WorkerResponse): void {
  self.postMessage(message)
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  if (message.type === 'init') {
    const sqlite = new Database(message.dbPath, { readonly: true })
    sqlite.exec('PRAGMA busy_timeout = 5000')
    db = drizzle(sqlite, { schema })
    return
  }
  try {
    if (db === null) throw new Error('heavy-read worker used before init')
    reply({ id: message.id, ok: true, value: runHeavyRead(db, message.name, message.params) })
  } catch (error) {
    reply({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

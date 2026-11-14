import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { config } from '../config.js'
import { db } from './client.js'
import type * as schema from './schema.js'
import {
  runHeavyRead,
  type HeavyReadName,
  type HeavyReadParams,
  type HeavyReadResult,
  type WorkerRequest,
  type WorkerResponse,
} from './heavy-reads.js'

/**
 * Main-thread side of the heavy-read worker (see `heavy-reads.ts` for why it exists).
 *
 * - One worker, lazily started, so reads queue *there* and the event loop stays free.
 * - Identical in-flight reads share one run: a dashboard refetch that lands while
 *   the same window is still being computed (two tabs, a retry) costs nothing extra.
 * - A worker that dies rejects what it held and is started afresh by the next read.
 * - `:memory:` (every route test) has no file for a second connection to open, so the
 *   read runs inline on the one connection there is.
 */

interface Pending {
  resolve: (value: never) => void
  reject: (error: Error) => void
}

export interface HeavyReader {
  read<K extends HeavyReadName>(name: K, params: HeavyReadParams<K>): Promise<HeavyReadResult<K>>
}

/**
 * `inline` runs reads on the given connection instead of a worker — for `:memory:`,
 * which a second connection cannot open (every route test).
 */
export function createHeavyReader(
  source: { dbPath: string } | { inline: BunSQLiteDatabase<typeof schema> },
): HeavyReader {
  // The pending reads belong to the worker that was sent them: a late 'close' from a
  // dead worker must not reject what its replacement is still computing.
  interface Slot {
    worker: Worker
    pending: Map<number, Pending>
  }
  let current: Slot | null = null
  let nextId = 1
  const inFlight = new Map<string, Promise<unknown>>()

  function startWorker(dbPath: string): Slot {
    const worker = new Worker(new URL('./heavy-read-worker.ts', import.meta.url).href)
    const slot: Slot = { worker, pending: new Map() }
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      const entry = slot.pending.get(message.id)
      if (!entry) return
      slot.pending.delete(message.id)
      if (message.ok) entry.resolve(message.value as never)
      else entry.reject(new Error(message.error))
    }
    const onDeath = (reason: string) => {
      if (current === slot) current = null
      const error = new Error(`heavy-read worker ${reason}`)
      for (const entry of slot.pending.values()) entry.reject(error)
      slot.pending.clear()
      worker.terminate()
    }
    worker.onerror = (event: ErrorEvent) => onDeath(`failed: ${event.message}`)
    worker.addEventListener('close', () => onDeath('closed'))
    const init: WorkerRequest = { type: 'init', dbPath }
    worker.postMessage(init)
    return slot
  }

  return {
    read<K extends HeavyReadName>(name: K, params: HeavyReadParams<K>) {
      if ('inline' in source) {
        try {
          return Promise.resolve(runHeavyRead(source.inline, name, params) as HeavyReadResult<K>)
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)))
        }
      }

      const key = `${name}:${JSON.stringify(params)}`
      const shared = inFlight.get(key)
      if (shared) return shared as Promise<HeavyReadResult<K>>

      const run = new Promise<HeavyReadResult<K>>((resolve, reject) => {
        const slot = (current ??= startWorker(source.dbPath))
        const id = nextId++
        slot.pending.set(id, { resolve, reject })
        const request: WorkerRequest = { type: 'read', id, name, params }
        slot.worker.postMessage(request)
      }).finally(() => inFlight.delete(key))
      inFlight.set(key, run)
      return run
    },
  }
}

const reader = createHeavyReader(
  config.dbPath === ':memory:' ? { inline: db } : { dbPath: config.dbPath },
)

export function heavyRead<K extends HeavyReadName>(
  name: K,
  params: HeavyReadParams<K>,
): Promise<HeavyReadResult<K>> {
  return reader.read(name, params)
}

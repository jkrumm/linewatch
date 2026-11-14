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
  let worker: Worker | null = null
  let nextId = 1
  const pending = new Map<number, Pending>()
  const inFlight = new Map<string, Promise<unknown>>()

  function failAll(error: Error): void {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  function startWorker(dbPath: string): Worker {
    const started = new Worker(new URL('./heavy-read-worker.ts', import.meta.url).href)
    started.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.ok) entry.resolve(message.value as never)
      else entry.reject(new Error(message.error))
    }
    const onDeath = (reason: string) => {
      if (worker === started) worker = null
      failAll(new Error(`heavy-read worker ${reason}`))
    }
    started.onerror = (event: ErrorEvent) => onDeath(`failed: ${event.message}`)
    started.addEventListener('close', () => onDeath('closed'))
    const init: WorkerRequest = { type: 'init', dbPath }
    started.postMessage(init)
    return started
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
        worker ??= startWorker(source.dbPath)
        const id = nextId++
        pending.set(id, { resolve, reject })
        const request: WorkerRequest = { type: 'read', id, name, params }
        worker.postMessage(request)
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

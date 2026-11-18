import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { Exporter } from './exporter.js'
import { OtlpHttpSink } from './otlp.js'
import type { Resource } from './otlp.js'
import type { MapContext } from './streams.js'

const TICK_MS = 15_000
/** After a refused batch, wait this many ticks (doubling) before trying again. */
const MAX_BACKOFF_TICKS = 8
/** A long outage of the agent logs on the first failure and then once per this many. */
const LOG_EVERY_FAILURES = 20

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Short git SHA of the running checkout, or `unknown` when git cannot say. */
function shortSha(): string {
  try {
    const out = Bun.spawnSync(['git', '-C', repoRoot, 'rev-parse', '--short', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const sha = out.stdout.toString().trim()
    return out.exitCode === 0 && sha !== '' ? sha : 'unknown'
  } catch {
    return 'unknown'
  }
}

function exportResource(): Resource {
  return {
    'service.name': 'linewatch-app',
    'service.namespace': 'linewatch',
    'service.version': shortSha(),
    'deployment.environment.name': config.deploymentEnv,
  }
}

const mapContext: MapContext = {
  // Name first, then address — the same order the ingest route resolves a scope in.
  scopeOf(target, addr) {
    const known =
      config.targets.find((t) => t.name === target) ?? config.targets.find((t) => t.addr === addr)
    return known?.scope ?? null
  },
}

/**
 * The exporter the app and the backfill script share, or null when no endpoint is
 * configured or the one given is not an http(s) URL. A bad value turns the export
 * off with a log line; it must never stop the API the watchdog depends on.
 */
export function createExporter(): Exporter | null {
  const endpoint = config.otlpEndpoint
  if (endpoint === null) return null
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http(s)')
  } catch {
    console.error('[otlp] LINEWATCH_OTLP_ENDPOINT is not an http(s) URL — export is off')
    return null
  }
  return new Exporter(db, new OtlpHttpSink(endpoint, exportResource()), mapContext)
}

/**
 * Starts the live tail. Returns the exporter and the stop function, or null when
 * the export is off — in which case nothing at all has run: no cursor row, no
 * timer, no request.
 */
export function startExport(): { exporter: Exporter; stop: () => void } | null {
  const exporter = createExporter()
  if (exporter === null) return null
  try {
    exporter.ensureCursors()
  } catch (error) {
    console.error(`[otlp] could not prepare the export cursors — export is off: ${String(error)}`)
    return null
  }

  let running = false
  let failures = 0
  let skip = 0
  const timer = setInterval(() => {
    if (running) return
    if (skip > 0) {
      skip -= 1
      return
    }
    running = true
    exporter
      .tick()
      .then((rows) => {
        if (failures > 0) {
          console.log(`[otlp] export recovered after ${failures} failed passes; ${rows} rows sent`)
        }
        failures = 0
      })
      .catch((error: unknown) => {
        failures += 1
        skip = Math.min(2 ** (failures - 1), MAX_BACKOFF_TICKS)
        if (failures === 1 || failures % LOG_EVERY_FAILURES === 0) {
          // Nothing is dropped: the cursor did not move, so the rows are re-read.
          console.error(
            `[otlp] export refused (${failures} in a row), rows stay in SQLite and are retried: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
      .finally(() => {
        running = false
      })
  }, TICK_MS)
  console.log('[otlp] export on')
  return { exporter, stop: () => clearInterval(timer) }
}

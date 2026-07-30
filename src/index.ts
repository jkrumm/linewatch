import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Elysia } from 'elysia'
import { z } from 'zod'
import { openapi } from '@elysiajs/openapi'
import { config } from './config.js'
// Importing the db client migrates the schema (see db/client.ts) — nothing to
// call here, and nothing that may be called later.
import './db/client.js'
import { healthRoute } from './routes/health.js'
import { probesRoutes } from './routes/probes.js'
import { statusRoute } from './routes/status.js'
import { outagesRoutes } from './routes/outages.js'
import { speedtestsRoutes } from './routes/speedtests.js'
import { eventsRoutes } from './routes/events.js'
import { startSpeedtestScheduler } from './services/speedtest-runner.js'

// Resolved against this source file, not the process cwd, so it works both for
// `bun run src/index.ts` from the repo root and for the container's /app.
const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../web/dist')
const INDEX_HTML = join(WEB_DIST, 'index.html')

/** Whether the last path segment carries an extension, i.e. names a file rather than a view. */
function namesAFile(path: string): boolean {
  return path.slice(path.lastIndexOf('/') + 1).includes('.')
}

/** The file this path maps to inside web/dist, or null if there isn't one. */
async function openDistFile(path: string) {
  const candidate = resolve(join(WEB_DIST, path))
  // A request for /../../etc/passwd must not escape the dist directory.
  const insideDist = candidate === WEB_DIST || candidate.startsWith(WEB_DIST + sep)
  if (!insideDist || candidate === WEB_DIST) return null
  const file = Bun.file(candidate)
  return (await file.exists()) ? file : null
}

export const app = new Elysia()
  .use(
    openapi({
      mapJsonSchema: { zod: z.toJSONSchema },
      documentation: {
        info: {
          title: 'linewatch',
          version: '0.1.0',
          description:
            'Historical record of one internet connection: uptime, outage duration, and throughput. ' +
            '30-second ping cycles feed an outage state machine; hourly Ookla runs measure throughput ' +
            'and loaded (bufferbloat) latency. Reads are open; `POST /api/probes` and ' +
            '`POST /api/speedtests/run` require `Authorization: Bearer <token>`.',
        },
        components: {
          securitySchemes: {
            BearerAuth: { type: 'http', scheme: 'bearer' },
          },
        },
        tags: [
          { name: 'Probes', description: 'Ping-cycle ingest and the bucketed latency timeseries.' },
          { name: 'Outages', description: 'Materialised outage history.' },
          { name: 'Speed Tests', description: 'Hourly Ookla throughput + loaded-latency runs.' },
          { name: 'Events', description: 'Timeline overlay (interventions, link/config changes, notes).' },
          { name: 'Status', description: 'Current line status in one call.' },
          { name: 'System', description: 'Health and discovery.' },
        ],
      },
    }),
  )
  .onError(({ error }) => {
    console.error('[error]', error)
  })
  .use(healthRoute)
  .use(probesRoutes)
  .use(statusRoute)
  .use(outagesRoutes)
  .use(speedtestsRoutes)
  .use(eventsRoutes)
  // Serves the built dashboard: a real file when the path maps to one, and
  // index.html only for paths shaped like a client-side route. Registered last,
  // so every API route above still wins.
  //
  // The blanket fallback this replaced answered *every* unmatched path with
  // index.html and a 200 — first via @elysiajs/static with `prefix: ''`, then
  // via a hand-rolled version of the same mistake. A browser holding a cached
  // index.html then requests the previous build's hashed asset, receives HTML
  // with `content-type: text/html`, loads it as JavaScript, and renders a blank
  // dashboard with a clean 200 and nothing in the log. Only the content type
  // gives it away, so a miss must be a 404 instead: under /assets/ it is always
  // a deploy bug (stale index.html vs a renamed chunk) and it has to be loud.
  .get(
    '*',
    async ({ path, status }) => {
      // Routes above are `.use()`d first, so only genuinely unclaimed /api/
      // paths get here. Answer them in the shape an API client parses.
      if (path === '/api' || path.startsWith('/api/')) {
        return status(404, { error: 'Not Found', path })
      }

      const file = await openDistFile(path)
      if (file) return file

      // A request that names a file — a hashed chunk, a stylesheet, a font,
      // /favicon.ico — asked for that file, not for a page.
      if (path.startsWith('/assets/') || namesAFile(path)) {
        return status(404, 'Not Found')
      }

      // Extensionless: a client-side deep link such as /uptime or /latency.
      return Bun.file(INDEX_HTML)
    },
    { detail: { hide: true } },
  )
  .listen({ port: config.port })

startSpeedtestScheduler()

// eslint-disable-next-line no-console
console.log(`linewatch running on port ${config.port}`)

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
  // index.html otherwise so client-side deep links like /uptime resolve.
  // Registered last, so every API route above still wins.
  //
  // This replaced @elysiajs/static, which with `prefix: ''` matched nothing —
  // every asset fell through to the SPA fallback and was served as index.html
  // with `content-type: text/html`, so the browser loaded HTML as JavaScript
  // and rendered a blank page. It typechecks and returns 200 either way; only
  // the content type gives it away.
  .get(
    '*',
    async ({ path }) => {
      const candidate = resolve(join(WEB_DIST, path))
      // A request for /../../etc/passwd must not escape the dist directory.
      const insideDist = candidate === WEB_DIST || candidate.startsWith(WEB_DIST + sep)
      if (insideDist && candidate !== WEB_DIST) {
        const file = Bun.file(candidate)
        if (await file.exists()) return file
      }
      return Bun.file(INDEX_HTML)
    },
    { detail: { hide: true } },
  )
  .listen({ port: config.port })

startSpeedtestScheduler()

// eslint-disable-next-line no-console
console.log(`linewatch running on port ${config.port}`)

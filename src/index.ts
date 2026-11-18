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
import { interventionsRoutes } from './routes/interventions.js'
import { routerRoutes } from './routes/router.js'
import { routerActionRoutes } from './routes/router-actions.js'
import { startSpeedtestScheduler } from './services/speedtest-runner.js'
import { startRouterPoller } from './services/router/scheduler.js'
import { recordServiceStart } from './services/service-start.js'
import { startExport } from './export/index.js'
import { startRetention } from './services/retention.js'

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
            'and loaded (bufferbloat) latency. Reads are open on the tailnet. `Authorization: Bearer ' +
            '<token>` is required by the five routes that write to the historical record or act on the line — ' +
            '`POST /api/probes`, `POST /api/interventions`, `POST /api/router/poll`, ' +
            '`POST /api/router/actions/reconnect` and `POST /api/router/actions/reboot` — the last two of which also need ' +
            '`LINEWATCH_ROUTER_WRITE=1`, an independent switch that is off by default.',
        },
        components: {
          securitySchemes: {
            BearerAuth: { type: 'http', scheme: 'bearer' },
          },
        },
        tags: [
          { name: 'Probes', description: 'Ping-cycle ingest.' },
          { name: 'Outages', description: 'Materialised outage history.' },
          { name: 'Speed Tests', description: 'Hourly Ookla throughput + loaded-latency runs.' },
          {
            name: 'Events',
            description: 'Timeline overlay (interventions, link/config changes, notes).',
          },
          {
            name: 'Router',
            description:
              'Carrier-side line health and per-interface throughput, polled read-only from the router.',
          },
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
  .use(interventionsRoutes)
  .use(routerRoutes)
  .use(routerActionRoutes)
  .listen({ hostname: config.host, port: config.port })

// Written before the schedulers, so a start that crashes on the way up is still
// on record as a start — which is the shape a restart loop has.
recordServiceStart('0.1.0')

startSpeedtestScheduler()
// Read-only 10-minute router poll. Returns null (and says why) when no router
// password is configured — the API must serve with or without it.
startRouterPoller()
// Off unless LINEWATCH_OTLP_ENDPOINT is set. Reads SQLite back rather than hooking
// the writers, so nothing it does can fail or slow a write (src/export/).
startExport()
// Off unless LINEWATCH_RETENTION_DAYS is set; refuses until the backfill is done.
startRetention()

// eslint-disable-next-line no-console
console.log(`linewatch running on port ${config.port}`)

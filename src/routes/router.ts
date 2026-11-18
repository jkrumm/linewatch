import { Elysia } from 'elysia'
import { z } from 'zod'
import { db } from '../db/client.js'
import { readRouterSnapshot } from '../services/router/poll.js'
import { resolveCollectorHostIp } from '../services/router/collector-address.js'
import { routerConfig } from '../services/router/config.js'
import { getRouterExecutor } from '../services/router/scheduler.js'

/**
 * Router reads. Open like every other read route.
 *
 * These rows are the carrier-side counterpart to the host-side probe record:
 * sync rate is the ceiling the probes live under, noise margin is the early
 * warning, and the per-interface rates show household load without generating
 * any. Nothing here can be written through this API — the poller is read-only
 * against the router and these routes are read-only against its record.
 *
 * One property is load-bearing and easy to lose:
 *
 * 1. `GET /api/router` never presents a stored reading as a current one. Each
 *    part carries its own `observedAt`/`ageMs`/`stale`, because during a WAN
 *    outage the LAN half keeps updating while the WAN half stops, and the
 *    difference is invisible without it.
 */

const ObservationMeta = {
  observedAt: z.number().int().describe('Unix ms of the poll that produced this value'),
  ageMs: z.number().int().describe('Age of the value when the snapshot was taken'),
  stale: z
    .boolean()
    .describe('True when ageMs exceeds staleAfterMs — the value is history, not a current reading'),
}

/** Wraps a value in the observation envelope every part of `GET /api/router` carries. */
function observation<T extends z.ZodTypeAny>(value: T) {
  return z.object({ ...ObservationMeta, value })
}

const LineSampleSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  carrier: z.enum(['gfast', 'dsl', 'gpon']).nullable(),
  status: z.string().nullable(),
  downSyncKbps: z.number().int().nullable(),
  upSyncKbps: z.number().int().nullable(),
  downCurrKbps: z.number().int().nullable(),
  upCurrKbps: z.number().int().nullable(),
  downNoiseMarginDb: z.number().nullable(),
  upNoiseMarginDb: z.number().nullable(),
  downAttenuationDb: z.number().nullable(),
  profile: z.string().nullable(),
  showtimeStartS: z.number().int().nullable(),
  erroredSecs: z.number().int().nullable(),
  severelyErroredSecs: z.number().int().nullable(),
})

/**
 * The WAN connection as the router describes it. Read `connStatusV4` on a
 * DS-Lite line as a constant, not a signal: `connIpv4Enabled` is 0 there and
 * IPv4 rides the softwire, so it says `Connecting` in health and in failure
 * alike and `uptimeV4S` is pinned at 0. `connStatusV6` and `uptimeV6S` are the
 * live pair, and a drop in `uptimeV6S` between polls is the session having been
 * re-established — surfaced as a `link_change` event, not derived here.
 */
const WanSampleSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  connName: z.string().nullable(),
  ifName: z.string().nullable(),
  connType: z.string().nullable(),
  accessMode: z.string().nullable(),
  stack: z
    .string()
    .nullable()
    .describe(
      "The connection's own stack, which is not the interface's — evidence, never the source for a write",
    ),
  connStatusV4: z.string().nullable(),
  connStatusV6: z.string().nullable(),
  connIpv4Enabled: z.number().int().nullable(),
  connIpv6Enabled: z.number().int().nullable(),
  dsliteEnabled: z.number().int().nullable(),
  uptimeV4S: z.number().int().nullable(),
  uptimeV6S: z.number().int().nullable(),
  lastConnError: z.string().nullable(),
  selectedBy: z
    .enum(['status', 'continuity'])
    .nullable()
    .describe(
      '`continuity` means the router reported every connection disconnected and this is the one that was live at the previous poll — it did not vouch for this row',
    ),
})

const IntfSampleSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  name: z.string(),
  stack: z.number().int().nullable(),
  role: z.enum(['wan', 'lan', 'other']).nullable(),
  rxKbps: z.number().int().nullable(),
  txKbps: z.number().int().nullable(),
  bytesRx: z.number().int().nullable(),
  bytesTx: z.number().int().nullable(),
})

const EthPortSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  name: z.string().nullable(),
  alias: z.string().nullable(),
  status: z.string().nullable(),
  maxBitRate: z.number().int().nullable(),
  duplexMode: z.string().nullable(),
})

/**
 * The router's side of the collector host. No device name: `router_host` stores
 * none, because this router's vendor-default names are MACs with the separators
 * stripped. Nothing is lost here — the row is looked up by `collectorHostIp`, so
 * the name was never what identified it, and what the route is actually asked is
 * whether the router still sees this address attached, over which medium, and
 * how old that reading is.
 */
const HostSchema = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  ip: z.string().nullable(),
  interfaceType: z.string().nullable(),
  active: z.number().int().nullable(),
  clientType: z.string().nullable(),
})

export const routerRoutes = new Elysia().get(
  '/api/router',
  () => {
    const collectorHostIp = resolveCollectorHostIp({
      db,
      override: routerConfig.collectorHostIpOverride,
    })
    const snapshot = readRouterSnapshot(db, {
      collectorHostIp,
      staleAfterMs: routerConfig.staleAfterMs,
    })
    return {
      pollerEnabled: routerConfig.enabled,
      writeEnabled: getRouterExecutor().capability === 'live',
      disabledReason: routerConfig.disabledReason,
      configWarning: routerConfig.configWarning,
      collectorHostIp,
      pollIntervalMs: routerConfig.pollIntervalMs,
      now: snapshot.now,
      staleAfterMs: snapshot.staleAfterMs,
      line: snapshot.line,
      wanConnection: snapshot.wanConnection,
      wan: snapshot.wan,
      lan: snapshot.lan,
      collectorHost: snapshot.collector,
      ports: snapshot.ports,
    }
  },
  {
    response: z.object({
      pollerEnabled: z.boolean(),
      writeEnabled: z
        .boolean()
        .describe(
          'Whether this process\'s executor is live, i.e. `LINEWATCH_ROUTER_WRITE=1`, a password *and* a running poller — whether the two action routes would do anything. Exposed so an automated caller can report "would reconnect, suppressed" truthfully rather than inferring the container\'s capability from its own environment — the watchdog runs natively under launchd and the executor lives in Docker, so the two configurations are genuinely separate.',
        ),
      disabledReason: z.string().nullable(),
      configWarning: z.string().nullable(),
      collectorHostIp: z.string().nullable(),
      pollIntervalMs: z.number().int(),
      now: z.number().int(),
      staleAfterMs: z.number().int(),
      line: observation(LineSampleSchema).nullable(),
      wanConnection: observation(WanSampleSchema).nullable(),
      wan: observation(IntfSampleSchema).nullable(),
      lan: observation(IntfSampleSchema).nullable(),
      collectorHost: observation(HostSchema).nullable(),
      ports: observation(z.array(EthPortSchema)).nullable(),
    }),
    detail: {
      tags: ['Router'],
      summary: 'Latest router reading',
      description:
        'Most recent carrier-side line sample, WAN/LAN throughput, the router-side view of the collector host — presence, medium and activity for `collectorHostIp`, with no device name, which this repo does not store — and every LAN port from the latest poll. Each part comes from its own latest row and carries its own `observedAt`/`ageMs`/`stale`: a poll where one OID was refused writes some tables and not others, `wanConnection` is the WAN session (established, for how long, last dial error); `wan` is throughput on the interface under it, and the two fail independently. `stale: true` means the value is older than `staleAfterMs` (two poll intervals) and describes the past, not now — it is never silently substituted for a current reading. Disagreements between this and the host-side `probe_cycle` vantage are materialised into `GET /api/events` as `link_change` at poll time, not recomputed here.',
    },
  },
)

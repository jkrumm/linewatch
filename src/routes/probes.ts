import { Elysia } from 'elysia'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { bucketProbes, bucketVantage } from '../db/bucket-probes.js'
import { db } from '../db/client.js'
import { event, probeSample, wifiSample } from '../db/schema.js'
import { config } from '../config.js'
import { hasValidBearer } from '../lib/auth.js'
import { outageDetector } from '../services/outage-detector-instance.js'
import type { TargetCycleResult } from '../services/outage-detector.js'
import { recordCycleVantage } from '../services/cycle-vantage.js'

const SampleInput = z.object({
  target: z.string(),
  addr: z.string(),
  sent: z.number().int(),
  received: z.number().int(),
  lossPct: z.number(),
  minMs: z.number().nullable(),
  medMs: z.number().nullable(),
  maxMs: z.number().nullable(),
  avgMs: z.number().nullable(),
  jitterMs: z.number().nullable(),
  samples: z.array(z.number()).nullable().optional(),
  // Optional, not required: the native collector and the container deploy
  // independently, and collector/spool.jsonl can hold batches written before
  // these fields existed. A required field here would reject that replay and
  // lose real measurements — the exact hole the spool exists to prevent.
  duplicates: z.number().int().min(0).optional(),
  outOfWaitTime: z.number().int().min(0).optional(),
})

/**
 * What the cycle measured *through* — one per batch, not per sample, because the
 * vantage is a property of the cycle (see the `probe_cycle` doc comment).
 *
 * Optional for the same reason every field inside it is nullable: a collector
 * predating the vantage, or a spooled batch written by one, must still ingest.
 * An absent `cycle` writes no `probe_cycle` row at all, which reads downstream
 * as "unknown" — never as "the home line over Ethernet".
 */
const CycleInput = z.object({
  pathIf: z.string().nullable().optional(),
  pathClass: z.enum(['ethernet', 'wifi', 'cellular', 'other']).nullable().optional(),
  linkMedia: z.string().nullable().optional(),
  linkMbit: z.number().int().nullable().optional(),
  linkDuplex: z.enum(['full', 'half']).nullable().optional(),
  gatewayAddr: z.string().nullable().optional(),
  ifIerrs: z.number().int().min(0).nullable().optional(),
  ifOerrs: z.number().int().min(0).nullable().optional(),
  ifColl: z.number().int().min(0).nullable().optional(),
  // Cumulative, so they exceed 2^32 on a busy link within days — `min(0)` is the
  // only bound that belongs here. A ceiling would start rejecting real cycles
  // silently, and the differencing already refuses a counter that went backwards.
  ifIbytes: z.number().int().min(0).nullable().optional(),
  ifObytes: z.number().int().min(0).nullable().optional(),
  // The collector's own verdict. Accepted as 0/1 (what collector/vantage.ts
  // sends, mirroring the SQLite column) or as a boolean, because rejecting one
  // spelling of a field that is *optional anyway* would fail the whole batch and
  // lose four real probe samples over a formatting disagreement.
  //
  // The server re-derives the verdict from pathClass + gatewayAddr whenever both
  // are present and takes the stricter of the two — "which gateway is home" is
  // server config, so the server gets the last word.
  onHomeLine: z.union([z.boolean(), z.literal(0), z.literal(1)]).nullable().optional(),
  // The NIC's ceiling from its supported-media list, which is what makes a
  // 100 Mbit `linkMbit` actionable: supported 1000 means cable or switch port,
  // supported 100 means the hardware. Null when the collector could not read it.
  linkMaxMbit: z.number().int().nullable().optional(),
  // DHCP lease start on `pathIf`, unix ms. A change dates a re-bind; an
  // unchanged value says nothing about link stability.
  dhcpBoundAt: z.number().int().nullable().optional(),
  // Seconds of 1 Hz link sampling behind this cycle. Null means the collector
  // had no sampler — link state unknown for the cycle, never "stable".
  linkWatchS: z.number().int().nullable().optional(),
})

/**
 * One sub-cycle link transition seen by the collector's 1 Hz sampler
 * (collector/link-sampler.ts). `ts` is when the sampler saw it, not the cycle's
 * timestamp — that resolution is the whole point of the sampler.
 */
const LinkEventInput = z.object({
  ts: z.number().int(),
  state: z.enum(['up', 'down']),
})

/**
 * The Wi-Fi radio sample (collector/wifi.ts), carried on every 10th cycle — the
 * cadence `system_profiler`'s 4.8 s cost forces.
 *
 * Every field nullable *and* optional, like `CycleInput` and for the same
 * reason plus one of its own: this OS surface has already churned once
 * (`airport` removed, `wdutil` now sudo-only), so the collector's parser
 * degrades to nulls and the server must store that rather than reject it.
 *
 * The absent fields are the point. There is no `ssid`, `bssid`, `mac`,
 * `security` or `country_code` here and there must never be — see the
 * `wifiSample` doc comment.
 */
const WifiInput = z.object({
  iface: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  phyMode: z.string().nullable().optional(),
  channel: z.number().int().nullable().optional(),
  band: z.string().nullable().optional(),
  widthMhz: z.number().int().nullable().optional(),
  rssiDbm: z.number().int().nullable().optional(),
  noiseDbm: z.number().int().nullable().optional(),
  // The negotiated PHY/MCS rate, never throughput.
  txRateMbps: z.number().nullable().optional(),
  mcsIndex: z.number().int().nullable().optional(),
  // From a ping bound to `iface`. Null with `lossPct: 100` is the honest shape
  // of a radio that is associated but reaching nothing.
  rttMedMs: z.number().nullable().optional(),
  lossPct: z.number().nullable().optional(),
})

const IngestBody = z.object({
  ts: z.number().int(),
  samples: z.array(SampleInput).min(1),
  cycle: CycleInput.optional(),
  // Optional: a collector without a sampler sends nothing here, and an absent
  // array means "not watched", never "no transitions". `cycle.linkWatchS` is
  // the field that says how much of the cycle was actually watched.
  //
  // Capped rather than unbounded because this route is the one that can forge
  // the historical record; 120 is four times what a 30 s cycle at 1 Hz can
  // produce, and the collector caps at the same number so a flap storm truncates
  // there instead of 422ing a batch that also carries four real probe samples.
  linkEvents: z.array(LinkEventInput).max(120).optional(),
  // Optional: present on one cycle in ten, and absent from every cycle a
  // collector without the sampler sends. Absent means "this cycle did not look
  // at the radio", never "there is no radio".
  wifi: WifiInput.optional(),
})

const HomeLineVerdictSchema = z
  .enum(['all', 'none', 'mixed', 'unknown'])
  .describe(
    'all = every recorded cycle in the bucket reported on_home_line=1; none = every cycle reported 0; unknown = no cycle reported it; mixed = anything else, including unreported cycles alongside reported ones. Only `all` claims the whole bucket — never treat `unknown` as `all`.',
  )

const VantageBucketSchema = z.object({
  bucket: z.number().int(),
  cycles: z.number().int().describe('Distinct cycle timestamps with probe samples in this bucket'),
  vantageCycles: z.number().int().describe('…of which this many recorded a vantage at all'),
  pathClasses: z.array(z.string()).describe('Distinct path classes seen — more than one means the path changed mid-bucket'),
  linkMbits: z.array(z.number().int()).describe('Distinct negotiated link speeds seen — more than one means the NIC renegotiated'),
  pathIfs: z.array(z.string()),
  onHomeLine: HomeLineVerdictSchema,
  homeLineCycles: z.number().int(),
  offHomeLineCycles: z.number().int(),
  unknownHomeLineCycles: z.number().int(),
})

const ProbeBucketSchema = z.object({
  bucket: z.number().int(),
  target: z.string(),
  medianMs: z.number().nullable(),
  p5Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  minMs: z.number().nullable(),
  maxMs: z.number().nullable(),
  maxLossPct: z.number(),
  lossPct: z.number(),
  downCycles: z.number().int(),
  count: z.number().int(),
})

/**
 * Materialise the sampler's transitions as `link_change` events — written on
 * ingest like the vantage diff and the outage machine, never derived on read.
 *
 * Idempotency has to be explicit here. `event.ts` carries no unique index and
 * **must not gain one**: `intervention` rows legitimately share a timestamp.
 * The `skipped: true` branch already absorbs the ordinary spool replay (same
 * `ts`, same batch); this guard covers the rest — two batches whose sampling
 * windows overlap, or a replay whose probe samples were lost.
 *
 * Returns how many rows were actually written.
 */
function recordLinkTransitions(transitions: { ts: number; state: 'up' | 'down' }[], iface: string | null): number {
  let written = 0
  for (const transition of transitions) {
    const existing = db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.ts, transition.ts), eq(event.kind, 'link_change')))
      .limit(1)
      .all()
    if (existing.length > 0) continue

    // `iface` comes from the cycle's `pathIf`, so it is null when the collector
    // reported no default route — which is exactly the link-down case. Naming a
    // plausible interface there would attribute the transition to hardware
    // nobody looked at.
    const detail = { source: 'link-sampler', state: transition.state, iface }
    db.insert(event).values({ ts: transition.ts, kind: 'link_change', detail: JSON.stringify(detail) }).run()
    written += 1
  }
  return written
}

/**
 * Store the cycle's Wi-Fi sample. `onConflictDoNothing` on the UNIQUE `ts` is
 * what makes a spool replay idempotent — the `skipped: true` branch above
 * already absorbs the ordinary replay, this covers the rest (a replay whose
 * probe samples were lost, two batches sharing a timestamp).
 *
 * Every field is written explicitly as `?? null`: an absent key and a null one
 * mean exactly the same thing here — not measured — and a row of nulls is a
 * real finding ("we looked at the radio and learned nothing"), not a reason to
 * skip the write.
 */
function recordWifiSample(ts: number, wifi: z.infer<typeof WifiInput>): void {
  db.insert(wifiSample)
    .values({
      ts,
      iface: wifi.iface ?? null,
      status: wifi.status ?? null,
      phyMode: wifi.phyMode ?? null,
      channel: wifi.channel ?? null,
      band: wifi.band ?? null,
      widthMhz: wifi.widthMhz ?? null,
      rssiDbm: wifi.rssiDbm ?? null,
      noiseDbm: wifi.noiseDbm ?? null,
      txRateMbps: wifi.txRateMbps ?? null,
      mcsIndex: wifi.mcsIndex ?? null,
      rttMedMs: wifi.rttMedMs ?? null,
      lossPct: wifi.lossPct ?? null,
    })
    .onConflictDoNothing()
    .run()
}

export const probesRoutes = new Elysia()
  .post(
    '/api/probes',
    ({ body, headers, status }) => {
      if (!hasValidBearer(headers)) return status(401, 'Unauthorized')

      // Idempotency: a spool replay resends an already-ingested cycle
      // verbatim. One POST is always exactly one cycle (one `ts`, every
      // target) — see collector/probe.ts — so "a row for this ts already
      // exists" means the whole batch was already recorded.
      const existing = db.select({ id: probeSample.id }).from(probeSample).where(eq(probeSample.ts, body.ts)).limit(1).all()
      if (existing.length > 0) {
        // `cycleStored: false` with `skipped: true` is the correct outcome, not
        // a warning: the vantage for this ts was stored the first time round.
        return { ok: true as const, inserted: 0, skipped: true, linkChange: false, cycleStored: false }
      }

      db.insert(probeSample)
        .values(
          body.samples.map((sample) => ({
            ts: body.ts,
            target: sample.target,
            addr: sample.addr,
            sent: sample.sent,
            received: sample.received,
            lossPct: sample.lossPct,
            minMs: sample.minMs,
            medMs: sample.medMs,
            maxMs: sample.maxMs,
            avgMs: sample.avgMs,
            jitterMs: sample.jitterMs,
            samples: sample.samples ? JSON.stringify(sample.samples) : null,
            duplicates: sample.duplicates ?? null,
            outOfWaitTime: sample.outOfWaitTime ?? null,
          })),
        )
        .run()

      // Written before the outage machine runs so that if a link_change and an
      // outage land on the same cycle, the timeline already carries the cause.
      const cycle = body.cycle
        ? recordCycleVantage(db, { ts: body.ts, vantage: body.cycle, homeGatewayAddr: config.homeGatewayAddr })
        : { inserted: false, linkChangeEventId: null }

      // Same reasoning as the vantage above: written before the outage machine
      // runs, so a link transition inside an outage is already on the timeline
      // when the outage lands. Nothing here is reached on a replay — the
      // `skipped: true` branch returned long before.
      const linkEventsWritten = body.linkEvents ? recordLinkTransitions(body.linkEvents, body.cycle?.pathIf ?? null) : 0

      // One cycle in ten carries this; the rest carry nothing and that is not a
      // gap in the radio's history, it is the sampling cadence.
      if (body.wifi) recordWifiSample(body.ts, body.wifi)

      const cycleResults: TargetCycleResult[] = body.samples.map((sample) => ({
        target: sample.target,
        scope: config.targets.find((t) => t.name === sample.target)?.scope ?? 'wan',
        down: sample.received === 0,
      }))
      outageDetector.ingest(body.ts, cycleResults)

      return {
        ok: true as const,
        inserted: body.samples.length,
        skipped: false,
        linkChange: cycle.linkChangeEventId !== null || linkEventsWritten > 0,
        cycleStored: cycle.inserted,
      }
    },
    {
      body: IngestBody,
      response: {
        200: z.object({
          ok: z.literal(true),
          inserted: z.number().int(),
          skipped: z.boolean(),
          linkChange: z
            .boolean()
            .describe(
              'true when this batch materialised a `link_change` event — either from the 30 s vantage diff or from a sub-cycle transition the collector\'s 1 Hz sampler reported in `linkEvents`.',
            ),
          cycleStored: z
            .boolean()
            .describe(
              'true when this batch carried a `cycle` object AND a probe_cycle row was written for it. false with a cycle present means the server dropped it — the collector is ahead of the API. `skipped: true` reports false too: that vantage was stored on the original ingest, so a spool replay finding false there is correct, not a warning.',
            ),
        }),
        401: z.string(),
      },
      detail: {
        tags: ['Probes'],
        summary: 'Ingest one probe cycle',
        description:
          'Batch ingest from the native collector: one cycle timestamp plus one sample per target, plus an optional `cycle` object recording what the cycle measured *through* (interface, path class, negotiated link, the NIC ceiling, gateway, DHCP lease start, NIC error counters). Idempotent — replaying an already-ingested `ts` is a no-op (`skipped: true`), and `probe_cycle.ts` is UNIQUE so a replayed vantage cannot duplicate either. `cycleStored` reports whether the vantage actually landed: an API predating a `cycle` field parses the batch leniently, drops what it does not know and still answers 200, which once discarded 106 consecutive real vantages while every POST looked healthy. Feeds the outage state machine and materialises `link_change` events — both from the 30 s vantage diff and from the optional `linkEvents` array, the sub-cycle transitions the collector\'s 1 Hz link sampler observed during the cycle. An absent or empty `linkEvents` means no transition longer than that sampling resolution was seen, never that the link was stable; `cycle.linkWatchS` is what says how much of the cycle was watched at all. The optional `wifi` object is the radio state of an alternate radio path currently attached, sampled every 10th cycle (5 min) because `system_profiler` costs ~4.8 s — it is written to `wifi_sample` with `onConflictDoNothing` on its UNIQUE `ts`, and it deliberately carries no SSID, BSSID or MAC.',
        security: [{ BearerAuth: [] }],
      },
    },
  )
  .get(
    '/api/probes',
    ({ query }) => {
      const params = {
        from: query.from,
        to: query.to,
        bucketSeconds: query.bucket,
        ...(query.target !== undefined ? { target: query.target } : {}),
      }
      return {
        buckets: bucketProbes(db, params),
        // Separate series, one row per bucket: the vantage belongs to the cycle,
        // so folding it into `buckets` would repeat it once per target.
        vantage: bucketVantage(db, params),
      }
    },
    {
      query: z.object({
        from: z.coerce.number().int(),
        to: z.coerce.number().int(),
        target: z.string().optional(),
        bucket: z.coerce.number().int().min(1).default(3600),
      }),
      response: z.object({ buckets: z.array(ProbeBucketSchema), vantage: z.array(VantageBucketSchema) }),
      detail: {
        tags: ['Probes'],
        summary: 'Server-bucketed probe timeseries',
        description:
          'Buckets probe_sample rows in SQL — never raw rows — grouping by `floor(ts / (bucket*1000))` per target. Each bucket returns the median-of-medians, a p5/p95 band over those medians, the true min/max round trip for the SmokePing spread band, and the sample count. Two loss figures: `lossPct` is the sent-weighted aggregate (availability = `100 - lossPct`), `maxLossPct` is the worst single cycle, and `downCycles` counts cycles with nothing returned. `bucket` is in seconds (default 3600 = hourly). The parallel `vantage` array carries one row per bucket describing what those cycles measured *through* — distinct path classes and link speeds, and whether the whole bucket was on the home line. A bucket mixing Ethernet and Wi-Fi reports both classes and `onHomeLine: "mixed"`; it is never flattened to a majority.',
      },
    },
  )

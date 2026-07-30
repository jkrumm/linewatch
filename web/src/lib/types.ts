/**
 * The API contract this dashboard consumes — verified against the running backend's own
 * `GET /openapi/json` (authoritative) rather than assumed from `docs/DESIGN.md` prose. Every type
 * below mirrors a zod response schema in `src/routes/*.ts` field-for-field, including exact
 * nullability (a 100%-loss cycle really does produce `null` `medMs`/`minMs`/etc. — the DB columns
 * are nullable and the API passes that through).
 */

/** The four probe targets from DESIGN.md's "Targets" table. */
export const TARGETS = ['gateway', 'cloudflare', 'google', 'quad9'] as const
export type TargetName = (typeof TARGETS)[number]

export const TARGET_LABEL: Record<TargetName, string> = {
  gateway: 'Gateway',
  cloudflare: 'Cloudflare',
  google: 'Google',
  quad9: 'Quad9',
}

export type OutageScope = 'gateway' | 'wan'

/** One server-bucketed point from `GET /api/probes` — the envelope's `buckets[]` items. `bucket`
 * is the bucket-start timestamp (unix ms), NOT a bucket-size label. The latency fields are null
 * only when every cycle in the bucket was 100% loss.
 *
 * Two loss numbers, deliberately: `lossPct` is the honest aggregate over the bucket
 * (`100 * SUM(sent-received) / SUM(sent)`, 0 when nothing was sent), `maxLossPct` is the single
 * worst cycle in it. One bad cycle in an hour reads as ~0.03% aggregate and 100% worst — both are
 * true and they answer different questions, so neither is derivable from the other. `downCycles`
 * separates "one blip" from "the line was gone for this whole bucket". */
export type ProbeBucket = {
  bucket: number
  target: string
  medianMs: number | null
  /** p5 of the per-cycle medians — the band's lower edge. Not the same as `minMs`. */
  p5Ms: number | null
  /** p95 of the per-cycle medians — the band's upper edge. Not the same as `maxMs`. */
  p95Ms: number | null
  /** `MIN(min_ms)` — the true smoke-band floor: the fastest individual ping in the bucket. */
  minMs: number | null
  /** `MAX(max_ms)` — the true smoke-band ceiling: the slowest individual ping in the bucket. */
  maxMs: number | null
  /** `MAX(loss_pct)` — the worst single cycle. Never null (0 when every cycle succeeded). */
  maxLossPct: number
  /** Aggregate loss across the whole bucket. Never null (0 when `SUM(sent)` is 0). */
  lossPct: number
  /** Cycles in this bucket where `received = 0` — i.e. fully down, not merely lossy. */
  downCycles: number
  count: number
}

/** Bucket size in SECONDS — `GET /api/probes`'s `bucket` query param (integer, default 3600). */
export type ProbeBucketSeconds = number

/** `GET /api/status`'s `lastSamples[]` items — a narrower projection of `probe_sample`, not the
 * full ingest row (no `minMs`/`maxMs`/`avgMs`). `up` is server-derived (`received > 0`). */
export type StatusSample = {
  target: string
  scope: OutageScope
  ts: number
  addr: string
  sent: number
  received: number
  lossPct: number
  medMs: number | null
  jitterMs: number | null
  up: boolean
}

/** `GET /api/status`'s `ongoingOutages[]` items — narrower than the full `Outage` row: an ongoing
 * outage has no `endedAt`/`durationS` by definition, so the API omits them rather than sending
 * `null` for a "not yet known" duration on a row that (once closed) also appears in
 * `/api/outages` with those fields populated. */
export type OngoingOutage = {
  id: number
  scope: OutageScope
  startedAt: number
  cycles: number
  evidence: string[]
}

/** `GET /api/outages`'s full row shape. */
export type Outage = {
  id: number
  scope: OutageScope
  startedAt: number
  endedAt: number | null
  durationS: number | null
  cycles: number
  evidence: string[]
}

export type SpeedBackend = 'ookla' | 'cloudflare'

/** `GET /api/speedtests`'s full row shape. */
export type SpeedTest = {
  id: number
  ts: number
  backend: SpeedBackend
  ok: boolean
  downloadMbps: number | null
  uploadMbps: number | null
  pingMs: number | null
  jitterMs: number | null
  latencyDownMs: number | null
  latencyUpMs: number | null
  packetLoss: number | null
  serverName: string | null
  serverLocation: string | null
  serverId: string | null
  isp: string | null
  externalIp: string | null
  bytesDown: number | null
  bytesUp: number | null
  resultUrl: string | null
  durationS: number | null
  error: string | null
}

/** `GET /api/status`'s `lastSpeedTest` — a narrower projection of `SpeedTest` (no `backend`,
 * `jitterMs`, `packetLoss`, `serverLocation`, `serverId`, `isp`, `externalIp`, `bytesDown`,
 * `bytesUp`, `resultUrl`, `durationS`). */
export type StatusSpeedTest = {
  id: number
  ts: number
  ok: boolean
  downloadMbps: number | null
  uploadMbps: number | null
  pingMs: number | null
  latencyDownMs: number | null
  latencyUpMs: number | null
  serverName: string | null
  error: string | null
}

export type SpeedSummaryStat = {
  p50: number | null
  p95: number | null
  best: number | null
  worst: number | null
}

/** `GET /api/speedtests/summary` — `count` is the number of successful runs the percentiles were
 * computed over (0 when there's no data yet, in which case every stat is null). */
export type SpeedSummary = {
  days: number
  count: number
  download: SpeedSummaryStat
  upload: SpeedSummaryStat
}

export type EventKind = 'intervention' | 'link_change' | 'config_change' | 'note'

export type LinewatchEvent = {
  id: number
  ts: number
  kind: EventKind
  detail: unknown
}

/** `GET /api/status` — "is it working right now", answered in one payload. `ongoingOutages` is an
 * array because a gateway outage and a WAN outage can be open at the same time; `lastSamples` is
 * an array (one entry per target that has ever reported), not a record keyed by target. */
export type StatusResponse = {
  up: boolean
  ongoingOutages: OngoingOutage[]
  lastSamples: StatusSample[]
  lastSpeedTest: StatusSpeedTest | null
}

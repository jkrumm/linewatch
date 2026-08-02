import {
  generateEvents,
  generateOutages,
  generateProbeBuckets,
  generateRouterSnapshot,
  generateSpeedSummary,
  generateSpeedTests,
  generateStatus,
  generateThroughput,
  generateVerdicts,
} from './mock/generate'
import type {
  EventsResponse,
  Outage,
  ProbeBucket,
  ProbeBucketSeconds,
  RangeSummary,
  RouterSnapshot,
  SpeedSummary,
  SpeedTest,
  StatusResponse,
  TargetName,
  ThroughputResponse,
  VantageBucket,
  Verdict,
} from './types'

/**
 * The single fetch layer for the API — every function's real-fetch branch is verified against the
 * running backend's own `GET /openapi/json` (authoritative over `docs/DESIGN.md` prose, which
 * undersold several shapes: list routes wrap their array in a named envelope, `/api/probes`
 * buckets use `bucket`/`medianMs`/`maxLossPct`/`count`, and `/api/status` carries arrays —
 * `ongoingOutages`/`lastSamples` — rather than a single outage and a per-target record, since a
 * gateway outage and a WAN outage can be open at the same time). `USE_MOCK` is the one place that
 * needs to change to point this whole module at the mock generator instead.
 */
const USE_MOCK = false

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`)
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

/** `GET /api/status`. No envelope — the object is the response body. */
export async function getStatus(): Promise<StatusResponse> {
  if (USE_MOCK) return generateStatus()
  return fetchJson<StatusResponse>('/status')
}

/** `GET /api/probes?from&to&target&bucket` — server-bucketed timeseries. `bucket` is an integer
 * number of SECONDS. Response envelope is `{ buckets, vantage }` and BOTH halves are returned:
 * `vantage[]` is the parallel per-bucket record of what those cycles measured *through*, and
 * destructuring it away leaves the caller unable to tell a bucket measured over the home line from
 * one measured over a phone tether. `target` filters `buckets` only — the vantage belongs to the
 * cycle, so its series is the same whichever target is charted. */
export async function getProbeBuckets(params: {
  from: number
  to: number
  target: TargetName
  bucket: ProbeBucketSeconds
}): Promise<{ buckets: ProbeBucket[]; vantage: VantageBucket[] }> {
  if (USE_MOCK) return generateProbeBuckets(params.target, params.from, params.to, params.bucket)
  const qs = new URLSearchParams({
    from: String(params.from),
    to: String(params.to),
    target: params.target,
    bucket: String(params.bucket),
  })
  return fetchJson<{ buckets: ProbeBucket[]; vantage: VantageBucket[] }>(`/probes?${qs.toString()}`)
}

/** `GET /api/throughput?from&to&bucket` — bytes actually carried, bucketed in SQL. The whole
 * envelope is returned, not just `buckets`: `maxIntervalMs` is what makes a `skipped` count
 * readable, and dropping it leaves the caller unable to say why an interval was refused. */
export async function getThroughput(params: {
  from: number
  to: number
  bucket: ProbeBucketSeconds
}): Promise<ThroughputResponse> {
  if (USE_MOCK) return generateThroughput(params.from, params.to, params.bucket)
  const qs = new URLSearchParams({
    from: String(params.from),
    to: String(params.to),
    bucket: String(params.bucket),
  })
  return fetchJson<ThroughputResponse>(`/throughput?${qs.toString()}`)
}

/** `GET /api/outages?from&to&minDuration`. Response envelope is `{ outages, summary }` and both
 * are returned: `summary` is the coverage/degradation/vantage envelope without which the outage
 * list reads as a complete account of the window (see `RangeSummary`). It is null only when the
 * server had no window to compute it over — never treat that as full coverage. */
export async function getOutages(params: {
  from: number
  to: number
  minDuration?: number
}): Promise<{ outages: Outage[]; summary: RangeSummary | null }> {
  if (USE_MOCK) return generateOutages(params.from, params.to, params.minDuration)
  const qs = new URLSearchParams({ from: String(params.from), to: String(params.to) })
  if (params.minDuration !== undefined) qs.set('minDuration', String(params.minDuration))
  return fetchJson<{ outages: Outage[]; summary: RangeSummary | null }>(`/outages?${qs.toString()}`)
}

/** `GET /api/router` — the latest carrier-side reading, each part with its own staleness envelope.
 * No query params and no envelope: the object is the response body. Returned whole, envelopes
 * intact, so a caller cannot mistake a two-hour-old sync rate for a current one. */
export async function getRouter(): Promise<RouterSnapshot> {
  if (USE_MOCK) return generateRouterSnapshot()
  return fetchJson<RouterSnapshot>('/router')
}

/** `GET /api/verdicts?from&to` — the rule engine's conclusions over the window, with their
 * evidence. Both bounds are required: a coverage-bearing verdict is meaningless without a window.
 * Response envelope is `{ verdicts: [...] }`. */
export async function getVerdicts(params: { from: number; to: number }): Promise<Verdict[]> {
  if (USE_MOCK) return generateVerdicts(params.from, params.to)
  const qs = new URLSearchParams({ from: String(params.from), to: String(params.to) })
  const { verdicts } = await fetchJson<{ verdicts: Verdict[] }>(`/verdicts?${qs.toString()}`)
  return verdicts
}

/** `GET /api/speedtests?from&to`. Response envelope is `{ speedTests: [...] }`. */
export async function getSpeedTests(params: { from: number; to: number }): Promise<SpeedTest[]> {
  if (USE_MOCK) return generateSpeedTests(params.from, params.to)
  const qs = new URLSearchParams({ from: String(params.from), to: String(params.to) })
  const { speedTests } = await fetchJson<{ speedTests: SpeedTest[] }>(
    `/speedtests?${qs.toString()}`,
  )
  return speedTests
}

/** `GET /api/speedtests/summary?days`. No envelope. */
export async function getSpeedSummary(days: number): Promise<SpeedSummary> {
  if (USE_MOCK) return generateSpeedSummary(days)
  return fetchJson<SpeedSummary>(`/speedtests/summary?days=${days}`)
}

/** `GET /api/events?from&to` — the timeline overlay. `link_change` IS materialised (by the probe
 * ingest when the host-side vantage changes, by the router poller from the carrier side, and by
 * the collector's link sampler) and `intervention` by `POST /api/interventions`; only
 * `config_change` and `note` are still unwritten.
 *
 * Returned whole, `linkSamplingSince` included, for the same reason `getOutages` keeps its
 * `summary`: an empty `events` array is the timeline's most dangerous response, because it reads
 * as "the link held" when it usually means nothing was watching. Destructuring the array out
 * leaves the caller unable to tell those apart. */
export async function getEvents(params: { from: number; to: number }): Promise<EventsResponse> {
  if (USE_MOCK) return generateEvents(params.from, params.to)
  const qs = new URLSearchParams({ from: String(params.from), to: String(params.to) })
  return fetchJson<EventsResponse>(`/events?${qs.toString()}`)
}

import {
  generateEvents,
  generateOutages,
  generateProbeBuckets,
  generateSpeedSummary,
  generateSpeedTests,
  generateStatus,
} from './mock/generate'
import type {
  LinewatchEvent,
  Outage,
  ProbeBucket,
  ProbeBucketSeconds,
  SpeedSummary,
  SpeedTest,
  StatusResponse,
  TargetName,
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
 * number of SECONDS. Response envelope is `{ buckets: [...] }`. */
export async function getProbeBuckets(params: {
  from: number
  to: number
  target: TargetName
  bucket: ProbeBucketSeconds
}): Promise<ProbeBucket[]> {
  if (USE_MOCK) return generateProbeBuckets(params.target, params.from, params.to, params.bucket)
  const qs = new URLSearchParams({
    from: String(params.from),
    to: String(params.to),
    target: params.target,
    bucket: String(params.bucket),
  })
  const { buckets } = await fetchJson<{ buckets: ProbeBucket[] }>(`/probes?${qs.toString()}`)
  return buckets
}

/** `GET /api/outages?from&to&minDuration`. Response envelope is `{ outages: [...] }`. */
export async function getOutages(params: {
  from: number
  to: number
  minDuration?: number
}): Promise<Outage[]> {
  if (USE_MOCK) return generateOutages(params.from, params.to, params.minDuration)
  const qs = new URLSearchParams({ from: String(params.from), to: String(params.to) })
  if (params.minDuration !== undefined) qs.set('minDuration', String(params.minDuration))
  const { outages } = await fetchJson<{ outages: Outage[] }>(`/outages?${qs.toString()}`)
  return outages
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

/** `GET /api/events?from&to` — timeline overlay; nothing writes an event in v1 (see DESIGN.md).
 * Response envelope is `{ events: [...] }`. */
export async function getEvents(params: { from: number; to: number }): Promise<LinewatchEvent[]> {
  if (USE_MOCK) return generateEvents()
  const qs = new URLSearchParams({ from: String(params.from), to: String(params.to) })
  const { events } = await fetchJson<{ events: LinewatchEvent[] }>(`/events?${qs.toString()}`)
  return events
}

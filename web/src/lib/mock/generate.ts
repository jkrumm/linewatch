/**
 * Deterministic synthetic data standing in for the real API (which does not exist yet — see
 * `docs/DESIGN.md`). Everything here is seeded off a fixed `NOW` captured at module load plus a
 * small hashed-noise PRNG keyed by (kind, target, time-bucket), so repeated calls during one
 * browser session describe the SAME synthetic world: an outage that shows up as a loss spike in
 * the Latency chart is the exact same outage the Uptime list reports, and the Now view's current
 * status is consistent with both. This is what makes the four views demonstrable together without
 * a backend, per the task brief ("develop against a local mock/fixture layer").
 */
import type {
  OngoingOutage,
  Outage,
  OutageScope,
  ProbeBucket,
  ProbeBucketSeconds,
  SpeedSummary,
  SpeedSummaryStat,
  SpeedTest,
  StatusResponse,
  StatusSample,
  StatusSpeedTest,
  TargetName,
} from '../types'
import { TARGETS } from '../types'

const NOW = Date.now()

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261
  for (const part of parts) {
    const s = String(part)
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  return h >>> 0
}

/** A stable pseudo-random value in [0, 1) for a given (kind, ...key) — same key always yields the
 * same value, so the "randomness" reads as noise rather than flicker across re-renders. */
function noiseAt(kind: string, ...key: (string | number)[]): number {
  return mulberry32(hashSeed(kind, ...key))()
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

const BASELINE_MS: Record<TargetName, number> = {
  gateway: 0.6,
  cloudflare: 4.2,
  google: 5.1,
  quad9: 6.4,
}

const TARGET_ADDR: Record<TargetName, string> = {
  gateway: '192.168.1.1',
  cloudflare: '1.1.1.1',
  google: '8.8.8.8',
  quad9: '9.9.9.9',
}

const TARGET_SCOPE: Record<TargetName, OutageScope> = {
  gateway: 'gateway',
  cloudflare: 'wan',
  google: 'wan',
  quad9: 'wan',
}

/** Fixed outage windows, offset back from `NOW`. Shared by every generator below so a loss spike
 * in the Latency/Now views and an entry in the Uptime list are always the same event. */
type OutageDef = {
  scope: OutageScope
  targets: TargetName[]
  startOffsetMs: number
  durationMs: number
}

const OUTAGE_DEFS: OutageDef[] = [
  { scope: 'gateway', targets: ['gateway'], startOffsetMs: 6 * 3_600_000, durationMs: 45_000 },
  {
    scope: 'wan',
    targets: ['cloudflare', 'google', 'quad9'],
    startOffsetMs: 2 * 86_400_000,
    durationMs: 4 * 60_000,
  },
  {
    scope: 'wan',
    targets: ['cloudflare', 'google', 'quad9'],
    startOffsetMs: 5 * 86_400_000 + 3 * 3_600_000,
    durationMs: 90_000,
  },
  {
    scope: 'wan',
    targets: ['cloudflare', 'google', 'quad9'],
    startOffsetMs: 12 * 86_400_000,
    durationMs: 22 * 60_000,
  },
  { scope: 'gateway', targets: ['gateway'], startOffsetMs: 20 * 86_400_000, durationMs: 30_000 },
]

function outageWindow(def: OutageDef): { start: number; end: number } {
  const start = NOW - def.startOffsetMs
  return { start, end: start + def.durationMs }
}

function activeOutageAt(ts: number, target: TargetName): OutageDef | null {
  for (const def of OUTAGE_DEFS) {
    if (!def.targets.includes(target)) continue
    const { start, end } = outageWindow(def)
    if (ts >= start && ts <= end) return def
  }
  return null
}

function mapOutageDef(def: OutageDef): Outage {
  const { start, end } = outageWindow(def)
  const id = OUTAGE_DEFS.indexOf(def) + 1
  return {
    id,
    scope: def.scope,
    startedAt: start,
    endedAt: end,
    durationS: Math.round((end - start) / 1000),
    cycles: Math.max(1, Math.round((end - start) / 30_000)),
    evidence: def.targets,
  }
}

/** `GET /api/status`'s `ongoingOutages[]` shape — no `endedAt`/`durationS`, since an outage this
 * generator would put here is by construction still open at `now`. */
function mapOngoingOutageDef(def: OutageDef): OngoingOutage {
  const { start } = outageWindow(def)
  const id = OUTAGE_DEFS.indexOf(def) + 1
  return {
    id,
    scope: def.scope,
    startedAt: start,
    cycles: Math.max(1, Math.round(def.durationMs / 30_000)),
    evidence: def.targets,
  }
}

function dailyFactor(ts: number): number {
  const d = new Date(ts)
  const hour = d.getHours() + d.getMinutes() / 60
  // gentle evening-usage bump, ~15% above baseline around 20:00
  return 1 + 0.15 * Math.sin(((hour - 20) / 24) * 2 * Math.PI)
}

type SampleStats = {
  medMs: number | null
  minMs: number | null
  maxMs: number | null
  avgMs: number | null
  jitterMs: number | null
  lossPct: number
}

function sampleAt(target: TargetName, ts: number): SampleStats {
  if (activeOutageAt(ts, target)) {
    return { medMs: null, minMs: null, maxMs: null, avgMs: null, jitterMs: null, lossPct: 100 }
  }
  const base = BASELINE_MS[target] * dailyFactor(ts)
  const n = noiseAt('rtt', target, Math.floor(ts / 30_000))
  const spread = base * (0.15 + n * 0.35)
  const med = Math.max(0.1, base + (n - 0.5) * base * 0.4)
  const min = Math.max(0.05, med - spread * 0.6)
  const max = med + spread * 1.4
  const jitter = spread * 0.5
  // rare single-cycle blip loss — most cycles are clean
  const blipRoll = noiseAt('blip', target, Math.floor(ts / 30_000))
  const lossPct = blipRoll > 0.996 ? Math.min(100, 20 + blipRoll * 100) : 0
  return {
    medMs: round2(med),
    minMs: round2(min),
    maxMs: round2(max),
    avgMs: round2(med * 1.02),
    jitterMs: round2(jitter),
    lossPct: round2(lossPct),
  }
}

/** `GET /api/status`'s `lastSamples[]` shape — narrower than the full ingest row (no
 * `minMs`/`maxMs`/`avgMs`), matching the real API's own projection. */
function buildStatusSample(target: TargetName, ts: number): StatusSample {
  const aligned = Math.floor(ts / 30_000) * 30_000
  const s = sampleAt(target, aligned)
  const sent = 20
  const received = s.lossPct >= 100 ? 0 : Math.round(sent * (1 - s.lossPct / 100))
  return {
    target,
    scope: TARGET_SCOPE[target],
    ts: aligned,
    addr: TARGET_ADDR[target],
    sent,
    received,
    lossPct: s.lossPct,
    medMs: s.medMs,
    jitterMs: s.jitterMs,
    up: received > 0,
  }
}

/** Picks a timestamp inside [bucketStart, bucketEnd) that is NOT inside an outage window for
 * `target`, so a bucket only partially covered by an outage still gets real latency stats. Returns
 * null when the whole span is inside the outage. */
function pickSampleTs(target: TargetName, bucketStart: number, bucketEnd: number): number | null {
  const center = (bucketStart + bucketEnd) / 2
  if (!activeOutageAt(center, target)) return center
  if (!activeOutageAt(bucketStart, target)) return bucketStart
  if (!activeOutageAt(bucketEnd - 1, target)) return bucketEnd - 1
  return null
}

export function generateProbeBuckets(
  target: TargetName,
  from: number,
  to: number,
  bucketSeconds: ProbeBucketSeconds,
): ProbeBucket[] {
  const stepMs = bucketSeconds * 1000
  const cyclesPerBucket = Math.max(1, Math.round(stepMs / 30_000))
  const out: ProbeBucket[] = []

  for (
    let bucketStart = Math.floor(from / stepMs) * stepMs;
    bucketStart < to;
    bucketStart += stepMs
  ) {
    const bucketEnd = bucketStart + stepMs
    let overlapMs = 0
    for (const def of OUTAGE_DEFS) {
      if (!def.targets.includes(target)) continue
      const { start, end } = outageWindow(def)
      const overlap = Math.min(bucketEnd, end) - Math.max(bucketStart, start)
      if (overlap > 0) overlapMs += overlap
    }
    const lossFraction = Math.min(1, overlapMs / stepMs)

    const sampleTs = pickSampleTs(target, bucketStart, bucketEnd)
    if (sampleTs === null) {
      out.push({
        bucket: bucketStart,
        target,
        medianMs: null,
        p5Ms: null,
        p95Ms: null,
        minMs: null,
        maxMs: null,
        maxLossPct: 100,
        lossPct: 100,
        downCycles: cyclesPerBucket,
        count: cyclesPerBucket,
      })
      continue
    }

    const s = sampleAt(target, sampleTs)
    const spread = Math.max(0.1, (s.maxMs ?? 0) - (s.minMs ?? 0))
    const maxLossPct = Math.min(100, Math.max(s.lossPct, round2(lossFraction * 100)))
    // The mock must reproduce the divergence the real SQL produces, or the UI gets
    // developed against data where `lossPct` and `maxLossPct` are interchangeable.
    // Outage overlap contributes whole fully-down cycles; the sampled blip
    // contributes its own loss for the single cycle it stands for — so one 100%
    // blip in an hourly bucket reads ~0.8% aggregate against 100% worst.
    const outageCycles = Math.min(cyclesPerBucket, Math.round(lossFraction * cyclesPerBucket))
    const blipCycles = outageCycles < cyclesPerBucket ? s.lossPct / 100 : 0
    out.push({
      bucket: bucketStart,
      target,
      medianMs: s.medMs,
      p5Ms: s.medMs === null ? null : round2(Math.max(0, s.medMs - spread * 0.5)),
      p95Ms: s.medMs === null ? null : round2(s.medMs + spread * 1.1),
      minMs: s.minMs,
      maxMs: s.maxMs,
      maxLossPct,
      lossPct: round2(Math.min(100, (100 * (outageCycles + blipCycles)) / cyclesPerBucket)),
      downCycles: outageCycles + (blipCycles >= 1 ? 1 : 0),
      count: cyclesPerBucket,
    })
  }

  return out
}

export function generateOutages(from: number, to: number, minDurationS?: number): Outage[] {
  return OUTAGE_DEFS.map(mapOutageDef)
    .filter((outage) => (outage.endedAt ?? NOW) >= from && outage.startedAt <= to)
    .filter((outage) => minDurationS === undefined || (outage.durationS ?? 0) >= minDurationS)
    .sort((a, b) => b.startedAt - a.startedAt)
}

export function generateEvents(): [] {
  // Nothing writes `intervention` / `link_change` in v1 — see docs/DESIGN.md's `event` table.
  return []
}

const SPEED_SERVERS: readonly [
  { id: string; name: string; location: string },
  { id: string; name: string; location: string },
  { id: string; name: string; location: string },
] = [
  // Deliberately fictional. Real server/ISP names come from the Ookla result at
  // runtime; hardcoding the actual ones here would put the line's ISP and city
  // into a public repo for no benefit.
  { id: 's-00001', name: 'Example Networks', location: 'Springfield, XX' },
  { id: 's-00002', name: 'Example Telecom', location: 'Shelbyville, XX' },
  { id: 's-00003', name: 'Example Fiber', location: 'Ogdenville, XX' },
]

function speedServerAt(ts: number): (typeof SPEED_SERVERS)[number] {
  const epoch = Math.floor(ts / (18 * 3_600_000))
  const idx = Math.floor(noiseAt('server-epoch', epoch) * SPEED_SERVERS.length)
  return SPEED_SERVERS[Math.min(SPEED_SERVERS.length - 1, idx)] ?? SPEED_SERVERS[0]
}

function isBufferbloatEpisode(ts: number): boolean {
  return noiseAt('bufferbloat-episode', Math.floor(ts / (6 * 3_600_000))) > 0.85
}

const SPEED_STEP_MS = 3_600_000

export function generateSpeedTests(from: number, to: number): SpeedTest[] {
  const out: SpeedTest[] = []
  let id = 1
  for (let ts = Math.ceil(from / SPEED_STEP_MS) * SPEED_STEP_MS; ts <= to; ts += SPEED_STEP_MS) {
    const n = noiseAt('speed', Math.floor(ts / SPEED_STEP_MS))
    const downloadMbps = round1(560 + n * 140)
    const uploadMbps = round1(42 + n * 12)
    const pingMs = round2(BASELINE_MS.cloudflare + n * 1.5)
    const jitterMs = round2(0.4 + n * 0.6)
    const bad = isBufferbloatEpisode(ts)
    const loadFactor = bad ? 8 + n * 6 : 1.1 + n * 0.4
    const latencyDownMs = round2(pingMs * loadFactor)
    const latencyUpMs = round2(pingMs * loadFactor * 1.15)
    const server = speedServerAt(ts)
    out.push({
      id: id++,
      ts,
      backend: 'ookla',
      ok: true,
      downloadMbps,
      uploadMbps,
      pingMs,
      jitterMs,
      latencyDownMs,
      latencyUpMs,
      packetLoss: 0,
      serverName: server.name,
      serverLocation: server.location,
      serverId: server.id,
      isp: 'Example ISP',
      externalIp: '203.0.113.42',
      bytesDown: Math.round((downloadMbps * 1_000_000 * 30) / 8),
      bytesUp: Math.round((uploadMbps * 1_000_000 * 30) / 8),
      resultUrl: null,
      durationS: 32,
      error: null,
    })
  }
  return out
}

function percentileValue(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))
  return sorted[idx] ?? 0
}

function summarize(values: number[]): SpeedSummaryStat {
  if (values.length === 0) return { p50: null, p95: null, best: null, worst: null }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p50: round1(percentileValue(sorted, 0.5)),
    p95: round1(percentileValue(sorted, 0.95)),
    best: round1(Math.max(...sorted)),
    worst: round1(Math.min(...sorted)),
  }
}

export function generateSpeedSummary(days: number): SpeedSummary {
  const rows = generateSpeedTests(NOW - days * 86_400_000, NOW).filter((r) => r.ok)
  const downs = rows.flatMap((r) => (r.downloadMbps === null ? [] : [r.downloadMbps]))
  const ups = rows.flatMap((r) => (r.uploadMbps === null ? [] : [r.uploadMbps]))
  return { days, count: rows.length, download: summarize(downs), upload: summarize(ups) }
}

export function generateStatus(now: number = NOW): StatusResponse {
  const ongoingOutages: OngoingOutage[] = OUTAGE_DEFS.filter((def) => {
    const w = outageWindow(def)
    return now >= w.start && now <= w.end
  }).map(mapOngoingOutageDef)

  const lastSamples: StatusSample[] = TARGETS.map((target) => buildStatusSample(target, now))

  const recentSpeedTests = generateSpeedTests(now - 6 * 3_600_000, now)
  const lastFull = recentSpeedTests.at(-1) ?? null
  const lastSpeedTest: StatusSpeedTest | null = lastFull
    ? {
        id: lastFull.id,
        ts: lastFull.ts,
        ok: lastFull.ok,
        downloadMbps: lastFull.downloadMbps,
        uploadMbps: lastFull.uploadMbps,
        pingMs: lastFull.pingMs,
        latencyDownMs: lastFull.latencyDownMs,
        latencyUpMs: lastFull.latencyUpMs,
        serverName: lastFull.serverName,
        error: lastFull.error,
      }
    : null

  return {
    up: ongoingOutages.length === 0,
    ongoingOutages,
    lastSamples,
    lastSpeedTest,
  }
}

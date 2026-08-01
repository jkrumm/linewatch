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
  EventsResponse,
  HomeLineVerdict,
  LinewatchEvent,
  OngoingOutage,
  Outage,
  OutageScope,
  ProbeBucket,
  ProbeBucketSeconds,
  RangeSummary,
  RouterSnapshot,
  SpeedSummary,
  SpeedSummaryStat,
  SpeedTest,
  StatusResponse,
  StatusSample,
  StatusSpeedTest,
  TargetName,
  Vantage,
  VantageBucket,
  Verdict,
} from '../types'
import { TARGETS } from '../types'

const NOW = Date.now()

/** The collector's probe cadence — the same 30s `src/config.ts` defaults to. */
const PROBE_CYCLE_MS = 30_000

/**
 * The mock's coverage model, and the reason it is not 100%.
 *
 * Real data has holes: the collector restarts, the LaunchAgent is reloaded, the machine sleeps.
 * A mock that emits a complete grid of buckets lets the dashboard be built entirely against data
 * where absence never occurs, and absence is the one thing this dashboard exists to show
 * honestly — an unmeasured hour is not an hour that was up. So the mock omits buckets outright
 * (they are ABSENT from the array, never present with zeroed fields, because a zero-valued bucket
 * is a measurement claiming nothing happened) and reports fewer cycles inside the ones it keeps.
 *
 * The two fractions multiply out to the range-level coverage the summary reports:
 * 0.9 × 0.78 ≈ 0.7.
 */
const PRESENT_BUCKET_FRACTION = 0.9
const MEASURED_CYCLE_FRACTION = 0.78
const RANGE_COVERAGE_FRACTION = PRESENT_BUCKET_FRACTION * MEASURED_CYCLE_FRACTION

/** `LINEWATCH_DEGRADED_LOSS_PCT`'s default in `src/config.ts`. */
const DEGRADED_LOSS_PCT = 20

/**
 * When the synthetic collector started reporting a vantage at all. Cycles older than this have no
 * `probe_cycle` row, so their buckets read `vantageCycles: 0` / `onHomeLine: 'unknown'` — the
 * state a real deployment spends its entire pre-vantage history in, and the one a UI is most
 * likely to accidentally paint as "on the home line".
 */
const VANTAGE_SINCE = NOW - 3 * 86_400_000

/** A Wi-Fi failover: two hours where the cycles went out over en1, so nothing measured in them
 * says anything about the home line. Gives the vantage series its `none`/`mixed` buckets. */
const WIFI_WINDOW = { start: NOW - 9 * 3_600_000, end: NOW - 7 * 3_600_000 }

/**
 * A recent hole in the vantage record: cycles were recorded and probes succeeded, but no
 * `probe_cycle` row was stored for them. This is not hypothetical — a container predating
 * `CycleInput` dropped the unknown key, returned 200, and left 106 real cycles with no vantage at
 * all. Those cycles read as `unknown` forever, indistinguishable from cycles a collector never
 * reported. Reproduced here so the recent views meet the state too, not only the long ones that
 * reach back before `VANTAGE_SINCE`.
 */
const VANTAGE_HOLE = { start: NOW - 2 * 3_600_000, end: NOW - 45 * 60_000 }

/**
 * A window where the cycle wrote a `probe_cycle` row and could parse **nothing** into it — the
 * state a failing `route -n get default` produces. It exists so `onHomeLine: null` is reachable in
 * mock development at all: without it every mock vantage is a confident true or false, and the
 * "unknown" rendering — the one state the dashboard must never draw as a check mark — could be
 * built wrong and never seen. Distinct from `VANTAGE_HOLE`, where no row exists at all.
 */
const VANTAGE_UNKNOWN_WINDOW = { start: NOW - 20 * 3_600_000, end: NOW - 19 * 3_600_000 }

/**
 * When the synthetic collector's 1 Hz link sampler started. Before it, `link_watch_s` is null on
 * every cycle and an empty timeline means nothing was watching; after it, an empty timeline means
 * no transition longer than the ~1 s sampling resolution was observed. The mock carries the
 * boundary so both sentences are reachable by picking a range.
 */
const LINK_SAMPLING_SINCE = NOW - 12 * 3_600_000

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

/**
 * The first three are sized against the bucket widths `lib/range.ts` asks for (60s at 1h, 300s at
 * 24h, 900s for the Now sparkline, 3600s at 7d), so every one of those views contains at least one
 * bucket that is fully down: `medianMs: null` with `downCycles > 0`. That is a different kind of
 * absence from an omitted bucket — nothing came back, as opposed to nothing was asked — and a
 * chart that renders them identically is wrong. Each duration is at least TWICE its target bucket
 * width, since an outage of exactly one bucket's length lands astride a boundary and fills
 * neither. The 30d and `all` views bucket at 4h and 24h and get partial loss instead; a mock
 * outage long enough to fill a whole day would be a fiction nothing in this dashboard needs.
 */
const OUTAGE_DEFS: OutageDef[] = [
  {
    scope: 'wan',
    targets: ['cloudflare', 'google', 'quad9'],
    startOffsetMs: 35 * 60_000,
    durationMs: 150_000,
  },
  {
    scope: 'wan',
    targets: ['cloudflare', 'google', 'quad9'],
    startOffsetMs: 5 * 3_600_000,
    durationMs: 35 * 60_000,
  },
  {
    scope: 'wan',
    targets: ['cloudflare', 'google', 'quad9'],
    startOffsetMs: 3 * 86_400_000 + 2 * 3_600_000,
    durationMs: 2 * 3_600_000 + 5 * 60_000,
  },
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

/**
 * Whether the synthetic collector was running for this bucket at all. Keyed on the bucket start
 * only — never on the target — because a collector that is not running records nothing for any
 * target, and a gap that appeared for Cloudflare but not Google would be a fiction no failure mode
 * produces.
 */
function bucketRecorded(bucketStart: number): boolean {
  return noiseAt('coverage-gap', bucketStart) < PRESENT_BUCKET_FRACTION
}

/** Cycles recorded in a bucket that WAS measured — fewer than the cadence implies, see
 * `MEASURED_CYCLE_FRACTION`. At least one, since a bucket with zero recorded cycles is a gap and
 * gaps are omitted rather than emitted empty. */
function measuredCycles(stepMs: number): number {
  const cadenceCycles = Math.max(1, Math.round(stepMs / PROBE_CYCLE_MS))
  return Math.max(1, Math.round(cadenceCycles * MEASURED_CYCLE_FRACTION))
}

/** The server's own collapse rule (`homeLineVerdict` in `src/db/bucket-probes.ts`), mirrored so
 * the mock can never be more optimistic than the backend: `all` requires every RECORDED cycle to
 * have reported 1, not every reporting one. */
function homeLineVerdict(cycles: number, home: number, off: number): HomeLineVerdict {
  if (home === 0 && off === 0) return 'unknown'
  if (home === cycles) return 'all'
  if (off === cycles) return 'none'
  return 'mixed'
}

function overlapFraction(start: number, end: number, windowStart: number, windowEnd: number): number {
  const span = end - start
  if (span <= 0) return 0
  const overlap = Math.min(end, windowEnd) - Math.max(start, windowStart)
  return Math.max(0, Math.min(1, overlap / span))
}

/** One `vantage[]` row for an emitted bucket. Split out because the vantage is a property of the
 * cycle, exactly as `bucketVantage` is a separate query server-side. */
function vantageBucketAt(bucketStart: number, stepMs: number, cycles: number): VantageBucket {
  const bucketEnd = bucketStart + stepMs
  // Cycles before VANTAGE_SINCE, and those inside VANTAGE_HOLE, recorded no vantage at all. A
  // bucket straddling either edge reports some of its cycles and not others — the `mixed` case,
  // which is the whole reason `vantageCycles` is separate from `cycles`.
  const reportedFraction = Math.max(
    0,
    overlapFraction(bucketStart, bucketEnd, VANTAGE_SINCE, NOW) -
      overlapFraction(bucketStart, bucketEnd, VANTAGE_HOLE.start, VANTAGE_HOLE.end),
  )
  const vantageCycles = Math.round(reportedFraction * cycles)
  const wifiCycles = Math.min(
    vantageCycles,
    Math.round(overlapFraction(bucketStart, bucketEnd, WIFI_WINDOW.start, WIFI_WINDOW.end) * cycles),
  )
  const homeLineCycles = vantageCycles - wifiCycles

  const pathClasses: string[] = []
  const pathIfs: string[] = []
  if (homeLineCycles > 0) {
    pathClasses.push('ethernet')
    pathIfs.push('en0')
  }
  if (wifiCycles > 0) {
    pathClasses.push('wifi')
    pathIfs.push('en1')
  }

  return {
    bucket: bucketStart,
    cycles,
    vantageCycles,
    pathClasses: pathClasses.sort(),
    // Only the Ethernet cycles contribute a negotiated speed: on Wi-Fi the `ifconfig` media line
    // carries no baseT token, so `link_mbit` is NULL and `group_concat(DISTINCT …)` skips it. An
    // empty array here means "not reported", never "0 Mbit".
    linkMbits: homeLineCycles > 0 ? [1000] : [],
    pathIfs: pathIfs.sort(),
    onHomeLine: homeLineVerdict(cycles, homeLineCycles, wifiCycles),
    homeLineCycles,
    offHomeLineCycles: wifiCycles,
    unknownHomeLineCycles: cycles - vantageCycles,
  }
}

export function generateProbeBuckets(
  target: TargetName,
  from: number,
  to: number,
  bucketSeconds: ProbeBucketSeconds,
): { buckets: ProbeBucket[]; vantage: VantageBucket[] } {
  const stepMs = bucketSeconds * 1000
  const cyclesPerBucket = measuredCycles(stepMs)
  const buckets: ProbeBucket[] = []
  const vantage: VantageBucket[] = []

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
    // A fully-down bucket is never dropped as unrecorded: the two absences have to be
    // distinguishable side by side in one view, and a gap swallowing the down bucket would hide
    // the case the charts most need to get right.
    if (sampleTs === null) {
      buckets.push({
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
      vantage.push(vantageBucketAt(bucketStart, stepMs, cyclesPerBucket))
      continue
    }

    // Omitted entirely — not emitted with zeroes. Both series skip it, because a collector that
    // was not running produced neither probe samples nor a vantage.
    if (!bucketRecorded(bucketStart)) continue

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
    buckets.push({
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
    vantage.push(vantageBucketAt(bucketStart, stepMs, cyclesPerBucket))
  }

  return { buckets, vantage }
}

/**
 * The honesty envelope `GET /api/outages` returns beside the rows — see `RangeSummary`. Built with
 * the server's own arithmetic, including the one branch that matters most: `coveragePct` is
 * **null**, never 0, when the range is shorter than one probe cycle and there is no share of it to
 * report. Any window narrower than half a cycle (15 s) rounds `expectedCycles` to 0 and produces
 * exactly that.
 */
function rangeSummary(from: number, to: number): RangeSummary {
  const expectedCycles = Math.max(0, Math.round((to - from) / PROBE_CYCLE_MS))
  const recordedCycles = Math.round(expectedCycles * RANGE_COVERAGE_FRACTION)

  const reportedFraction = Math.max(
    0,
    overlapFraction(from, to, VANTAGE_SINCE, NOW) -
      overlapFraction(from, to, VANTAGE_HOLE.start, VANTAGE_HOLE.end),
  )
  const reportedCycles = Math.round(reportedFraction * recordedCycles)
  const offHomeLineCycles = Math.min(
    reportedCycles,
    Math.round(overlapFraction(from, to, WIFI_WINDOW.start, WIFI_WINDOW.end) * recordedCycles),
  )
  const homeLineCycles = reportedCycles - offHomeLineCycles

  return {
    from,
    to,
    recordedCycles,
    expectedCycles,
    coveragePct:
      expectedCycles === 0 ? null : Math.min(100, (100 * recordedCycles) / expectedCycles),
    firstTs: recordedCycles === 0 ? null : Math.floor(from / PROBE_CYCLE_MS) * PROBE_CYCLE_MS,
    lastTs: recordedCycles === 0 ? null : Math.floor(to / PROBE_CYCLE_MS) * PROBE_CYCLE_MS,
    // Cycles where every WAN anchor was hurting without any of them reaching zero replies — the
    // degradation no outage row can hold. Rare, but never zero over a long range.
    degradedCycles: Math.round(recordedCycles * 0.008),
    degradedLossPct: DEGRADED_LOSS_PCT,
    onHomeLine: homeLineVerdict(recordedCycles, homeLineCycles, offHomeLineCycles),
    homeLineCycles,
    offHomeLineCycles,
    unknownHomeLineCycles: recordedCycles - reportedCycles,
  }
}

export function generateOutages(
  from: number,
  to: number,
  minDurationS?: number,
): { outages: Outage[]; summary: RangeSummary | null } {
  const outages = OUTAGE_DEFS.map(mapOutageDef)
    .filter((outage) => (outage.endedAt ?? NOW) >= from && outage.startedAt <= to)
    .filter((outage) => minDurationS === undefined || (outage.durationS ?? 0) >= minDurationS)
    .sort((a, b) => b.startedAt - a.startedAt)
  return { outages, summary: rangeSummary(from, to) }
}

/**
 * The transition timeline, built out of the same synthetic world the rest of this file describes
 * rather than invented alongside it: the two `vantage-diff` rows are the edges of `WIFI_WINDOW`,
 * and the `link-sampler` pair sits inside the 35-minute WAN outage five hours back, mirroring the
 * real 14.3 s `hasLink: false` state that was logged inside a recorded outage while the `event`
 * table stayed empty.
 *
 * Every row carries a `source`, and the four differ in what they are evidence *of*: a
 * `vantage-diff` row says the path had changed by the time the next 30 s snapshot was taken, a
 * `link-sampler` row dates the transition itself to ~1 s, a `router-poller` row is the carrier's
 * own account up to a poll interval late, and `manual` is a human saying what they did.
 */
export function generateEvents(from: number, to: number): EventsResponse {
  const wifiOutage = OUTAGE_DEFS[1]
  const outageStart = wifiOutage ? outageWindow(wifiOutage).start : NOW - 5 * 3_600_000
  const outageEnd = wifiOutage ? outageWindow(wifiOutage).end : outageStart + 35 * 60_000

  const all: LinewatchEvent[] = [
    {
      id: 1,
      ts: WIFI_WINDOW.start,
      kind: 'link_change',
      source: 'vantage-diff',
      // Only the fields that were non-null on BOTH sides appear: the Wi-Fi cycles report no media
      // token at all, so `linkMbit` is absent from the diff rather than shown dropping to zero.
      detail: {
        source: 'vantage-diff',
        changed: {
          pathIf: { before: 'en0', after: 'en1' },
          pathClass: { before: 'ethernet', after: 'wifi' },
        },
      },
    },
    {
      id: 2,
      ts: WIFI_WINDOW.end,
      kind: 'link_change',
      source: 'vantage-diff',
      detail: {
        source: 'vantage-diff',
        changed: {
          pathIf: { before: 'en1', after: 'en0' },
          pathClass: { before: 'wifi', after: 'ethernet' },
        },
      },
    },
    {
      id: 3,
      ts: outageStart + 3_000,
      kind: 'link_change',
      source: 'link-sampler',
      detail: { source: 'link-sampler', state: 'down', iface: 'en0' },
    },
    {
      id: 4,
      ts: outageStart + 17_300,
      kind: 'link_change',
      source: 'link-sampler',
      detail: { source: 'link-sampler', state: 'up', iface: 'en0' },
    },
    {
      id: 5,
      ts: outageStart + 12 * 60_000,
      kind: 'intervention',
      source: 'manual',
      detail: { source: 'manual', action: 'power-cycled the router', note: 'ten minutes into the outage' },
    },
    {
      id: 6,
      ts: outageEnd - 30_000,
      kind: 'link_change',
      source: 'router-poller',
      detail: {
        source: 'router-poller',
        reason: 'line_resync',
        showtimeStartS: 45,
        previousShowtimeStartS: 3 * 86_400,
        previousPollTs: outageEnd - 5 * 60_000,
      },
    },
  ]

  return {
    events: all.filter((e) => e.ts >= from && e.ts <= to).sort((a, b) => b.ts - a.ts),
    // Same rule the route applies: the earliest watched cycle *inside the window*, or null when
    // the window ends before the sampler ever ran. A window entirely before `LINK_SAMPLING_SINCE`
    // therefore returns an empty array AND null, which is the pair the empty state has to read.
    linkSamplingSince: to < LINK_SAMPLING_SINCE ? null : Math.max(from, LINK_SAMPLING_SINCE),
  }
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

/** ~4% of runs. Rare enough to stay a special case in the UI, frequent enough that a week-long
 * range always contains one. */
function speedTestFailed(ts: number): boolean {
  return noiseAt('speed-failure', Math.floor(ts / SPEED_STEP_MS)) > 0.96
}

/** Every measured field of a failed run is null, not zero: the run produced no reading, and a 0
 * Mbps reading is a measurement claiming the line moved nothing. */
const FAILED_SPEED_TEST: Omit<SpeedTest, 'id' | 'ts' | 'error'> = {
  backend: 'ookla',
  ok: false,
  downloadMbps: null,
  uploadMbps: null,
  pingMs: null,
  jitterMs: null,
  latencyDownMs: null,
  latencyUpMs: null,
  packetLoss: null,
  serverName: null,
  serverLocation: null,
  serverId: null,
  isp: null,
  externalIp: null,
  bytesDown: null,
  bytesUp: null,
  resultUrl: null,
  durationS: null,
}

export function generateSpeedTests(from: number, to: number): SpeedTest[] {
  const out: SpeedTest[] = []
  let id = 1
  for (let ts = Math.ceil(from / SPEED_STEP_MS) * SPEED_STEP_MS; ts <= to; ts += SPEED_STEP_MS) {
    const n = noiseAt('speed', Math.floor(ts / SPEED_STEP_MS))
    // A run that started and produced no figure. Real and routine (the Ookla CLI fails on a line
    // that is down, which is exactly when a throughput number would be most wanted), and it is a
    // third state: an hour whose only run FAILED is not an hour that went untested, and a chart
    // that drops it renders the two identically.
    if (speedTestFailed(ts)) {
      out.push({
        ...FAILED_SPEED_TEST,
        id: id++,
        ts,
        error: 'Cannot connect to the speed test server',
      })
      continue
    }
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
    newestSampleTs: lastSamples.reduce<number | null>((newest, sample) => (newest === null || sample.ts > newest ? sample.ts : newest), null),
    // Always false: the mock generates a *history*, and a speed test in flight
    // is an instantaneous condition with no history to generate. A mock that
    // flipped this at random would make the dashboard's stand-down state appear
    // for reasons no reader could reconstruct.
    speedtestRunning: false,
    ongoingOutages,
    lastSamples,
    lastSpeedTest,
    vantage: currentVantage(now),
  }
}

/**
 * The most recent cycle's vantage, in three states rather than one.
 *
 * Inside `WIFI_WINDOW` it is honestly `onHomeLine: false` over en1 with **no negotiated speed at
 * all** — `linkMbit`/`linkMedia`/`linkDuplex` are null there because the Wi-Fi media line carries
 * no baseT token, and a plausible-looking number would be the exact fabrication this field exists
 * to prevent. Inside `VANTAGE_UNKNOWN_WINDOW` every field is null including `onHomeLine`: the row
 * was written, nothing in it was parseable, and that is *unknown*, never a fallback to the
 * Ethernet case below.
 *
 * `linkMaxMbit` is 1000 on Ethernet and equal to the negotiated speed there, which is the healthy
 * shape — the interesting one (a 1000-capable NIC negotiated down to 100) is a fault, and the mock
 * does not manufacture faults it has no other evidence for.
 */
/**
 * Full coverage once the sampler exists, null before it. The boundary is the whole point: an empty
 * event timeline means "no transition above the sampling resolution" on one side of it and
 * "nothing was watching" on the other, and those are not the same claim.
 */
function linkWatchFor(ts: number): number | null {
  return ts < LINK_SAMPLING_SINCE ? null : PROBE_CYCLE_MS / 1000
}

function currentVantage(now: number): Vantage {
  const ts = Math.floor(now / PROBE_CYCLE_MS) * PROBE_CYCLE_MS
  if (ts >= VANTAGE_UNKNOWN_WINDOW.start && ts <= VANTAGE_UNKNOWN_WINDOW.end) {
    return {
      ts,
      pathIf: null,
      pathClass: null,
      linkMedia: null,
      linkMbit: null,
      linkDuplex: null,
      linkMaxMbit: null,
      dhcpBoundAt: null,
      gatewayAddr: null,
      onHomeLine: null,
      linkWatchS: null,
    }
  }
  if (ts >= WIFI_WINDOW.start && ts <= WIFI_WINDOW.end) {
    return {
      ts,
      pathIf: 'en1',
      pathClass: 'wifi',
      linkMedia: null,
      linkMbit: null,
      linkDuplex: null,
      linkMaxMbit: null,
      dhcpBoundAt: WIFI_WINDOW.start,
      gatewayAddr: TARGET_ADDR.gateway,
      onHomeLine: false,
      linkWatchS: linkWatchFor(ts),
    }
  }
  return {
    ts,
    pathIf: 'en0',
    pathClass: 'ethernet',
    linkMedia: '1000baseT',
    linkMbit: 1000,
    linkDuplex: 'full',
    linkMaxMbit: 1000,
    dhcpBoundAt: VANTAGE_SINCE,
    gatewayAddr: TARGET_ADDR.gateway,
    onHomeLine: true,
    linkWatchS: linkWatchFor(ts),
  }
}

/** The router poller's default cadence (every 10 minutes, `DEFAULT_CRON` in
 * `src/services/router/config.ts`) and its derived staleness bound of two intervals. */
const ROUTER_POLL_INTERVAL_MS = 10 * 60_000
const ROUTER_STALE_AFTER_MS = 2 * ROUTER_POLL_INTERVAL_MS

/** Wraps a value in the same per-part envelope `GET /api/router` sends, deriving `stale` from the
 * age rather than asserting it — the mock must not be able to claim a fresh reading is stale or
 * the reverse. */
function routerPart<T>(observedAt: number, value: T) {
  const ageMs = NOW - observedAt
  return { observedAt, ageMs, stale: ageMs > ROUTER_STALE_AFTER_MS, value }
}

/**
 * `GET /api/router`. The WAN part is deliberately older than the rest: during a WAN outage the
 * router writes no `role: wan` row while the LAN bridge keeps updating, so a snapshot whose parts
 * all share one age would let the dashboard be built without ever meeting the case the per-part
 * envelope exists for. Every value here is fictional — no real ISP, hostname or address (public
 * repo, see CLAUDE.md).
 */
export function generateRouterSnapshot(): RouterSnapshot {
  const lineTs = NOW - 2 * 60_000
  const wanTs = NOW - 26 * 60_000
  const lanTs = NOW - 90_000

  return {
    pollerEnabled: true,
    disabledReason: null,
    configWarning: null,
    collectorHostIp: '192.168.1.100',
    pollIntervalMs: ROUTER_POLL_INTERVAL_MS,
    now: NOW,
    staleAfterMs: ROUTER_STALE_AFTER_MS,
    line: routerPart(lineTs, {
      id: 1,
      ts: lineTs,
      carrier: 'gfast' as const,
      status: 'Up',
      downSyncKbps: 1_000_000,
      upSyncKbps: 60_000,
      downCurrKbps: 3_100,
      upCurrKbps: 480,
      downNoiseMarginDb: 6.5,
      upNoiseMarginDb: 6.1,
      downAttenuationDb: 12.3,
      profile: '212b',
      showtimeStartS: 3 * 86_400 + 4 * 3_600,
      erroredSecs: 12,
      severelyErroredSecs: 0,
    }),
    wan: routerPart(wanTs, {
      id: 2,
      ts: wanTs,
      name: 'wan-1',
      stack: 1,
      role: 'wan' as const,
      rxKbps: 2_900,
      txKbps: 410,
      bytesRx: 812_000_000_000,
      bytesTx: 74_000_000_000,
    }),
    lan: routerPart(lanTs, {
      id: 3,
      ts: lanTs,
      name: 'br-lan',
      stack: 0,
      role: 'lan' as const,
      rxKbps: 640,
      txKbps: 3_050,
      bytesRx: 71_000_000_000,
      bytesTx: 806_000_000_000,
    }),
    collectorHost: routerPart(lanTs, {
      id: 4,
      ts: lanTs,
      ip: '192.168.1.100',
      interfaceType: 'Ethernet',
      active: 1,
      clientType: 'computer',
    }),
    ports: routerPart(lanTs, [
      { id: 5, ts: lanTs, name: 'eth0', alias: 'LAN1', status: 'Up', maxBitRate: 1000, duplexMode: 'Full' },
      { id: 6, ts: lanTs, name: 'eth1', alias: 'LAN2', status: 'Down', maxBitRate: null, duplexMode: null },
    ]),
  }
}

/**
 * `GET /api/verdicts`. Templated from the same synthetic world the other generators describe, so
 * the numbers a verdict cites are the numbers the charts draw — a mock verdict quoting figures
 * that appear nowhere else would train the UI to present unfounded sentences.
 *
 * Both properties the real rule engine guarantees are exercised here: every verdict cites its
 * evidence, and one carries a non-null `uncertainty` so the panel is never built without the case
 * where a cause was deliberately withheld.
 */
export function generateVerdicts(from: number, to: number): Verdict[] {
  const summary = rangeSummary(from, to)
  const coveragePct = summary.coveragePct
  const hours = Math.max(1, Math.round((to - from) / 3_600_000))

  const verdicts: Verdict[] = []

  if (coveragePct !== null && coveragePct < 95) {
    verdicts.push({
      id: 'probe_coverage_low',
      severity: 'critical',
      title: `This window is only ${coveragePct.toFixed(1)}% measured`,
      conclusion: `Only ${summary.recordedCycles} of the ${summary.expectedCycles} probe cycles this ${hours} h window should hold were recorded (${coveragePct.toFixed(1)}%). The rest of the window was not measured, which is not the same as up.`,
      evidence: [
        { label: 'Recorded cycles', value: String(summary.recordedCycles) },
        { label: 'Expected cycles', value: String(summary.expectedCycles) },
        { label: 'Coverage', value: `${coveragePct.toFixed(1)}%` },
      ],
      action: "Check the collector's log for spool events and restarts: `make collector-logs`.",
      uncertainty: null,
    })
  }

  if (summary.unknownHomeLineCycles > 0) {
    verdicts.push({
      id: 'symmetric_loss_not_line',
      severity: 'info',
      title: `${summary.degradedCycles} loss cycles hit every WAN anchor at once`,
      conclusion: `${summary.degradedCycles} cycles lost at least ${summary.degradedLossPct}% on every WAN anchor at once without any anchor going silent.`,
      evidence: [
        { label: 'Degraded cycles', value: String(summary.degradedCycles) },
        { label: 'Loss threshold', value: `${summary.degradedLossPct}%` },
        { label: 'Cycles with no vantage', value: String(summary.unknownHomeLineCycles) },
      ],
      action: 'Not an ISP matter. Compare against host load at those instants.',
      uncertainty: `${summary.unknownHomeLineCycles} of the ${summary.recordedCycles} recorded cycles reported no vantage, so what those cycles measured through is unknown and no attribution over this window is defensible.`,
    })
  }

  return verdicts
}

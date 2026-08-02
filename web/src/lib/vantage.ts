import type { RouterSnapshot, StatusSpeedTest, Vantage, VantageBucket } from './types'
import { isStale } from './freshness'

/**
 * How far apart two readings may be taken and still be described as "the same moment".
 *
 * Pinned absolutely rather than derived from any poll interval. DESIGN.md names the failure this
 * guards — "dividing a 25-minute-old sync figure by a 30-second-old link speed manufactures a
 * disagreement between two moments" — and that failure is a property of the arithmetic, not of the
 * collection cadence. Ten minutes because a G.fast line that resyncs does so in seconds and the
 * carrier figure is otherwise near-constant, so a reading this fresh cannot be describing a
 * different regime than a 30 s-old link speed.
 */
const COMPARABLE_WINDOW_MS = 10 * 60_000

/**
 * `false` for a null `observedAt`, which means the reading carries no instant at all. An age that
 * cannot be computed is not an age within tolerance — treating unknown as comparable is how an
 * undated figure ends up captioned "the same moment".
 */
function withinComparableWindow(observedAt: number | null, now: number): boolean {
  if (observedAt === null) return false
  return now - observedAt < COMPARABLE_WINDOW_MS
}

/**
 * The three states of `probe_cycle.on_home_line`, kept apart at the type level so a component
 * cannot render two of them the same way. `unknown` is not a soft `false`: nothing was reported,
 * and both "this is the home line" and "this is not" are unsupported claims about it.
 */
export type HomeLineState = 'home-line' | 'other-path' | 'unknown'

export interface HomeLineChip {
  state: HomeLineState
  /** Short badge text. `unknown` says the word — never a check mark, never a tick with a caveat. */
  label: string
  /** Mantine badge colour. Grey for unknown: neither the green of a confirmed home line nor the
   * red of a confirmed detour, because it is not a middle value between them. */
  color: 'green' | 'orange' | 'gray'
  description: string
}

export function homeLineChip(onHomeLine: boolean | null): HomeLineChip {
  if (onHomeLine === null) {
    return {
      state: 'unknown',
      label: 'unknown',
      color: 'gray',
      description:
        'The cycle reported no on_home_line value, so whether this measurement went out over the home line is unknown. Unknown is not yes.',
    }
  }
  if (onHomeLine) {
    return {
      state: 'home-line',
      label: 'home line',
      color: 'green',
      description: 'Ethernet, through the configured home gateway.',
    }
  }
  return {
    state: 'other-path',
    label: 'not the home line',
    color: 'orange',
    description:
      'The cycle went out over some other path — Wi-Fi, a tether, or an unexpected gateway. Nothing it measured describes the home line.',
  }
}

/**
 * One rate in the carrier-vs-host comparison.
 *
 * `kind` is what stops the panel equating three numbers that share a unit and nothing else: two of
 * them are rates a negotiation *agreed on* and the third is throughput something actually moved.
 * A measured 93 Mbps under a negotiated 100 Mbit link is a healthy transfer, not a 7% shortfall,
 * and the panel must never subtract one from the other.
 */
export interface RateReading {
  label: string
  /** Megabits per second. Null when the source reported nothing — never 0, which is a measurement. */
  mbps: number | null
  observedAt: number | null
  kind: 'negotiated' | 'measured'
  /**
   * Whether the reading is history by its own source's rule. **Null means the source has no
   * freshness rule to apply** — the hourly speed test is not stale at 40 minutes — and a null must
   * never be read as fresh; the age is shown next to it either way.
   */
  stale: boolean | null
}

export interface CarrierHostComparison {
  /** The line the carrier says it syncs at, from `router_line_sample.down_sync_kbps`. */
  carrier: RateReading
  /** The rate the host's NIC negotiated with whatever is on the other end of the cable. */
  host: RateReading
  /** What the last speed test actually moved. */
  throughput: RateReading
  /** `host / carrier × 100`, or **null whenever it would compare readings of different ages**. */
  hostVsCarrierPct: number | null
  /** Why no ratio is shown. Null exactly when `hostVsCarrierPct` is non-null. */
  refusal: string | null
}

function ageMinutes(observedAt: number | null, now: number): number {
  if (observedAt === null) return 0
  return Math.max(0, Math.round((now - observedAt) / 60_000))
}

/**
 * The three rates side by side, and the ratio deliberately withheld whenever the two sides were
 * not observed at comparable times.
 *
 * The refusal is the point of this function. `GET /api/router`'s parts age independently and the
 * poller currently stores a minority of its due polls, so the carrier reading is routinely tens of
 * minutes old while the host vantage is seconds old. Dividing one by the other prints a confident
 * percentage describing two different moments — a disagreement that was never observed. Two
 * numbers with their ages is the honest rendering of that state, and it is what this returns.
 */
export function compareCarrierHost(input: {
  router: RouterSnapshot | null
  vantage: Vantage | null
  speedTest: StatusSpeedTest | null
  /** The dashboard's floored clock, so the host ages are quantised like the data behind them. */
  now: number
}): CarrierHostComparison {
  const line = input.router?.line ?? null
  const downSyncKbps = line?.value?.downSyncKbps ?? null
  const carrier: RateReading = {
    label: 'Carrier sync',
    mbps: downSyncKbps === null ? null : downSyncKbps / 1000,
    observedAt: line?.observedAt ?? null,
    kind: 'negotiated',
    // The server computes staleness against its own clock at request time; it is not recomputed
    // here. A part that does not exist has no age and so no staleness — not "fresh".
    stale: line === null ? null : line.stale,
  }

  const vantage = input.vantage
  const host: RateReading = {
    label: 'Host link',
    mbps: vantage?.linkMbit ?? null,
    observedAt: vantage?.ts ?? null,
    kind: 'negotiated',
    stale: vantage === null ? null : isStale(vantage.ts, input.now),
  }

  const test = input.speedTest
  const throughput: RateReading = {
    label: 'Last speed test',
    // A failed run measured nothing. Its numbers are null on the wire and stay null here.
    mbps: test !== null && test.ok ? test.downloadMbps : null,
    observedAt: test?.ts ?? null,
    kind: 'measured',
    // Deliberately null: the speed test runs hourly, so the two-probe-cycle staleness rule the
    // rest of the dashboard uses would mark every healthy run stale. Its age is stated instead.
    stale: null,
  }

  // Distinguished from a router that answered with no line reading: one is a hole in this page,
  // the other is a fact about the poller. Collapsing them would report a failed fetch of our own
  // API as a statement about the carrier.
  if (input.router === null) {
    return {
      carrier,
      host,
      throughput,
      hostVsCarrierPct: null,
      refusal:
        'The router snapshot has not been read, so the carrier side is unknown. That is a gap in this page, not a reading about the line.',
    }
  }

  if (carrier.mbps === null || host.mbps === null) {
    const missing = carrier.mbps === null ? 'The carrier reading' : 'The host link speed'
    return {
      carrier,
      host,
      throughput,
      hostVsCarrierPct: null,
      refusal: `${missing} is absent, so there is nothing to compare. Absent is not zero and not equal.`,
    }
  }

  // Deliberately NOT `carrier.stale`. `stale` answers "is this reading still current?", which the
  // server derives from the poll cadence (two intervals) — so when the router poll moved from 5 to
  // 10 minutes, the tolerance here silently doubled from 10 to 20 minutes without anyone deciding
  // it. That is a different question from the one this ratio asks, which is "do these two readings
  // describe the same moment?", and the answer to that does not depend on how often we happen to
  // poll. Bounded absolutely instead, so a cadence change can never move it again.
  if (
    !withinComparableWindow(carrier.observedAt, input.now) ||
    !withinComparableWindow(host.observedAt, input.now) ||
    host.stale === true
  ) {
    return {
      carrier,
      host,
      throughput,
      hostVsCarrierPct: null,
      refusal: `No ratio: the carrier reading is ${ageMinutes(carrier.observedAt, input.now)} min old and the host reading ${ageMinutes(host.observedAt, input.now)} min old. Dividing one by the other would describe two different moments as one disagreement.`,
    }
  }

  return {
    carrier,
    host,
    throughput,
    hostVsCarrierPct: (host.mbps / carrier.mbps) * 100,
    refusal: null,
  }
}

/**
 * What one bucket of the link-speed strip shows.
 *
 * A bucket holding more than one link speed is a **transition**, not a value: the NIC renegotiated
 * inside it, and averaging 1000 and 100 into 550 draws a rate the line never ran at. The strip
 * marks it and lists what was seen instead.
 */
export type LinkBucketState =
  | { kind: 'unmeasured' }
  | { kind: 'no-vantage'; cycles: number }
  | { kind: 'steady'; mbit: number }
  | { kind: 'transition'; mbits: number[] }

export function linkBucketState(bucket: VantageBucket | null): LinkBucketState {
  if (bucket === null) return { kind: 'unmeasured' }
  const mbits = bucket.linkMbits
  // Cycles ran here and none of them reported a link speed. Distinct from `unmeasured`: something
  // was measured, just not this, and painting it as a speed of any kind would invent one.
  if (mbits.length === 0) return { kind: 'no-vantage', cycles: bucket.cycles }
  const only = mbits[0]
  if (mbits.length === 1 && only !== undefined) return { kind: 'steady', mbit: only }
  return { kind: 'transition', mbits: mbits.toSorted((a, b) => a - b) }
}

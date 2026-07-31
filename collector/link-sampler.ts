/**
 * Watches the physical link state of one interface at 1 Hz, so a flap shorter
 * than a probe cycle stops being invisible.
 *
 * The gap this closes is measured, not hypothetical: on 2026-07-30 macOS's own
 * log carried ten `hasLink: false` lines for en0 in four clusters — one of them
 * a continuous 14.3 s down state (12:09:08.735 → 12:09:23.041 UTC) sitting
 * *inside* a 90 s WAN outage already on record — while `select count(*) from
 * event` was 0. `diffVantage` compares 30 s snapshots, so a flap that restores
 * to the same media token cannot produce an event there by construction.
 *
 * **The resolution limit, which must never be softened into a claim of
 * stability.** 1 Hz sampling resolves transitions of roughly 2 s and longer.
 * The 14.3 s state above would have produced ~14 samples; three of the four
 * clusters were single log lines and may well be sub-second, and this sampler
 * would miss them entirely. An empty `transitions` array therefore means "no
 * transition longer than the sampling resolution was observed" — never "the
 * link was stable". Every consumer inherits that sentence.
 *
 * **Mechanism, and why not the alternatives.** `ifconfig <if>` once a second
 * from inside the already long-lived collector process: measured at 1.71 ms per
 * spawn on this host (120 iterations, 205.1 ms total) = 0.17 % of one core, and
 * a public, stable BSD interface.
 * - `route -n monitor` is *not* a substitute. It runs unprivileged and streams
 *   timestamped messages, but a 45 s capture here produced only
 *   RTM_MISS/RTM_ADD/RTM_DELETE/RTM_GET and no RTM_IFINFO at all, so it is
 *   unverified for link transitions — and it prints MAC addresses in the clear.
 * - `log show --predicate '… hasLink …'` is not either: a one-day scan exceeded
 *   120 s on this host, and the message it matches is a private Apple debug
 *   string that can vanish in any OS update.
 * - A second launchd job was rejected too: this process is already long-lived,
 *   a second plist doubles the install surface, and it would not inherit the
 *   spool that keeps a failed POST from becoming a fake outage.
 *
 * **`ifconfig` prints `ether <MAC>` on its third line, and this repo is
 * public.** The output goes straight into `parseIfconfigStatus` and is never
 * logged, spooled, stored or returned; committed fixtures have that line
 * removed outright rather than scrubbed.
 *
 * Dependency-free like the rest of collector/ (see probe.ts's header): no npm
 * imports, no src/config.ts, nothing that pulls in elysia/drizzle/zod.
 */

/** What one `ifconfig` read said. `unknown` is a missed sample, not a state. */
export type LinkStatus = 'active' | 'inactive' | 'unknown'

/**
 * The `status:` line, anchored and whole-token. Anchoring keeps the parser from
 * reading a status word out of some other line's tail; `\S+` keeps a two-word
 * status from silently matching only its first word.
 */
const STATUS_LINE = /^\s*status:\s*(\S+)\s*$/m

/**
 * Parses ONLY the `status:` line of `ifconfig <if>`. Everything else in that
 * output — the hardware address above all — is deliberately ignored.
 *
 * Anything that is not literally `active` or `inactive`, including an absent
 * line (loopback and tunnels print none) and a status this parser has never
 * seen, is `unknown`. Guessing which side of the link an unrecognised token
 * falls on is exactly the fabrication this module exists to avoid.
 */
export function parseIfconfigStatus(output: string): LinkStatus {
  const token = STATUS_LINE.exec(output)?.[1]
  if (token === 'active') return 'active'
  if (token === 'inactive') return 'inactive'
  return 'unknown'
}

/** One observed link transition. `ts` is when the sampler *saw* it, unix ms. */
export interface LinkTransition {
  ts: number
  state: 'up' | 'down'
}

export interface LinkSampler {
  start(): void
  stop(): void
  /**
   * Transitions observed since the last drain, and how many seconds of
   * sampling actually happened. Both are cleared by the call.
   */
  drain(): { transitions: LinkTransition[]; watchedS: number }
}

/**
 * How ticks are scheduled. Injected (ports-and-adapters,
 * rules/code-style.md) so the sampler's state machine is testable without
 * spending real seconds on a 1 Hz clock.
 */
export interface TickScheduler {
  /** Run `tick` every `intervalMs`; the returned function cancels it. */
  start(intervalMs: number, tick: () => Promise<void>): () => void
}

export interface LinkSamplerOptions {
  iface: string
  intervalMs?: number
  /**
   * Upper bound for `watchedS`, in seconds — the caller's cycle length. A cycle
   * that overruns slightly (a slow POST, a spool replay) would otherwise report
   * more seconds of coverage than the cycle it is attached to has, and
   * `probe_cycle.link_watch_s` is read as a fraction of the cycle. Unset means
   * no clamp.
   */
  maxWatchS?: number
  /** Test seam: how one sample is read. Defaults to spawning `ifconfig`. */
  readStatus?: (iface: string) => Promise<LinkStatus>
  /** Test seam: the clock transitions are timestamped against. */
  now?: () => number
  /** Test seam: see TickScheduler. */
  scheduler?: TickScheduler
}

const DEFAULT_INTERVAL_MS = 1000

/**
 * Mirrors the `.max(120)` on `POST /api/probes`' `linkEvents`. A 30 s cycle at
 * 1 Hz cannot produce more than ~30 transitions, so this only bites when a
 * cycle overruns badly — and there it must bite here rather than at the server,
 * where an over-long array 422s the whole batch and takes four real probe
 * samples down with a coverage detail. The earliest transitions are kept: the
 * onset of a flap storm is the part worth having.
 */
const MAX_BUFFERED_TRANSITIONS = 120

/**
 * A wedged `ifconfig` must not hold a tick open forever. Generous relative to
 * the 1.71 ms this actually takes; the in-flight guard below is what keeps
 * spawns from piling up in the meantime.
 */
const SPAWN_TIMEOUT_MS = 2000

const intervalScheduler: TickScheduler = {
  start(intervalMs, tick) {
    const timer = setInterval(() => {
      void tick()
    }, intervalMs)
    return () => clearInterval(timer)
  },
}

/**
 * `ifconfig <if>` → its status line, or `unknown` on every failure path: spawn
 * error, timeout, an interface that has gone away, output that parses to
 * nothing. A failed read is a missed sample and is counted as one; it is never
 * a link state. The exit code is ignored on purpose, the same way the ping
 * parser ignores ping's (see collector/probe.ts): output is the measurement.
 */
async function readIfconfigStatus(iface: string): Promise<LinkStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const proc = Bun.spawn(['ifconfig', iface], { stdout: 'pipe', stderr: 'ignore' })
    // `stderr: 'ignore'` rather than 'pipe', same as vantage.ts's runCommand:
    // an unread pipe can wedge a chatty command and nothing here reads it.
    timer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS)
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return parseIfconfigStatus(stdout)
  } catch {
    return 'unknown'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The sampler itself. Never throws: it runs inside the collector's cycle loop,
 * and a watcher that can kill the process it rides on would cost the uptime
 * record to protect a coverage counter.
 */
export function createLinkSampler(options: LinkSamplerOptions): LinkSampler {
  const { iface } = options
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const maxWatchS = options.maxWatchS
  const readStatus = options.readStatus ?? readIfconfigStatus
  const now = options.now ?? Date.now
  const scheduler = options.scheduler ?? intervalScheduler

  let cancel: (() => void) | null = null
  let inFlight = false
  /** The last status actually read. `null` = no baseline yet, never a state. */
  let lastKnown: 'active' | 'inactive' | null = null
  let transitions: LinkTransition[] = []
  let watchedTicks = 0

  async function tick(): Promise<void> {
    // A tick still waiting on its spawn is a missed sample, not a reason to
    // queue a second one — piling spawns up behind a wedged `ifconfig` would
    // turn a 1 Hz watcher into a fork bomb. Nothing was read, so nothing is
    // counted against watchedS either.
    if (inFlight) return
    inFlight = true
    let status: LinkStatus
    try {
      status = await readStatus(iface)
    } catch {
      status = 'unknown'
    } finally {
      inFlight = false
    }

    // Unknown does not advance the baseline. Treating "could not read" as a
    // state would emit a transition on the way in and another on the way out,
    // inventing two events out of one failed spawn.
    if (status === 'unknown') return
    watchedTicks += 1

    const previous = lastKnown
    lastKnown = status
    // A null → value step is the baseline being established, which is silence —
    // exactly how diffVantage already treats the same shape. There is nothing
    // this could be a transition *from*.
    if (previous === null || previous === status) return
    if (transitions.length >= MAX_BUFFERED_TRANSITIONS) return
    transitions.push({ ts: now(), state: status === 'active' ? 'up' : 'down' })
  }

  return {
    start(): void {
      if (cancel !== null) return
      cancel = scheduler.start(intervalMs, tick)
    },

    stop(): void {
      cancel?.()
      cancel = null
      // The baseline is dropped, not kept: after a gap in sampling, the state
      // read before the gap is not something the next read can be diffed
      // against. Keeping it would emit a transition stamped at resume time for
      // a change that happened at an unknown instant inside the gap.
      lastKnown = null
    },

    drain(): { transitions: LinkTransition[]; watchedS: number } {
      const sampledS = watchedTicks * (intervalMs / 1000)
      // Rounded because probe_cycle.link_watch_s is an integer column and the
      // ingest schema types it `int`: a fractional value would 422 the whole
      // batch and lose four real probe samples over a coverage counter.
      const watchedS = Math.round(maxWatchS === undefined ? sampledS : Math.min(sampledS, maxWatchS))
      const drained = transitions
      transitions = []
      watchedTicks = 0
      return { transitions: drained, watchedS }
    },
  }
}

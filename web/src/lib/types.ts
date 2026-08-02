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

/** `HomeLineVerdictSchema` in `src/routes/probes.ts` (and the same four values on
 * `RangeSummarySchema.onHomeLine` in `src/routes/outages.ts`).
 *
 * `all` — every recorded cycle reported `on_home_line = 1`.
 * `none` — every recorded cycle reported 0: this window did not measure the home line.
 * `unknown` — no cycle reported it at all.
 * `mixed` — anything else, *including* reported cycles alongside unreported ones.
 *
 * Only `all` claims the whole window. **Never treat `unknown` as `all`** — an unreported
 * vantage is not evidence that the measurement went out over the home line, and painting it
 * as one is exactly the fabrication `probe_cycle` exists to prevent. */
export type HomeLineVerdict = 'all' | 'none' | 'mixed' | 'unknown'

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

/** One bucket of `GET /api/throughput` — how much the line actually carried, differenced from
 * `probe_cycle`'s cumulative interface counters.
 *
 * `spanMs` is the measured time behind the bytes and is the **only** correct denominator for a
 * rate. The bucket's own width is not: a bucket may have measured a fraction of itself, and
 * dividing by the slot understates the rate most severely exactly when the collector was
 * struggling — turning a measurement problem into an apparent traffic collapse.
 *
 * `skipped > 0` means the bucket UNDERSTATES what moved (a reboot reset the counters, the
 * interface changed, or the gap between cycles was too long to place the bytes in time). It never
 * means the line was idle. */
export type ThroughputBucket = {
  bucket: number
  inBytes: number
  outBytes: number
  spanMs: number
  intervals: number
  skipped: number
}

/** `GET /api/throughput`'s envelope. `maxIntervalMs` is the longest cycle-to-cycle gap whose bytes
 * are still attributed to a point in time; anything longer counts toward `skipped`. */
export type ThroughputResponse = {
  from: number
  to: number
  bucketSeconds: number
  maxIntervalMs: number
  buckets: ThroughputBucket[]
}

/** One entry of `GET /api/probes`'s parallel `vantage[]` array (`VantageBucketSchema` in
 * `src/routes/probes.ts`) — what the cycles in a bucket measured *through*, not what they
 * measured. It is its own series rather than a member of `ProbeBucket` because the vantage is a
 * property of the cycle: folding it in would repeat it once per target.
 *
 * `cycles` comes from `probe_sample` and `vantageCycles` from `probe_cycle`, so
 * `cycles > 0, vantageCycles = 0` is a real and common state — cycles that were measured by a
 * collector that reported no vantage. That is unknown, not "fine". More than one entry in
 * `pathClasses` or `linkMbits` means the path changed or the NIC renegotiated inside the bucket;
 * neither is ever flattened to a majority. */
export type VantageBucket = {
  bucket: number
  /** Distinct cycle timestamps with probe samples in this bucket. */
  cycles: number
  /** …of which this many recorded a vantage at all. */
  vantageCycles: number
  pathClasses: string[]
  linkMbits: number[]
  pathIfs: string[]
  onHomeLine: HomeLineVerdict
  homeLineCycles: number
  offHomeLineCycles: number
  /** Cycles with no `on_home_line` value. Unknown — never counted as on the home line. */
  unknownHomeLineCycles: number
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

/** `GET /api/outages`'s `summary` (`RangeSummarySchema` in `src/routes/outages.ts`, produced by
 * `rangeSummary` in `src/db/range-summary.ts`). Null on the wire when `from`/`to` were not both
 * given — coverage is meaningless without a window.
 *
 * This is the honesty envelope around any "N minutes of downtime" headline, and every field
 * answers a lie the outage list can tell on its own: `recordedCycles` vs `expectedCycles` against
 * "0 min downtime" over a range the collector wasn't running through; `degradedCycles` against a
 * range of 80%-loss cycles that never reached zero replies and so materialised no outage row;
 * `onHomeLine` against a range measured over Wi-Fi or cellular tethering. Rendering the outage
 * total without this is the lie of omission it exists to close. */
export type RangeSummary = {
  from: number
  to: number
  /** Distinct probe cycles actually recorded in the range. */
  recordedCycles: number
  /** How many the probe cadence should have produced across the whole range. */
  expectedCycles: number
  /** `recordedCycles / expectedCycles × 100`, clamped to 100. **`null` means not expressible**
   * — the range is shorter than one probe cycle, so `expectedCycles` is 0. The server
   * deliberately refuses to emit 0 there; rendering null as 0 would claim a fully-measured
   * window was unmeasured, the same lie inverted. */
  coveragePct: number | null
  /** First/last recorded cycle in the range — null when nothing was recorded. */
  firstTs: number | null
  lastTs: number | null
  /** Cycles where EVERY WAN anchor lost ≥ `degradedLossPct` while no outage row covered them —
   * degradation the outage table structurally cannot show, since it only fires on
   * `received === 0`. The gateway is excluded: gateway loss is a local problem. */
  degradedCycles: number
  /** The threshold `degradedCycles` was counted at (`LINEWATCH_DEGRADED_LOSS_PCT`). */
  degradedLossPct: number
  onHomeLine: HomeLineVerdict
  homeLineCycles: number
  offHomeLineCycles: number
  unknownHomeLineCycles: number
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

/** `detail.source` on a `link_change`, lifted to the top level by `GET /api/events`.
 *
 * The three writers observe the same *kind* of fact at three precisions, and the timeline is
 * misleading unless it says which one it is showing: `vantage-diff` compares two 30 s snapshots, so
 * the transition happened somewhere inside the preceding cycle; `link-sampler` stamps the transition
 * itself to ~1 s; `router-poller` sees the carrier side up to a poll interval late. Typed as a plain
 * `string | null` rather than a union because the wire field is one — a source this build has never
 * heard of must render as itself, not fall into a bucket. **Null is "the writer recorded none"**
 * (every `link_change` written before `vantage-diff` was stamped), never a guess at which it was. */
export type EventSource = string

export type LinewatchEvent = {
  id: number
  ts: number
  kind: EventKind
  source: EventSource | null
  detail: unknown
}

/** `GET /api/events`'s envelope. `linkSamplingSince` is why the array is not returned bare: zero
 * transitions over a watched window is a measurement, zero over an unwatched one is silence, and
 * only this field separates them. Null = no cycle in the window reported `link_watch_s` at all. */
export type EventsResponse = {
  events: LinewatchEvent[]
  linkSamplingSince: number | null
}

export type PathClass = 'ethernet' | 'wifi' | 'cellular' | 'other'
export type LinkDuplex = 'full' | 'half'

/** `GET /api/status`'s `vantage` (`VantageSchema` in `src/routes/status.ts`) — the most recent
 * cycle's view of what it measured *through*: interface, path class, negotiated media/speed/duplex,
 * gateway. Null when no cycle ever reported a vantage.
 *
 * `linkMbit` is the negotiated link speed, and it is the single fact that explains a ~93 Mbps
 * speed-test reading on a line sold as faster: a 100baseTX link cannot carry more, so the number
 * to fix is the link, not the ISP. Every field is nullable because the collector reports what it
 * could parse and nothing more — an unparseable field is absent, never defaulted. */
export type Vantage = {
  ts: number
  pathIf: string | null
  pathClass: PathClass | null
  linkMedia: string | null
  linkMbit: number | null
  linkDuplex: LinkDuplex | null
  /** Fastest speed in the interface's **supported** media list — not the negotiated `linkMbit`.
   * It is what separates "the NIC can only do 100" from "the NIC can do 1000 and negotiated 100":
   * a Thunderbolt adapter in the first case, a cable or a switch port in the second. Null when the
   * collector could not parse it, and **never an implied 1000** — that default would fabricate a
   * cable fault out of a NIC that never had one. */
  linkMaxMbit: number | null
  /** Unix ms of the DHCP lease start on `pathIf` — an absolute instant the OS carries forward, so
   * one sample dates the last re-bind retroactively. A *change* proves a re-bind; an unchanged
   * value proves nothing about link stability (two link-downs on this host left it untouched). */
  dhcpBoundAt: number | null
  gatewayAddr: string | null
  /** true = Ethernet through the configured home gateway; false = some other path;
   * **null = not reported, i.e. UNKNOWN**. Never render null as true. */
  onHomeLine: boolean | null
  /** Seconds of this 30 s cycle the collector's 1 Hz link sampler actually watched. Positive
   * coverage is what licenses reading "no `link_change` event" as "no transition above ~2 s";
   * null means nothing watched the link, so the absence of events says nothing. */
  linkWatchS: number | null
}

/** `GET /api/status` — "is it working right now", answered in one payload. `ongoingOutages` is an
 * array because a gateway outage and a WAN outage can be open at the same time; `lastSamples` is
 * an array (one entry per target that has ever reported), not a record keyed by target. */
export type StatusResponse = {
  up: boolean
  /** Newest `probe_sample` ts — how fresh this whole answer is. `up` is a statement about the
   * outage table, not the line: with no ingest no outage row can open, so a dead collector leaves
   * `up: true` standing forever. Check this age before believing `up`. */
  newestSampleTs: number | null
  /** A speed test is saturating the line right now, from the runner's in-process guard. Never
   * inferred from the newest `speed_test` row — that row is written when a run *ends*. */
  speedtestRunning: boolean
  ongoingOutages: OngoingOutage[]
  lastSamples: StatusSample[]
  lastSpeedTest: StatusSpeedTest | null
  vantage: Vantage | null
}

/**
 * The per-part observation envelope every member of `GET /api/router` carries (`observation()` in
 * `src/routes/router.ts`). It is a type, not a convenience unwrap, because the whole point is that
 * the parts age independently: a poll where one OID is refused writes some tables and not others,
 * and during a WAN outage no `role: wan` row is written at all while the LAN bridge keeps
 * updating. Flattening `value` out of the envelope presents a two-hour-old sync rate as a current
 * reading, which is the router-side version of this project's central bug.
 *
 * `observedAt`/`ageMs` are typed nullable although the server populates both whenever the part
 * exists at all (a missing part is `null` as a whole). Nullable so a future partial envelope
 * cannot be read as "observed at epoch, age 0" — an absent age must never render as fresh.
 */
export type RouterPart<T> = {
  observedAt: number | null
  ageMs: number | null
  /** True when `ageMs` exceeds `staleAfterMs` (two poll intervals): the value is history. */
  stale: boolean
  value: T | null
}

/** `LineSampleSchema` in `src/routes/router.ts` — the carrier-side line reading. Noise margins are
 * real dB (the router reports tenths; the poller converts at the write site). */
export type RouterLineSample = {
  id: number
  ts: number
  carrier: 'gfast' | 'dsl' | 'gpon' | null
  status: string | null
  downSyncKbps: number | null
  upSyncKbps: number | null
  downCurrKbps: number | null
  upCurrKbps: number | null
  downNoiseMarginDb: number | null
  upNoiseMarginDb: number | null
  downAttenuationDb: number | null
  profile: string | null
  /** Seconds since the line last entered showtime — a drop means the line resynced. */
  showtimeStartS: number | null
  erroredSecs: number | null
  severelyErroredSecs: number | null
}

export type RouterIntfRole = 'wan' | 'lan' | 'other'

/** `IntfSampleSchema` in `src/routes/router.ts`. On the `wan` row `rxKbps` is the downstream
 * direction. */
export type RouterIntfSample = {
  id: number
  ts: number
  name: string
  stack: number | null
  role: RouterIntfRole | null
  rxKbps: number | null
  txKbps: number | null
  bytesRx: number | null
  bytesTx: number | null
}

/** `EthPortSchema` in `src/routes/router.ts` — one LAN port from the latest poll. `maxBitRate` is
 * the router's side of the same negotiation `Vantage.linkMbit` reports from the host's side. */
export type RouterEthPort = {
  id: number
  ts: number
  name: string | null
  alias: string | null
  status: string | null
  maxBitRate: number | null
  duplexMode: string | null
}

/** `HostSchema` in `src/routes/router.ts` — the router's own view of the collector host: is this
 * address still attached, over which medium, and how fresh is that. No MAC and no device name:
 * no schema table stores either, and this router's default names are MACs with the separators
 * stripped (see CLAUDE.md — this is a public repo). */
export type RouterHost = {
  id: number
  ts: number
  ip: string | null
  interfaceType: string | null
  active: number | null
  clientType: string | null
}

/** `GET /api/router` — the latest reading of each part, each with its own staleness envelope.
 * `pollerEnabled: false` with a `disabledReason` is a normal state (no router password
 * configured), and it is not the same as "the router is unreachable": one means nothing was
 * asked, the other means nothing answered. `configWarning` is separate because the poller runs
 * with a fallback schedule when the cron pattern is unparseable — degraded, not off. */
export type RouterSnapshot = {
  pollerEnabled: boolean
  disabledReason: string | null
  configWarning: string | null
  collectorHostIp: string
  pollIntervalMs: number
  /** The server's clock when the snapshot was taken — the reference every `ageMs` is against. */
  now: number
  staleAfterMs: number
  line: RouterPart<RouterLineSample> | null
  wan: RouterPart<RouterIntfSample> | null
  lan: RouterPart<RouterIntfSample> | null
  collectorHost: RouterPart<RouterHost> | null
  ports: RouterPart<RouterEthPort[]> | null
}

export type Severity = 'critical' | 'warn' | 'info' | 'ok'

/** One cited number behind a verdict (`src/lib/verdict.ts`). */
export type Evidence = {
  label: string
  value: string
}

/** `GET /api/verdicts`'s items — the rule engine's output (`src/lib/verdict.ts`), never an LLM and
 * never a literal authored in a component.
 *
 * `evidence` is mandatory and non-empty by construction: a verdict that cannot cite its numbers
 * cannot be built, so the UI can render it unconditionally. `uncertainty` is set when a rule
 * withheld a cause — typically because the host link sampler did not cover enough of the window
 * to rule out a link transition inside it. **The UI must render `uncertainty`, never swallow
 * it**: a conclusion shown without its caveat is an inference presented as a measurement.
 *
 * **There is no `title`/headline field on the wire.** Neither the server's `Verdict` interface
 * (`src/lib/verdict.ts`) nor `src/routes/verdict.ts` emits one — a client type that declared it
 * anyway is exactly how this shipped: `fetchJson<T>` casts the response instead of validating it,
 * so nothing caught the mismatch, and every headline in the verdict band rendered as an empty
 * string. The fix is not a second authored sentence per rule (thirteen more strings that can drift
 * from the numbers they describe, on top of the ban on authoring line-about-the-line prose in a
 * component) — it is using `conclusion` as the headline. See `verdict-panel.tsx`. */
export type Verdict = {
  /** The rule that fired. An identifier, not a label — a per-row rule emits one verdict per row,
   * so it is not unique either. Render `conclusion`; showing this puts a slug where the headline
   * goes. */
  id: string
  severity: Severity
  /** One sentence, templated server-side from the live inputs. Doubles as the headline — see the
   * type doc above. */
  conclusion: string
  evidence: Evidence[]
  action: string | null
  uncertainty: string | null
}

#!/usr/bin/env bun
/**
 * The watchdog runner: gather evidence → `decide()` → persist → perform →
 * record → report. A thin shell around a pure function, and thin on purpose.
 *
 * Every judgement lives in `watchdog-ladder.ts`, including the state
 * transitions — this file contains no thresholds, no budgets and no
 * preconditions, so there is nothing here to disagree with the tests. What it
 * does own is I/O, and the three rules that shape all of it:
 *
 * 1. **The write-ahead is durable before the action leaves the process.**
 *    `decide()` returns the ledger with a `pending` entry already in it; that
 *    is fsynced, *then* the executor is called, *then* `recordOutcome` closes
 *    it. A crash in the middle is reconciled on the next boot as having fired.
 *    The deliberate inverse of the probe spool: a probe batch is idempotent, a
 *    router reboot is not.
 *
 * 2. **Two spools, because they drain over different networks.** Events go to
 *    localhost, which is usually up during a WAN outage. Notifications go to
 *    Uptime Kuma across the WAN, which is by definition down exactly when
 *    there is something to say. A delayed notification carries `delayedMs` and
 *    its original timestamp so it can never arrive looking live.
 *
 * 3. **It runs `decide()` every tick regardless.** This code fires in anger
 *    about once a month — the database holds one event in its whole history
 *    that would have triggered it. Code that rare is stale when it fires, so
 *    the decision executes 5760 times a day in dry run against real evidence,
 *    and a defect in it surfaces as a wrong log line rather than as a wrong
 *    reboot.
 *
 * ## Why a daemon rather than launchd's `StartInterval`
 *
 * The opposite of `heartbeat.ts`, and for the opposite reason. That one is a
 * one-shot because a crash there should cost one heartbeat. Here, the ladder's
 * confirmation counting and the process-age floor are both statements about
 * continuity — "this process has itself watched N consecutive ticks" — which a
 * fresh process per tick cannot make. So: `KeepAlive`, and `minProcessAgeS`
 * turns a crash loop into a permanent stand-down instead of a fire loop.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LOG_MAX_BYTES, rotateLogIfNeeded } from './log-rotate.js'
import { parsePingOutput } from './ping-parser.js'
import { captureVantage } from './vantage.js'
import {
  classify,
  decide,
  DEFAULT_POLICY,
  recordOutcome,
  type AnchorState,
  type CarrierEvidence,
  type LadderOutcome,
  type Ledger,
  type RecordEvidence,
  type SelfEvidence,
  type WatchdogPolicy,
} from './watchdog-ladder.js'
import { eventKindFor, ledgerOutcome, markDelay, notificationMessage, notificationStatus } from './watchdog-report.js'
import { DEFAULT_DISARM_PATH, DEFAULT_LEDGER_PATH, isDisarmed, readLedger, writeLedger } from './watchdog-state.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))

interface Target {
  name: string
  addr: string
  scope: 'gateway' | 'wan'
}

const DEFAULT_TARGETS: Target[] = [
  { name: 'gateway', addr: '192.168.1.1', scope: 'gateway' },
  { name: 'cloudflare', addr: '1.1.1.1', scope: 'wan' },
  { name: 'google', addr: '8.8.8.8', scope: 'wan' },
  { name: 'quad9', addr: '9.9.9.9', scope: 'wan' },
]

/** Same format the collector and the server both parse. One string, three readers, no drift. */
function parseTargets(raw: string | undefined): Target[] {
  if (!raw) return DEFAULT_TARGETS
  return raw.split(',').map((entry) => {
    const [name, addr, scope] = entry.trim().split(':')
    if (!name || !addr || (scope !== 'gateway' && scope !== 'wan')) {
      throw new Error(`invalid LINEWATCH_TARGETS entry "${entry}" (want "name:addr:gateway|wan")`)
    }
    return { name, addr, scope }
  })
}

const TOKEN_FILE_PATH = join(homedir(), '.config', 'linewatch', 'token')

function resolveToken(): string {
  const envToken = process.env['LINEWATCH_TOKEN']
  if (envToken) return envToken
  if (existsSync(TOKEN_FILE_PATH)) {
    const fileToken = readFileSync(TOKEN_FILE_PATH, 'utf-8').trim()
    if (fileToken) return fileToken
  }
  throw new Error(`No bearer token: set LINEWATCH_TOKEN or write one to ${TOKEN_FILE_PATH} (chmod 600).`)
}

function envFlag(name: string): boolean {
  return process.env[name] === '1'
}

const config = {
  apiUrl: process.env['LINEWATCH_API_URL'] ?? 'http://localhost:7731',
  token: resolveToken(),
  targets: parseTargets(process.env['LINEWATCH_TARGETS']),
  /**
   * An IPv6 anchor, and the reason the ladder can tell `v4_only_down` from a
   * full failure. A reachable v6 anchor proves the line is in showtime, the
   * session is established and the ISP is forwarding — every layer a reboot
   * could fix is demonstrably working — which is why that class defers the
   * reboot rung instead of taking it.
   */
  v6Target: process.env['LINEWATCH_WATCHDOG_V6_TARGET'] ?? '2606:4700:4700::1111',
  /** Three, not the collector's twenty: this runs every 15 s and only needs up-or-down. */
  pingCount: Number(process.env['LINEWATCH_WATCHDOG_PING_COUNT'] ?? 3),
  pingIntervalSeconds: Number(process.env['LINEWATCH_WATCHDOG_PING_INTERVAL_S'] ?? 0.2),
  ledgerPath: process.env['LINEWATCH_WATCHDOG_STATE_PATH'] ?? DEFAULT_LEDGER_PATH,
  disarmPath: process.env['LINEWATCH_WATCHDOG_DISARM_PATH'] ?? DEFAULT_DISARM_PATH,
  eventSpoolPath: process.env['LINEWATCH_WATCHDOG_EVENT_SPOOL'] ?? join(moduleDir, 'watchdog-events.jsonl'),
  notifySpoolPath: process.env['LINEWATCH_WATCHDOG_NOTIFY_SPOOL'] ?? join(moduleDir, 'watchdog-notify.jsonl'),
  spoolMaxLines: 10_000,
  pushUrlFile: process.env['LINEWATCH_WATCHDOG_PUSH_URL_FILE'] ?? join(homedir(), '.config', 'uptime-kuma', 'linewatch-watchdog-push-url'),
  /** Well inside the monitor's own interval, the same margin the line heartbeat keeps. */
  notifyIntervalMs: Number(process.env['LINEWATCH_WATCHDOG_NOTIFY_MS'] ?? 60_000),
  apiTimeoutMs: Number(process.env['LINEWATCH_WATCHDOG_API_TIMEOUT_MS'] ?? 5_000),
  pushTimeoutMs: Number(process.env['LINEWATCH_WATCHDOG_PUSH_TIMEOUT_MS'] ?? 10_000),
  logPath: process.env['LINEWATCH_WATCHDOG_LOG_PATH'] ?? join(homedir(), 'Library', 'Logs', 'linewatch-watchdog.log'),
  logMaxBytes: Number(process.env['LINEWATCH_WATCHDOG_LOG_MAX_BYTES'] ?? DEFAULT_LOG_MAX_BYTES),
  /** `make watchdog-status`: one tick, printed, nothing persisted and nothing pushed. */
  once: envFlag('LINEWATCH_WATCHDOG_ONCE'),
}

/**
 * Two switches, and they are not redundant.
 *
 * `armed` decides whether an authorised rung is *performed* at all. Off, the
 * machine still walks the whole ladder and writes `would_*` notes — which is
 * the only thing that makes a shadow run worth the two weeks it takes.
 *
 * `rebootEnabled` and `rebootOnV4Only` gate the destructive rung specifically,
 * and stay off until a reboot's success can be told from its failure in the
 * record rather than in the reply.
 */
const policy: WatchdogPolicy = {
  ...DEFAULT_POLICY,
  armed: envFlag('LINEWATCH_WATCHDOG_ARMED'),
  rebootEnabled: envFlag('LINEWATCH_WATCHDOG_REBOOT'),
  rebootOnV4Only: envFlag('LINEWATCH_WATCHDOG_REBOOT_V4_ONLY'),
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${config.apiUrl}${path}`, { signal: AbortSignal.timeout(config.apiTimeoutMs) })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

interface StatusPayload {
  up: boolean
  newestSampleTs: number | null
  speedtestRunning: boolean
  ongoingOutages: Array<{ scope: 'gateway' | 'wan'; startedAt: number; cycles: number; evidence: string[] }>
  lastSamples: Array<{ target: string; scope: 'gateway' | 'wan'; received: number }>
  vantage: { onHomeLine: boolean | null; pathClass: string | null; gatewayAddr: string | null; linkWatchS: number | null } | null
}

/**
 * The record's view. Null when `GET /api/status` could not be read *or* has
 * never seen a sample: an answer with `newestSampleTs: null` carries `up: true`
 * and nothing behind it, and treating that as evidence of a healthy line is
 * exactly the failure the field was added to expose.
 */
async function fetchRecord(): Promise<RecordEvidence | null> {
  const status = await getJson<StatusPayload>('/api/status')
  if (status === null || status.newestSampleTs === null) return null

  const wanOutage = status.ongoingOutages.find((outage) => outage.scope === 'wan') ?? null
  const gatewayOutage = status.ongoingOutages.find((outage) => outage.scope === 'gateway') ?? null
  const gateway = status.lastSamples.find((sample) => sample.scope === 'gateway') ?? null

  return {
    newestSampleTs: status.newestSampleTs,
    ongoingWanOutage: wanOutage === null ? null : { startedAt: wanOutage.startedAt, cycles: wanOutage.cycles, evidence: wanOutage.evidence },
    ongoingGatewayOutage: gatewayOutage === null ? null : { startedAt: gatewayOutage.startedAt },
    gateway: gateway === null ? null : { target: gateway.target, received: gateway.received },
    wanAnchors: status.lastSamples.filter((sample) => sample.scope === 'wan').map((sample) => ({ target: sample.target, received: sample.received })),
    onHomeLine: status.vantage?.onHomeLine ?? null,
    pathClass: status.vantage?.pathClass ?? null,
    gatewayAddr: status.vantage?.gatewayAddr ?? null,
    linkWatchS: status.vantage?.linkWatchS ?? null,
    speedtestRunning: status.speedtestRunning,
  }
}

async function ping(addr: string, name: string, v6: boolean): Promise<AnchorState> {
  const binary = v6 ? 'ping6' : 'ping'
  const args = [binary, '-c', String(config.pingCount), '-i', String(config.pingIntervalSeconds), addr]
  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
    const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    // 100% loss exits non-zero and prints no round-trip summary. That is a
    // valid measurement, not an error, so the exit code is never consulted.
    return { target: name, received: parsePingOutput(out).received }
  } catch {
    return { target: name, received: 0 }
  }
}

/**
 * The watchdog's own eyes, taken independently of the collector.
 *
 * Independent on purpose: the collector and the record share a failure mode —
 * a dead collector leaves the record frozen and cheerful — and a watchdog that
 * only reads the record would inherit it. Two sources also let the ladder
 * refuse to act when they disagree, which is what keeps a single flaky
 * observer from causing a reboot.
 */
async function probeSelf(): Promise<SelfEvidence | null> {
  const gatewayTarget = config.targets.find((target) => target.scope === 'gateway') ?? null
  if (gatewayTarget === null) return null

  const wanTargets = config.targets.filter((target) => target.scope === 'wan')
  const [gateway, wanAnchors, v6, vantage] = await Promise.all([
    ping(gatewayTarget.addr, gatewayTarget.name, false),
    Promise.all(wanTargets.map((target) => ping(target.addr, target.name, false))),
    ping(config.v6Target, 'v6', true),
    captureVantage({ expectedGateway: gatewayTarget.addr }),
  ])

  return {
    probeTs: Date.now(),
    gateway,
    wanAnchors,
    v6,
    onHomeLine: vantage.onHomeLine,
    pathClass: vantage.pathClass,
    gatewayAddr: vantage.gatewayAddr,
  }
}

interface RouterPayload {
  writeEnabled: boolean
  staleAfterMs: number
  now: number
  line: { ageMs: number; stale: boolean; value: { status: string | null; showtimeStartS: number | null } } | null
}

/**
 * The carrier side. **It may veto or delay a rung; it may never permit one.**
 * The poller stores well under all of its due polls, so a ladder gated on fresh
 * carrier evidence would have been inert for the entire actionable window of
 * the one event this exists for. Silence here is not evidence of anything, and
 * a failed read returns null rather than a pessimistic reading.
 */
async function fetchCarrier(): Promise<{ carrier: CarrierEvidence | null; writeEnabled: boolean }> {
  const router = await getJson<RouterPayload>('/api/router')
  if (router === null) return { carrier: null, writeEnabled: false }
  const writeEnabled = router.writeEnabled
  if (router.line === null) return { carrier: null, writeEnabled }
  return {
    carrier: {
      stale: router.line.stale,
      lineStatus: router.line.value.status,
      showtimeStartS: router.line.value.showtimeStartS,
      freshPollAgeS: Math.floor(router.line.ageMs / 1000),
    },
    writeEnabled,
  }
}

interface EventsPayload {
  events: Array<{ ts: number; kind: string; source: string | null }>
}

/**
 * The newest *human* intervention. A person who has told us they are working on
 * it gets a quiet period, and there is no other way to know: the router allows
 * one admin session, but its poll-failure pattern runs unbroken all night with
 * nobody present, so poll failures are not a presence signal.
 *
 * The watchdog's own interventions are excluded by `source`, or it would stand
 * itself down for half an hour after every action it took.
 */
async function fetchLastHumanIntervention(now: number): Promise<number | null> {
  const from = now - policy.humanQuietS * 1000
  const payload = await getJson<EventsPayload>(`/api/events?kind=intervention&from=${from}`)
  if (payload === null) return null
  const human = payload.events.filter((entry) => entry.source !== 'watchdog').map((entry) => entry.ts)
  return human.length === 0 ? null : Math.max(...human)
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

interface SpooledEvent {
  ts: number
  action: string
  kind: 'intervention' | 'note'
  note: string
  detail: Record<string, unknown>
}

function appendSpool(path: string, line: unknown): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(line)}\n`)
    return true
  } catch {
    return false
  }
}

function readSpool<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T)
}

function rewriteSpool(path: string, lines: unknown[]): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  renameSync(tmp, path)
}

/**
 * The `canRecord` precondition, answered by actually doing it rather than by
 * checking whether it looks possible.
 *
 * No attribution means no action. An action that fired without being written
 * down leaves a record showing an outage that ended on its own — verbatim the
 * failure `POST /api/interventions` exists to prevent, which already happened
 * once to a human, and it is worse when the actor is a machine that will do it
 * again next month.
 */
function canRecord(): boolean {
  try {
    mkdirSync(dirname(config.eventSpoolPath), { recursive: true })
    // A zero-byte append: it opens the file for writing and closes it, so it
    // proves the directory, the permissions and a writable filesystem, without
    // putting 5760 probe lines a day into the spool it is testing.
    appendFileSync(config.eventSpoolPath, '')
    return true
  } catch {
    return false
  }
}

async function postEvent(entry: SpooledEvent): Promise<boolean> {
  try {
    const response = await fetch(`${config.apiUrl}/api/interventions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify({
        ts: entry.ts,
        action: entry.action,
        // Never `manual`. A machine action recorded as a human one destroys the
        // attribution the route exists to preserve — six months of "does
        // rebooting actually fix this?" is unanswerable if three real human
        // interventions and forty machine ones are indistinguishable.
        source: 'watchdog',
        kind: entry.kind,
        note: entry.note,
        detail: entry.detail,
      }),
      signal: AbortSignal.timeout(config.apiTimeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Drain the event spool against localhost — usually reachable during a WAN
 * outage, which is the whole reason this spool is separate from the
 * notification one. Stops at the first failure and keeps the remainder, so
 * nothing is dropped and order is preserved.
 */
async function drainEvents(): Promise<void> {
  const spooled = readSpool<SpooledEvent>(config.eventSpoolPath)
  if (spooled.length === 0) return

  for (const [index, entry] of spooled.entries()) {
    if (await postEvent(entry)) continue
    rewriteSpool(config.eventSpoolPath, spooled.slice(index))
    log('event.spool_retained', { remaining: spooled.length - index })
    return
  }
  rewriteSpool(config.eventSpoolPath, [])
}

function record(entry: SpooledEvent): void {
  if (!appendSpool(config.eventSpoolPath, entry)) log('event.spool_failed', { action: entry.action })
}

// ---------------------------------------------------------------------------
// Notification — the watchdog's own Uptime Kuma monitor
// ---------------------------------------------------------------------------

interface Notification {
  ts: number
  status: 'up' | 'down'
  msg: string
}

function resolvePushUrl(): string | null {
  if (!existsSync(config.pushUrlFile)) return null
  const contents = readFileSync(config.pushUrlFile, 'utf-8').trim()
  return contents === '' ? null : contents
}

async function push(baseUrl: string, notification: Notification, now: number): Promise<boolean> {
  const url = new URL(baseUrl)
  url.searchParams.set('status', notification.status)
  url.searchParams.set('msg', markDelay(notification.msg, notification.ts, now))
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(config.pushTimeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

let lastNotifyAt = 0
let warnedNoPushUrl = false

/**
 * The watchdog's own monitor, and it is a second one on purpose.
 *
 * The line monitor is silence-means-down: a home-line outage severs the push
 * and Kuma alerts on the gap. That signal cannot also carry "the watchdog
 * latched itself" or "the ledger is unreadable", because those happen on a
 * *healthy* line where the line monitor is green and staying green. So this one
 * reports the watchdog's own state, and its silence means the watchdog is gone.
 */
async function notify(outcome: LadderOutcome, ledger: Ledger, now: number, force: boolean): Promise<void> {
  if (!force && now - lastNotifyAt < config.notifyIntervalMs) return
  lastNotifyAt = now

  const notification: Notification = {
    ts: now,
    status: notificationStatus(outcome),
    msg: notificationMessage({
      state: outcome.state,
      outageClass: outcome.outageClass,
      action: outcome.action,
      note: outcome.note,
      armed: policy.armed,
      consecutiveActions: ledger.consecutiveActions,
    }),
  }

  const pushUrl = resolvePushUrl()
  if (pushUrl === null) {
    // Once per process. A static misconfiguration repeated 1440 times a day is
    // how the one line that matters gets lost in the log that reports it.
    if (!warnedNoPushUrl) {
      warnedNoPushUrl = true
      log('notify.no_url', { file: config.pushUrlFile, note: 'the watchdog has no way to report itself — a latch or a crash would be invisible on a healthy line' })
    }
    return
  }

  const backlog = readSpool<Notification>(config.notifySpoolPath)
  for (const [index, pending] of backlog.entries()) {
    if (await push(pushUrl, pending, now)) continue
    rewriteSpool(config.notifySpoolPath, backlog.slice(index))
    appendSpool(config.notifySpoolPath, notification)
    return
  }
  if (backlog.length > 0) rewriteSpool(config.notifySpoolPath, [])

  if (!(await push(pushUrl, notification, now))) {
    if (!appendSpool(config.notifySpoolPath, notification)) log('notify.spool_failed', {})
  }
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

interface ActionAnswer {
  ok: boolean
  capability: 'live' | 'null'
  outcome: 'executed' | 'failed' | 'not_executed' | 'refused' | 'unknown'
  detail: string
  steps: unknown[]
}

async function perform(kind: 'reconnect' | 'reboot'): Promise<ActionAnswer | null> {
  try {
    const response = await fetch(`${config.apiUrl}/api/router/actions/${kind}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}` },
      // A reboot kills the device mid-request by design, so this must be able
      // to return without an answer rather than hanging past the settle window.
      signal: AbortSignal.timeout(kind === 'reboot' ? 30_000 : config.apiTimeoutMs),
    })
    if (!response.ok) {
      // 403 is the capability switch, not a failure against the device. Calling
      // it `failed` would count it against the latch, and two of them would
      // self-disarm a watchdog that had never sent anything.
      const outcome = response.status === 403 ? ('not_executed' as const) : ('failed' as const)
      return { ok: false, capability: response.status === 403 ? 'null' : 'live', outcome, detail: `HTTP ${response.status}`, steps: [] }
    }
    return (await response.json()) as ActionAnswer
  } catch (error) {
    // No answer at all. For a reboot that is the expected shape of success; for
    // a reconnect it is genuinely ambiguous. Either way the honest report is
    // `unknown`, which counts against the latch — the ledger must assume the
    // line was touched, because it may have been.
    return { ok: false, capability: 'live', outcome: 'unknown', detail: `no answer: ${error instanceof Error ? error.message : String(error)}`, steps: [] }
  }
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

const processStartedAt = Date.now()
let heldClass: string | null = null
let heldTickCount = 0
let lastReported: string | null = null

/**
 * One evaluation. Never throws: a watchdog that dies on an unexpected shape of
 * evidence is a watchdog that is absent for the month it was built for, and
 * `KeepAlive` restarting it resets the confirmation counters every time.
 */
async function tick(): Promise<void> {
  const now = Date.now()

  const loaded = readLedger(config.ledgerPath)
  if (!loaded.trusted) {
    // An unreadable ledger has unknown budgets, not empty ones. Reading it as
    // empty would return the reboot budget to full and clear a latch a human
    // was meant to clear — and a truncated write is most likely right after a
    // crash, which is exactly when that matters.
    log('ledger.untrusted', { reason: loaded.reason, path: config.ledgerPath })
  }

  const [recordEvidence, self, router, lastHumanInterventionTs] = await Promise.all([
    fetchRecord(),
    probeSelf(),
    fetchCarrier(),
    fetchLastHumanIntervention(now),
  ])

  // Classified once, here, so the confirmation counter counts the same thing
  // the ladder decides on. A second heuristic in this file would be a second
  // implementation of the one piece of judgement the design keeps in one place.
  const armed = policy.armed && loaded.trusted
  const effectivePolicy = { ...policy, armed }
  const evidence = {
    now,
    policy: effectivePolicy,
    record: recordEvidence,
    self,
    carrier: router.carrier,
    ledger: loaded.ledger,
    processStartedAt,
    disarmed: isDisarmed(config.disarmPath),
    // The capability the *executor* actually has, read from the container
    // rather than inferred from this process's environment. The watchdog runs
    // natively under launchd and the executor lives in Docker, so a wrong guess
    // here is the difference between a shadow run reporting suppression and a
    // shadow run reporting an action that never happened.
    capability: (armed && router.writeEnabled ? 'live' : 'null') as 'live' | 'null',
    lastHumanInterventionTs,
    canRecord: canRecord(),
  }
  const outcome = decide({ ...evidence, heldTicks: track(classify({ ...evidence, heldTicks: 0 })) })

  log('tick', {
    state: outcome.state,
    class: outcome.outageClass,
    rung: outcome.rung,
    action: outcome.action,
    shadow: outcome.shadow,
    blockedBy: outcome.blockedBy,
    downForS: outcome.t0 === null ? null : Math.floor((now - outcome.t0) / 1000),
    note: outcome.note,
  })

  if (config.once) {
    await drainEvents()
    return
  }

  // Write-ahead: on the disk, fsynced, before anything can be performed.
  let ledger = outcome.ledger
  writeLedger(ledger, config.ledgerPath)

  if (outcome.action === 'reconnect' || outcome.action === 'reboot') {
    const answer = await perform(outcome.action)
    const resolved = ledgerOutcome(answer)
    ledger = recordOutcome(ledger, {
      ts: now,
      kind: outcome.action,
      outageKey: outcome.outageKey ?? `wan:${now}`,
      outcome: resolved,
    })
    writeLedger(ledger, config.ledgerPath)

    record({
      ts: now,
      action: `watchdog_${outcome.action}`,
      // Only something that reached the line is an intervention. A refusal is a
      // note, or the dashboard would credit the watchdog for a line that fixed
      // itself — the same lie, told about a machine.
      kind: eventKindFor(resolved),
      note: answer?.detail ?? 'no answer from the action route',
      detail: { outcome: resolved, rung: outcome.rung, outageClass: outcome.outageClass, downForS: outcome.t0 === null ? null : Math.floor((now - outcome.t0) / 1000), steps: answer?.steps ?? [] },
    })
    await notify(outcome, ledger, now, true)
    await drainEvents()
    return
  }

  reportIfChanged(outcome, now)
  await notify(outcome, ledger, now, outcome.action === 'escalate' || outcome.state === 'latched')
  await drainEvents()
}

/**
 * Consecutive ticks *this process* has seen the same shape. Deliberately not in
 * the ledger: it is a claim about continuity of observation, and a claim a
 * freshly restarted process is not entitled to make.
 */
function track(current: string): number {
  if (current === heldClass) heldTickCount += 1
  else {
    heldClass = current
    heldTickCount = 1
  }
  return heldTickCount
}

/**
 * Report a state change, not a state. The machine evaluates every 15 s and the
 * `event` table is what the dashboard timeline reads — one row per tick would
 * be 5760 a day, burying the transitions that matter in the steady state that
 * does not.
 */
function reportIfChanged(outcome: LadderOutcome, now: number): void {
  if (outcome.state === 'normal') {
    lastReported = null
    return
  }

  const signature = `${outcome.state}|${outcome.rung}|${outcome.shadow}|${outcome.blockedBy.join(',')}`
  if (signature === lastReported) return
  lastReported = signature

  record({
    ts: now,
    action: outcome.shadow ? `would_${outcome.rung}` : `watchdog_${outcome.state}`,
    // Never `intervention`: nothing here touched the line. A suppressed action
    // recorded as an intervention would credit the watchdog for a recovery it
    // had no part in.
    kind: 'note',
    note: outcome.note,
    detail: {
      state: outcome.state,
      outageClass: outcome.outageClass,
      rung: outcome.rung,
      shadow: outcome.shadow,
      blockedBy: outcome.blockedBy,
      armed: policy.armed,
      downForS: outcome.t0 === null ? null : Math.floor((now - outcome.t0) / 1000),
    },
  })
}

async function main(): Promise<void> {
  if (!config.once) rotateLogIfNeeded({ logPath: config.logPath, maxBytes: config.logMaxBytes, report: log })

  log('watchdog.start', {
    armed: policy.armed,
    rebootEnabled: policy.rebootEnabled,
    rebootOnV4Only: policy.rebootOnV4Only,
    tickMs: policy.tickMs,
    ledgerPath: config.ledgerPath,
    once: config.once,
  })

  if (config.once) {
    await tick()
    return
  }

  for (;;) {
    try {
      await tick()
    } catch (error) {
      // A watchdog that dies on an unexpected evidence shape is absent for the
      // month it exists for, and every restart resets the confirmation counters.
      log('tick.error', { error: error instanceof Error ? error.message : String(error) })
    }
    await Bun.sleep(policy.tickMs)
  }
}

await main()

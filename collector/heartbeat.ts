#!/usr/bin/env bun
/**
 * Pushes one Uptime Kuma heartbeat for the home line. One shot per run —
 * launchd re-runs it on `StartInterval`, so a crash costs one heartbeat instead
 * of killing a daemon and taking the monitor silently offline with it.
 *
 * ## Why a push, and why it is not the collector doing it
 *
 * Uptime Kuma runs on the homelab, on a different WAN, and the Tailscale ACL
 * does not grant `tag:homelab -> tag:mac` — so Kuma cannot probe this line even
 * in principle. The mini reports on itself, and a home-line outage severs that
 * report. Kuma's missed-heartbeat alert *is* the outage alert, and it leaves the
 * homelab over a WAN this outage does not touch.
 *
 * This is a separate LaunchAgent rather than a few lines inside `probe.ts`, for
 * one reason that decides it: if the pusher lived in the collector, a collector
 * crash and a line outage would produce the identical signal — silence — and
 * telling those two apart is the entire job. From out here, a dead collector is
 * an explicit `down` push with a message saying so, because the API is still
 * answering and the push still leaves the host. It also keeps an outbound call
 * that can hang for its whole timeout out of a 30 s measurement loop whose
 * contract is never to miss a cycle.
 *
 * The evidence is `GET /api/status`, not the collector process, deliberately:
 * "samples are landing in the database" is a stronger claim than "a process is
 * running", and it is the claim the record actually depends on.
 *
 * ## Two rules inherited from the other heartbeats on this machine
 *
 * (`dotfiles/scripts/lib/kuma-push.sh`, prior art for both — not imported,
 * because collector/ stays self-contained and cross-repo sourcing would couple
 * linewatch's deploy to dotfiles' layout.)
 *
 * - **The push URL is a chmod-600 file, never the secrets cache.** A monitor
 *   must not depend on the thing it monitors: resolving it through the
 *   age-encrypted cache would mean a stale cache — itself an alert condition —
 *   silently takes this monitor down too. Same reasoning as the bearer token.
 * - **Fail loud, never fail silent.** No URL means exit non-zero *without*
 *   pushing, so Kuma's own missed-heartbeat fires. A monitor that quietly stops
 *   reporting is worse than no monitor.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LOG_MAX_BYTES, rotateLogIfNeeded } from './log-rotate.js'
import { decideHeartbeat, type StatusSnapshot } from './heartbeat-verdict.js'

const config = {
  apiUrl: process.env['LINEWATCH_API_URL'] ?? 'http://localhost:7731',
  pushUrl: process.env['LINEWATCH_KUMA_PUSH_URL'] ?? null,
  pushUrlFile: process.env['LINEWATCH_KUMA_PUSH_URL_FILE'] ?? join(homedir(), '.config', 'uptime-kuma', 'linewatch-push-url'),
  /** Three probe cycles. Two missed cycles are a hiccup; three are a collector that is not running. */
  staleSampleMs: Number(process.env['LINEWATCH_HEARTBEAT_STALE_MS'] ?? 90_000),
  degradedLossPct: Number(process.env['LINEWATCH_DEGRADED_LOSS_PCT'] ?? 20),
  /** Local call — generous enough for a loaded container, short enough to stay well inside the run budget. */
  apiTimeoutMs: Number(process.env['LINEWATCH_HEARTBEAT_API_TIMEOUT_MS'] ?? 5_000),
  /**
   * The push crosses the WAN this monitor is about, so during an outage it does
   * not fail fast — it hangs until this fires. Kept well under the 60 s
   * StartInterval so two runs can never overlap.
   */
  pushTimeoutMs: Number(process.env['LINEWATCH_HEARTBEAT_PUSH_TIMEOUT_MS'] ?? 15_000),
  /** Must equal the plist's StandardOutPath — launchd opens it once, O_APPEND, and never reopens it. */
  logPath: process.env['LINEWATCH_HEARTBEAT_LOG_PATH'] ?? join(homedir(), 'Library', 'Logs', 'linewatch-heartbeat.log'),
  logMaxBytes: Number(process.env['LINEWATCH_HEARTBEAT_LOG_MAX_BYTES'] ?? DEFAULT_LOG_MAX_BYTES),
  /**
   * `make heartbeat-status`: compute the verdict, print it, push nothing. So the
   * decision can be inspected at any moment without writing a heartbeat Kuma
   * would then count as liveness — a diagnostic that fakes the signal it is
   * diagnosing is worse than no diagnostic.
   */
  dryRun: process.env['LINEWATCH_HEARTBEAT_DRY_RUN'] === '1',
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
}

/** The base push URL, or null having explained itself. Never invents one. */
function resolvePushUrl(): string | null {
  if (config.pushUrl !== null && config.pushUrl !== '') return config.pushUrl
  if (!existsSync(config.pushUrlFile)) return null
  const contents = readFileSync(config.pushUrlFile, 'utf-8').trim()
  return contents === '' ? null : contents
}

async function fetchStatus(): Promise<{ status: StatusSnapshot | null; error: string | null }> {
  try {
    const response = await fetch(`${config.apiUrl}/api/status`, { signal: AbortSignal.timeout(config.apiTimeoutMs) })
    if (!response.ok) return { status: null, error: `GET /api/status returned ${response.status}` }
    return { status: (await response.json()) as StatusSnapshot, error: null }
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * `<base>/api/push/<token>?status=…&msg=…`. Built with `URLSearchParams` rather
 * than string concatenation on purpose — the message interpolates measured
 * values and target names, and hand-rolled escaping is how a query string gets
 * corrupted by the first `&` or `%` that appears in one.
 */
async function push(baseUrl: string, status: 'up' | 'down', msg: string): Promise<boolean> {
  const url = new URL(baseUrl)
  url.searchParams.set('status', status)
  url.searchParams.set('msg', msg)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(config.pushTimeoutMs) })
    if (!response.ok) {
      log('push.rejected', { httpStatus: response.status })
      return false
    }
    return true
  } catch (err) {
    log('push.failed', { error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

async function main(): Promise<void> {
  if (!config.dryRun) rotateLogIfNeeded({ logPath: config.logPath, maxBytes: config.logMaxBytes, report: log })

  const pushUrl = resolvePushUrl()
  if (config.dryRun) {
    const { status, error } = await fetchStatus()
    const verdict = decideHeartbeat({
      status,
      apiError: error,
      now: Date.now(),
      staleSampleMs: config.staleSampleMs,
      degradedLossPct: config.degradedLossPct,
    })
    log('heartbeat.dry_run', { ...verdict, pushUrlResolved: pushUrl !== null })
    // A verdict of `down` is a correct answer to the question asked, not a
    // failure of the command that asked it: exit 0 so this stays usable in a
    // shell pipeline. The delivery path is what exits non-zero, and it is not
    // running here.
    return
  }
  if (pushUrl === null) {
    // Deliberately before the status read: there is nothing to do with a verdict
    // that cannot be delivered, and exiting here is what makes Kuma alert.
    log('push.no_url', { file: config.pushUrlFile })
    process.exit(1)
  }

  const { status, error } = await fetchStatus()
  const verdict = decideHeartbeat({
    status,
    apiError: error,
    now: Date.now(),
    staleSampleMs: config.staleSampleMs,
    degradedLossPct: config.degradedLossPct,
  })

  const delivered = await push(pushUrl, verdict.status, verdict.msg)
  log('heartbeat', { status: verdict.status, reason: verdict.reason, delivered, msg: verdict.msg })

  // A push that did not land is not a heartbeat. Non-zero so launchd records it
  // and `make heartbeat-logs` shows it — though the authoritative consequence is
  // the one nobody here controls: Kuma stops hearing from us and says so.
  if (!delivered) process.exit(2)
}

await main()

/**
 * The native entrypoint of the API + dashboard + Ookla runner + router poller.
 *
 * `src/index.ts` is the whole application and knows nothing about launchd. This
 * file is the only thing the host-side service adds: it bounds the app's own log,
 * then imports the app. It lives in `collector/` — which the Dockerfile never
 * copies — so the image that stays around for the rollback is unchanged and `src/`
 * keeps no dependency on a launchd-shaped helper.
 *
 * The log needs the bound for the same reason the collector's does
 * (collector/log-rotate.ts): launchd holds `StandardOutPath` open for the
 * process's life, so rotation has to be an in-place truncate from inside. The
 * container used to get this from docker's json-file driver (10 MB x 3); a bare
 * launchd job gets nothing, and the router poller alone wrote ~2 MB/day in the
 * week this was measured.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { positiveNumberFromEnv } from './env.js'
import { DEFAULT_LOG_MAX_BYTES, inspectRotation, rotateLogIfNeeded } from './log-rotate.js'

const ROTATE_CHECK_MS = 60_000

const logPath =
  process.env['LINEWATCH_APP_LOG_PATH'] ?? join(homedir(), 'Library', 'Logs', 'linewatch-app.log')
const maxBytes = positiveNumberFromEnv('LINEWATCH_LOG_MAX_BYTES', DEFAULT_LOG_MAX_BYTES)

function report(event: string, fields?: Record<string, unknown>): void {
  console.log(`[app] ${event}${fields ? ` ${JSON.stringify(fields)}` : ''}`)
}

// Said once at startup: the failure mode of rotation is silence. `active: false`
// on a hand-started run is normal — stdout is a terminal, not the launchd log.
const rotation = inspectRotation({ logPath, maxBytes })
report('log.rotation', {
  path: logPath,
  maxBytes,
  bytes: rotation.sizeBytes,
  active: rotation.decision.rotate || rotation.decision.reason === 'under-threshold',
  ...(rotation.decision.rotate ? {} : { reason: rotation.decision.reason }),
})

setInterval(() => {
  rotateLogIfNeeded({ logPath, maxBytes, report })
}, ROTATE_CHECK_MS)

// After the timer, before anything can log at volume. Importing the app starts
// the server; a crash in it exits the process and launchd KeepAlive restarts it.
await import('../src/index.js')

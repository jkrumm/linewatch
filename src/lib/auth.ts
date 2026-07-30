import { config } from '../config.js'

/**
 * Per-route bearer check (docs/DESIGN.md API table). Applied individually to
 * `POST /api/probes` — the one route that writes to the historical record, and
 * the one an attacker could use to forge it — rather than as a global guard;
 * every other route is intentionally open on the tailnet.
 *
 * `POST /api/speedtests/run` deliberately does *not* use this: it is a dashboard
 * button with no token to present, it writes only a measurement it takes itself,
 * and its single abuse (saturating the line) is capped by a rate limit against
 * the last `speed_test` row instead. See routes/speedtests.ts.
 */
export function hasValidBearer(headers: Record<string, string | undefined>): boolean {
  const header = headers['authorization']
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null
  return token !== null && token === config.token
}

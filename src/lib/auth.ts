import { config } from '../config.js'

/**
 * Per-route bearer check (docs/DESIGN.md API table: "Bearer token on writes;
 * reads are open on the tailnet"). Applied individually to the two write
 * routes (`POST /api/probes`, `POST /api/speedtests/run`) via `beforeHandle`
 * rather than a global guard — every other route is intentionally open.
 */
export function hasValidBearer(headers: Record<string, string | undefined>): boolean {
  const header = headers['authorization']
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null
  return token !== null && token === config.token
}

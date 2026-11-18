import { config } from '../config.js'

/**
 * Per-route bearer check (docs/DESIGN.md API table). Applied individually to the
 * five routes that write to the historical record or act on the line from
 * outside — `POST /api/probes`, `POST /api/interventions`, `POST /api/router/poll`,
 * `POST /api/router/actions/reconnect` and `POST /api/router/actions/reboot` —
 * rather than as a global guard; every other route is intentionally open on the
 * tailnet.
 */
export function hasValidBearer(headers: Record<string, string | undefined>): boolean {
  const header = headers['authorization']
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null
  return token !== null && token === config.token
}

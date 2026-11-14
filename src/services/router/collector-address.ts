import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { desc, isNotNull } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import type * as schema from '../../db/schema.js'
import { probeCycle } from '../../db/schema.js'

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>

/** The first non-loopback IPv4 address of the named interface, or null. */
export function addressOfInterface(name: string | null, interfaces: Interfaces): string | null {
  if (name === null) return null
  const address = interfaces[name]?.find((a) => a.family === 'IPv4' && !a.internal)
  return address?.address ?? null
}

/**
 * The LAN address of the host running the collector — the one entry in the
 * router's client lists whose vantage this repo can corroborate.
 *
 * Derived, not configured, because it is a DHCP lease and leases move: the
 * address this was once hard-coded to (`.100`) belongs to a different wired
 * client now, which made the corroboration compare the collector's own link
 * against somebody else's. The interface is the one the collector recorded as
 * its default route on the newest cycle (`probe_cycle.path_if`), so a Wi-Fi
 * address on the same subnet is never mistaken for the measured path.
 *
 * `override` (`LINEWATCH_COLLECTOR_HOST_IP`) wins when set. Null means "cannot
 * say", and every caller treats that as unknown rather than guessing.
 */
export function resolveCollectorHostIp(input: {
  db: BunSQLiteDatabase<typeof schema>
  override: string | null
  interfaces?: Interfaces
}): string | null {
  if (input.override !== null) return input.override
  const row = input.db
    .select({ pathIf: probeCycle.pathIf })
    .from(probeCycle)
    .where(isNotNull(probeCycle.pathIf))
    .orderBy(desc(probeCycle.ts))
    .limit(1)
    .all()[0]
  return addressOfInterface(row?.pathIf ?? null, input.interfaces ?? networkInterfaces())
}

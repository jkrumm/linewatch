import { describe, expect, it } from 'bun:test'
import { probeCycle } from '../../db/schema.js'
import { createTestDb } from '../../db/test-db.js'
import { addressOfInterface, resolveCollectorHostIp } from './collector-address.js'

function iface(address: string, internal = false) {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4' as const,
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  }
}

const INTERFACES = {
  lo0: [iface('127.0.0.1', true)],
  // The ethernet lease and a Wi-Fi lease on the same subnet: the measured path
  // decides which one is "the collector", not the subnet.
  en0: [iface('192.168.1.101')],
  en1: [iface('192.168.1.150')],
}

describe('addressOfInterface', () => {
  it('returns the IPv4 address of the named interface', () => {
    expect(addressOfInterface('en0', INTERFACES)).toBe('192.168.1.101')
    expect(addressOfInterface('en1', INTERFACES)).toBe('192.168.1.150')
  })

  it('is null for an unknown interface, a loopback one or no name at all', () => {
    expect(addressOfInterface('en9', INTERFACES)).toBeNull()
    expect(addressOfInterface('lo0', INTERFACES)).toBeNull()
    expect(addressOfInterface(null, INTERFACES)).toBeNull()
  })
})

describe('resolveCollectorHostIp', () => {
  function dbWithCycles(cycles: Array<{ ts: number; pathIf: string | null }>) {
    const db = createTestDb()
    for (const cycle of cycles) db.insert(probeCycle).values(cycle).run()
    return db
  }

  it('follows the default-route interface of the newest cycle that recorded one', () => {
    const db = dbWithCycles([
      { ts: 1_000, pathIf: 'en1' },
      { ts: 2_000, pathIf: 'en0' },
      // A newer cycle that could not name its interface does not erase the last known one.
      { ts: 3_000, pathIf: null },
    ])
    expect(resolveCollectorHostIp({ db, override: null, interfaces: INTERFACES })).toBe(
      '192.168.1.101',
    )
  })

  it('lets the override win', () => {
    const db = dbWithCycles([{ ts: 1_000, pathIf: 'en0' }])
    expect(resolveCollectorHostIp({ db, override: '10.0.0.7', interfaces: INTERFACES })).toBe(
      '10.0.0.7',
    )
  })

  it('is null, never a guess, when nothing has been recorded', () => {
    const db = dbWithCycles([])
    expect(resolveCollectorHostIp({ db, override: null, interfaces: INTERFACES })).toBeNull()
  })
})

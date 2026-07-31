import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureVantage,
  classifyHardwarePort,
  classifyPath,
  deriveOnHomeLine,
  parseDefaultRoute,
  parseDhcpLeaseStart,
  parseIfCounters,
  parseLinkState,
  parseServiceOrder,
  parseSupportedMedia,
  type Vantage,
} from './vantage.js'

// Fixtures are verbatim output from this Mac mini (macOS 26, 2026-07-30) unless
// a comment says otherwise. MAC addresses, the hostname and global IPv6
// addresses are scrubbed — this repo is public. RFC 1918 addresses are kept:
// 192.168.1.1/192.168.1.100 are the whole point of the on_home_line check.

const ROUTE_DEFAULT = `   route to: default
destination: default
       mask: default
    gateway: 192.168.1.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0
`

// A route with an interface and no gateway. Captured from
// `route -n get 255.255.255.255` because a gateway-less default route (PPPoE
// dialled on the host, a VPN owning the default) cannot be provoked here — the
// point is only that the `gateway:` line can be absent.
const ROUTE_NO_GATEWAY = `   route to: 255.255.255.255
destination: 255.255.255.255
       mask: 255.255.255.255
  interface: en0
      flags: <UP,HOST,DONE,LLINFO,WASCLONED,IFSCOPE,IFREF,BROADCAST>
`

const IFCONFIG_EN0_GIGABIT = `en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	options=50b<RXCSUM,TXCSUM,VLAN_HWTAGGING,AV,CHANNEL_IO>
	ether 00:11:22:33:44:55
	inet6 fe80::1122:3344:5566:7788%en0 prefixlen 64 secured scopeid 0x8
	inet 192.168.1.100 netmask 0xffffff00 broadcast 192.168.1.255
	inet6 2001:db8:1:1:1122:3344:5566:7788 prefixlen 64 autoconf secured
	nd6 options=201<PERFORMNUD,DAD>
	media: autoselect (1000baseT <full-duplex>)
	status: active
`

// The renegotiation this whole module exists for: a cable or switch port fault
// drops en0 to Fast Ethernet, capping throughput at ~94 Mbit/s with no packet
// loss and no outage. Derived from the capture above by substituting the media
// line with the token macOS prints for that speed (`ifconfig -m en0` lists
// `100baseTX mediaopt full-duplex` as supported on this NIC).
const IFCONFIG_EN0_FAST_ETHERNET = IFCONFIG_EN0_GIGABIT.replace(
  'media: autoselect (1000baseT <full-duplex>)',
  'media: autoselect (100baseTX <full-duplex>)',
)

// Wi-Fi: a bare `media: autoselect`, no speed token, no duplex. Captured from
// `ifconfig en1` while associated (172.20.10.5 is an iPhone hotspot's DHCP
// range — this host really was on Wi-Fi to a phone).
const IFCONFIG_EN1_WIFI = `en1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500 constrained
	options=6460<TSO4,TSO6,CHANNEL_IO,PARTIAL_CSUM,ZEROINVERT_CSUM>
	ether 00:11:22:33:44:66
	inet6 fe80::2233:4455:6677:8899%en1 prefixlen 64 secured scopeid 0x12
	inet 172.20.10.5 netmask 0xfffffff0 broadcast 172.20.10.15
	nd6 options=201<PERFORMNUD,DAD>
	media: autoselect
	status: active
`

// An idle Thunderbolt bridge. `ifconfig bridge0`, media line verbatim.
const IFCONFIG_BRIDGE0 = `bridge0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	options=63<RXCSUM,TXCSUM,TSO4,TSO6>
	ether 00:11:22:33:44:77
	media: <unknown type>
	status: inactive
`

// Five rows for one interface, and only the `<Link#8>` row carries numeric
// Ierrs/Oerrs/Coll — the others print `-`. `netstat -I en0 -b`, verbatim except
// for the scrubbed MAC/hostname/IPv6.
const NETSTAT_EN0 = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
en0        1500  <Link#8>    00:11:22:33:44:55 41568543     0 34938024026 25255614     0 12509590061     0
en0        1500  myhost.loca fe80:8::1122:3344 41568543     - 34938024026 25255614     - 12509590061     -
en0        1500  192.168.1     192.168.1.100   41568543     - 34938024026 25255614     - 12509590061     -
en0        1500  2001:db8:1: 2001:db8:1:1:1122 41568543     - 34938024026 25255614     - 12509590061     -
en0        1500  2001:db8:1: 2001:db8:1:1:7572 41568543     - 34938024026 25255614     - 12509590061     -
`

// Same command with real error counters, so a non-zero count is exercised too.
const NETSTAT_EN0_WITH_ERRORS = NETSTAT_EN0.replace(
  'en0        1500  <Link#8>    00:11:22:33:44:55 41568543     0 34938024026 25255614     0 12509590061     0',
  'en0        1500  <Link#8>    00:11:22:33:44:55 41568543   417 34938024026 25255614    23 12509590061     9',
)

// `netstat -I utun0 -b`: the Link row has **no Address column**, so it prints
// ten fields where en0's prints eleven. This is why columns are read as offsets
// from the right: left-indexing this short row shifts every column past the gap
// by one, so it reads Obytes (80) as Oerrs and runs off the end of the row
// looking for Coll. Ierrs happens to survive left-indexing here — the fixture
// discriminates on Oerrs and Coll, which do not.
const NETSTAT_UTUN0 = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
utun0      1500  <Link#22>                            0     0          0        1     0         80     0
utun0      1500  myhost.loca fe80:16::1808:370        0     -          0        1     -         80     -
`

// `ifconfig -m en0`: the negotiated `media:` line first, then the *supported*
// media list. Trimmed to one entry per speed (the real list repeats each speed
// once per mediaopt combination) and with the same scrubbed MAC as above. The
// three speeds are the ones this host's NIC really lists.
const IFCONFIG_M_EN0 = `${IFCONFIG_EN0_FAST_ETHERNET}	supported media:
		media none
		media autoselect
		media 10baseT/UTP mediaopt half-duplex
		media 10baseT/UTP mediaopt full-duplex
		media 100baseTX mediaopt half-duplex
		media 100baseTX mediaopt full-duplex
		media 1000baseT mediaopt full-duplex
		media 1000baseT mediaopt full-duplex mediaopt flow-control
`

// `ipconfig getsummary en0`, **hand-synthesised**, not captured. The real output
// embeds the raw DHCP packet — this host's MAC in `chaddr`, the DHCP server
// identifier — and this repo is public, so the capture is never committed. What
// is reproduced is the shape the parser has to survive: the `LeaseStartTime`
// line in local time with no zone marker, and the three `State :` lines that
// make DHCP state ambiguous and are therefore not parsed at all.
const IPCONFIG_GETSUMMARY = `en0
  Active : TRUE
  LinkStatusActive : TRUE
  IPv4 :
    Addresses : 192.168.1.100
    Router : 192.168.1.1
  DHCPv4 :
    State : BOUND
    LeaseStartTime : 07/30/2026 15:48:29
    LeaseExpirationTime : 07/31/2026 03:48:29
  DHCPv6 :
    State : InformComplete
  IPv6 :
    State : Acquired
`

// `networksetup -listnetworkserviceorder`. Two cellular devices, and they are
// not adjacent in the numbering: `en10` is phone tethering and `en11` a mobile
// hotspot, while `en1` (between them) is Wi-Fi. Any hardcoded interface-name map
// would be one reboot away from calling one of them something harmless.
//
// The hotspot's model number is replaced with the synthetic `MR9999`: it still
// exercises the `\bmr\d{3,4}\b` family match that classifies it as cellular,
// without the fixture doubling as an inventory of what is actually on this line.
const SERVICE_ORDER = `An asterisk (*) denotes that a network service is disabled.
(1) Ethernet
(Hardware Port: Ethernet, Device: en0)

(2) MR9999
(Hardware Port: MR9999, Device: en11)

(3) Wi-Fi
(Hardware Port: Wi-Fi, Device: en1)

(4) Thunderbolt Bridge
(Hardware Port: Thunderbolt Bridge, Device: bridge0)

(5) iPhone USB
(Hardware Port: iPhone USB, Device: en10)

(6) Tailscale
(Hardware Port: io.tailscale.ipn.macsys, Device: )
`

describe('parseDefaultRoute', () => {
  test('reads the interface and gateway actually carrying the default route', () => {
    expect(parseDefaultRoute(ROUTE_DEFAULT)).toEqual({ iface: 'en0', gateway: '192.168.1.1' })
  })

  test('reads an interface with no gateway line', () => {
    expect(parseDefaultRoute(ROUTE_NO_GATEWAY)).toEqual({ iface: 'en0', gateway: null })
  })

  test('yields nulls when the output names no interface', () => {
    // `route` complains on stderr and prints nothing usable on stdout when there
    // is no default route at all (link down). Anything that names no interface
    // must come back null — captureVantage turns that into an absent vantage
    // rather than a fabricated one.
    expect(parseDefaultRoute('route: writing to routing socket: not in table\n')).toEqual({ iface: null, gateway: null })
    expect(parseDefaultRoute('')).toEqual({ iface: null, gateway: null })
  })
})

describe('parseLinkState', () => {
  test('parses a negotiated gigabit link', () => {
    expect(parseLinkState(IFCONFIG_EN0_GIGABIT)).toEqual({ linkMedia: '1000baseT', linkMbit: 1000, linkDuplex: 'full' })
  })

  test('parses a link that renegotiated down to 100baseTX', () => {
    // The situation this module exists for: no loss, no outage, throughput
    // capped at a tenth of the line. Invisible without link_mbit.
    expect(parseLinkState(IFCONFIG_EN0_FAST_ETHERNET)).toEqual({
      linkMedia: '100baseTX',
      linkMbit: 100,
      linkDuplex: 'full',
    })
  })

  test('returns null speed for Wi-Fi, which prints no speed token', () => {
    expect(parseLinkState(IFCONFIG_EN1_WIFI)).toEqual({ linkMedia: 'autoselect', linkMbit: null, linkDuplex: null })
  })

  test('returns null speed for an unknown media type', () => {
    expect(parseLinkState(IFCONFIG_BRIDGE0)).toEqual({ linkMedia: '<unknown type>', linkMbit: null, linkDuplex: null })
  })

  test('parses the 10baseT and multi-gig token families', () => {
    // `10baseT/UTP` is what this NIC's supported-media list actually calls
    // 10 Mbit. The 2.5G/5G/10G tokens come from adapters not present here (a 2.5G
    // Thunderbolt adapter is a planned upgrade per docs/DESIGN.md) and drivers
    // disagree about capitalising `base`, which is why the parser ignores case.
    expect(parseLinkState('\tmedia: autoselect (10baseT/UTP <half-duplex>)').linkMbit).toBe(10)
    expect(parseLinkState('\tmedia: autoselect (10baseT/UTP <half-duplex>)').linkDuplex).toBe('half')
    expect(parseLinkState('\tmedia: autoselect (2500Base-T <full-duplex>)')).toEqual({
      linkMedia: '2500Base-T',
      linkMbit: 2500,
      linkDuplex: 'full',
    })
    expect(parseLinkState('\tmedia: autoselect (5000Base-T <full-duplex>)').linkMbit).toBe(5000)
    expect(parseLinkState('\tmedia: autoselect (10Gbase-T <full-duplex>)').linkMbit).toBe(10_000)
  })

  test('parses the decimal spelling of every multi-gig rate as the same speed', () => {
    // Drivers spell these two ways — `2500Base-T` and `2.5GBase-T` are the same
    // link — and the second spelling is the one that broke: an unanchored token
    // regex matched the `5` out of `2.5G` and recorded a 2.5 Gbit link as
    // `5GBase-T` at 5000 Mbit. A fabricated speed, under a media string the
    // driver never printed, on exactly the adapter docs/DESIGN.md plans to buy.
    // Both spellings of each rate, so neither can drift alone.
    expect(parseLinkState('\tmedia: autoselect (2.5GBase-T <full-duplex>)')).toEqual({
      linkMedia: '2.5GBase-T',
      linkMbit: 2500,
      linkDuplex: 'full',
    })
    expect(parseLinkState('\tmedia: autoselect (5GBase-T <full-duplex>)')).toEqual({
      linkMedia: '5GBase-T',
      linkMbit: 5000,
      linkDuplex: 'full',
    })
    expect(parseLinkState('\tmedia: autoselect (10GBase-T <full-duplex>)').linkMbit).toBe(10_000)
    expect(parseLinkState('\tmedia: autoselect (1000baseT <full-duplex>)').linkMbit).toBe(1000)
    expect(parseLinkState('\tmedia: autoselect (1GBase-T <full-duplex>)').linkMbit).toBe(1000)
  })

  test('never lets a duplex or media word be read as a speed', () => {
    // `full-duplex` and `autoselect` are tokens on the same line. Whole-token
    // matching is what keeps them out; a substring match would not.
    expect(parseLinkState('\tmedia: autoselect <full-duplex>').linkMbit).toBeNull()
    expect(parseLinkState('\tmedia: none').linkMbit).toBeNull()
    expect(parseLinkState('\tmedia: none')).toEqual({ linkMedia: 'none', linkMbit: null, linkDuplex: null })
  })

  test('parses a manually configured media line with no autoselect wrapper', () => {
    expect(parseLinkState('\tmedia: 1000baseT <full-duplex>')).toEqual({
      linkMedia: '1000baseT',
      linkMbit: 1000,
      linkDuplex: 'full',
    })
  })

  test('yields all nulls when there is no media line', () => {
    expect(parseLinkState('ifconfig: interface en11 does not exist\n')).toEqual({
      linkMedia: null,
      linkMbit: null,
      linkDuplex: null,
    })
  })
})

describe('parseSupportedMedia', () => {
  test('reports the ceiling of the NIC, not the speed it negotiated', () => {
    // The pair that makes a 100 Mbit link actionable: this fixture negotiated
    // 100baseTX on a NIC that supports 1000, i.e. a cable or switch-port fault
    // rather than hardware. Reading only the negotiated speed cannot tell the
    // two apart, and they call for opposite fixes.
    expect(parseSupportedMedia(IFCONFIG_M_EN0)).toBe(1000)
    expect(parseLinkState(IFCONFIG_M_EN0).linkMbit).toBe(100)
  })

  test('takes the maximum, not the first or last entry', () => {
    // The list is not sorted by speed on every driver, and `media none` /
    // `media autoselect` bracket it at both ends.
    expect(parseSupportedMedia('\t\tmedia 1000baseT\n\t\tmedia 100baseTX\n\t\tmedia none\n')).toBe(1000)
    expect(parseSupportedMedia('\t\tmedia 10baseT/UTP\n\t\tmedia 2500Base-T\n\t\tmedia 100baseTX\n')).toBe(2500)
  })

  test('is null when nothing in the output is a media line', () => {
    // A failed `ifconfig -m` (interface gone with the link) claims nothing.
    expect(parseSupportedMedia('ifconfig: interface en0 does not exist\n')).toBeNull()
    expect(parseSupportedMedia('')).toBeNull()
  })

  test('is null — never a fallback — when the only token is unrecognised', () => {
    // The invariant the whole column exists for. A default of 1000 here would
    // invent a cable fault out of a NIC whose capability was never measured,
    // and the verdict layer would then tell the user to swap a working cable.
    // No `base` in the token, so MEDIA_TOKEN does not recognise it — the same
    // whole-token rule that keeps `full-duplex` from being read as a speed.
    expect(parseSupportedMedia('\t\tmedia 10GbE\n')).toBeNull()
    expect(parseSupportedMedia('\t\tmedia fddi mediaopt full-duplex\n')).toBeNull()
    expect(parseSupportedMedia('\t\tmedia none\n\t\tmedia autoselect\n')).toBeNull()
    // Wi-Fi lists no speed token at all.
    expect(parseSupportedMedia(IFCONFIG_EN1_WIFI)).toBeNull()
  })
})

describe('parseDhcpLeaseStart', () => {
  /**
   * `LeaseStartTime` carries no zone, so the parse is only defined against one.
   *
   * Restores by *name*, never by deleting `TZ`: measured on Bun 1.3.14, a
   * `delete process.env.TZ` leaves the runtime pinned to whatever was set last
   * and makes the next assignment a no-op — which quietly ran a UTC assertion in
   * the previous zone and passed it for the wrong reason.
   */
  function inTimeZone<T>(tz: string, fn: () => T): T {
    const previous = process.env['TZ'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    process.env['TZ'] = tz
    try {
      return fn()
    } finally {
      process.env['TZ'] = previous
    }
  }

  /**
   * The UTC instant a wall-clock reading names in `tz` — the expected value, derived rather than
   * hardcoded.
   *
   * Two reasons it is computed instead of pinned as an epoch literal. It keeps the assertion an
   * independent *oracle*: this goes through `Intl.DateTimeFormat`, whereas the parser under test
   * goes through `new Date('YYYY-MM-DDTHH:mm:ss')`, so agreement means two different mechanisms
   * agree rather than one restating itself. And it means no single zone is baked into the suite —
   * a hardcoded epoch is only correct for the one zone it was computed in, so it silently
   * documents where the machine that wrote it stood.
   *
   * Offset is resolved twice because the first lookup samples it at the wrong instant; the second
   * pass settles any reading that is not itself inside a DST transition.
   */
  function wallClockToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number, s: number): number {
    const naive = Date.UTC(y, mo - 1, d, h, mi, s)
    const offsetAt = (guess: number): number => {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hour12: false,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
          .formatToParts(new Date(guess))
          .map((part) => [part.type, part.value]),
      )
      // `hour` can format as 24 under hour12:false; `% 24` keeps midnight on the right day.
      const asUtc = Date.UTC(
        Number(parts['year']),
        Number(parts['month']) - 1,
        Number(parts['day']),
        Number(parts['hour']) % 24,
        Number(parts['minute']),
        Number(parts['second']),
      )
      return asUtc - guess
    }
    return naive - offsetAt(naive - offsetAt(naive))
  }

  test('reads the lease start as an absolute instant, in whatever zone the host runs in', () => {
    // `Etc/GMT-5` is UTC+5 — the POSIX sign is inverted — and observes no DST, so it isolates the
    // plain local-time interpretation from the DST question below.
    for (const tz of ['UTC', 'Etc/GMT-5', 'Australia/Sydney']) {
      expect(inTimeZone(tz, () => parseDhcpLeaseStart(IPCONFIG_GETSUMMARY))).toBe(
        wallClockToUtc(tz, 2026, 7, 30, 15, 48, 29),
      )
    }
  })

  test('parses the reading as local, never as UTC', () => {
    // The regression this exists for: appending a `Z` and parsing as UTC. In a zone five hours off
    // that lands the re-bind five hours late — across hour boundaries, and potentially *after* the
    // link-down it is supposed to explain. Asserted as an inequality so it cannot be satisfied by
    // the implementation being copied into the oracle.
    const asIfUtc = Date.UTC(2026, 6, 30, 15, 48, 29)
    expect(inTimeZone('Etc/GMT-5', () => parseDhcpLeaseStart(IPCONFIG_GETSUMMARY))).not.toBe(asIfUtc)
    expect(inTimeZone('UTC', () => parseDhcpLeaseStart(IPCONFIG_GETSUMMARY))).toBe(asIfUtc)
  })

  test('follows the host time zone, and gets DST right', () => {
    // Same wall-clock string, two seasons, in a SOUTHERN-hemisphere zone: Sydney is UTC+10 in July
    // and UTC+11 in January, so the offset moves the opposite way to the northern intuition. A
    // fixed offset is wrong half the year, and a hardcoded "summer means +1" is wrong here in both.
    const summer = '  LeaseStartTime : 07/30/2026 15:48:29\n'
    const winter = '  LeaseStartTime : 01/30/2026 15:48:29\n'
    expect(inTimeZone('Australia/Sydney', () => parseDhcpLeaseStart(summer))).toBe(
      wallClockToUtc('Australia/Sydney', 2026, 7, 30, 15, 48, 29),
    )
    expect(inTimeZone('Australia/Sydney', () => parseDhcpLeaseStart(winter))).toBe(
      wallClockToUtc('Australia/Sydney', 2026, 1, 30, 15, 48, 29),
    )
    // And the two really do differ by an hour of offset, or the assertions above would both hold
    // under a parser that ignored DST entirely.
    const offsetOf = (month: number) => wallClockToUtc('Australia/Sydney', 2026, month, 30, 15, 48, 29) - Date.UTC(2026, month - 1, 30, 15, 48, 29)
    expect(offsetOf(1) - offsetOf(7)).toBe(-3_600_000)
  })

  test('is null when the summary carries no lease start', () => {
    // An interface with no DHCP lease (static, or the command failed) has no
    // re-bind to date, which is not the same as "it never re-bound".
    expect(parseDhcpLeaseStart(IPCONFIG_GETSUMMARY.replace(/^.*LeaseStartTime.*$/m, ''))).toBeNull()
    expect(parseDhcpLeaseStart('')).toBeNull()
  })

  test('is null for a malformed date, not a plausible one', () => {
    // Right shape, impossible values — JS would happily roll `13/45` over into
    // the following year. A rolled-over date reads as measured.
    expect(parseDhcpLeaseStart('  LeaseStartTime : 13/45/2026 99:99:99\n')).toBeNull()
    expect(parseDhcpLeaseStart('  LeaseStartTime : Jul 30 2026 15:48:29\n')).toBeNull()
    expect(parseDhcpLeaseStart('  LeaseStartTime :\n')).toBeNull()
  })

  test('the committed DHCP fixture carries no MAC address', () => {
    // Not decoration: the real `ipconfig getsummary` prints the DHCP packet,
    // `chaddr` included, and this repo is public. The fixture is synthesised
    // for exactly this reason and this test is what keeps a future "let me just
    // paste the real output" from landing. (The Ethernet fixtures above carry
    // the documented scrubbed placeholder instead, which is not this host's.)
    expect(IPCONFIG_GETSUMMARY).not.toMatch(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i)
    expect(IPCONFIG_GETSUMMARY).not.toMatch(/chaddr/i)
  })
})

describe('parseIfCounters', () => {
  test('takes the counters from the only row that has them', () => {
    // Four of the five rows print `-` for Ierrs/Oerrs/Coll. Picking the first or
    // last row would yield nulls forever and look like "no data".
    expect(parseIfCounters(NETSTAT_EN0)).toEqual({ ifIerrs: 0, ifOerrs: 0, ifColl: 0 })
  })

  test('reads non-zero cumulative counters', () => {
    expect(parseIfCounters(NETSTAT_EN0_WITH_ERRORS)).toEqual({ ifIerrs: 417, ifOerrs: 23, ifColl: 9 })
  })

  test('survives a row with the Address column missing', () => {
    // Ten fields instead of eleven. Left-indexed, this row yields Oerrs 80 (the
    // Obytes value) and a null Coll — a permanent, entirely fictional error rate
    // on every tunnel interface. Oerrs and ifColl are what this case proves.
    expect(parseIfCounters(NETSTAT_UTUN0)).toEqual({ ifIerrs: 0, ifOerrs: 0, ifColl: 0 })
  })

  test('yields nulls for a header-only or empty output', () => {
    const headerOnly = NETSTAT_EN0.split('\n')[0] ?? ''
    expect(parseIfCounters(`${headerOnly}\n`)).toEqual({ ifIerrs: null, ifOerrs: null, ifColl: null })
    expect(parseIfCounters('')).toEqual({ ifIerrs: null, ifOerrs: null, ifColl: null })
  })
})

describe('parseServiceOrder', () => {
  test('maps every device to its hardware port and drops device-less services', () => {
    expect(parseServiceOrder(SERVICE_ORDER)).toEqual([
      { hardwarePort: 'Ethernet', device: 'en0' },
      { hardwarePort: 'MR9999', device: 'en11' },
      { hardwarePort: 'Wi-Fi', device: 'en1' },
      { hardwarePort: 'Thunderbolt Bridge', device: 'bridge0' },
      { hardwarePort: 'iPhone USB', device: 'en10' },
    ])
  })

  test('yields an empty list for unusable output', () => {
    expect(parseServiceOrder('')).toEqual([])
  })
})

describe('classifyPath', () => {
  const services = parseServiceOrder(SERVICE_ORDER)

  test('classifies every device in this host real service order', () => {
    expect(classifyPath({ iface: 'en0', services })).toBe('ethernet')
    expect(classifyPath({ iface: 'en1', services })).toBe('wifi')
    expect(classifyPath({ iface: 'en10', services })).toBe('cellular')
    expect(classifyPath({ iface: 'en11', services })).toBe('cellular')
    expect(classifyPath({ iface: 'bridge0', services })).toBe('other')
  })

  test('falls through to other for an interface not in the service order', () => {
    // Never `ethernet`. A wrong `ethernet` is the lie this module prevents.
    expect(classifyPath({ iface: 'utun4', services })).toBe('other')
    expect(classifyPath({ iface: 'en9', services })).toBe('other')
  })

  test('is unknown, not ethernet, when the service list could not be read', () => {
    expect(classifyPath({ iface: 'en0', services: [] })).toBeNull()
    expect(classifyPath({ iface: null, services })).toBeNull()
  })

  test('never resolves a device claimed by two services to ethernet', () => {
    // macOS keeps stale service entries and reuses device names across
    // re-plugs, so one device can be claimed twice. Taking the first match made
    // a hotspot on en11 read as `ethernet` — the one verdict this module exists
    // to make impossible — purely because a dead Ethernet service still named
    // the same device. Order must not decide it, so both orderings are asserted.
    const stale = { hardwarePort: 'Thunderbolt Ethernet Slot 1', device: 'en11' }
    const hotspot = { hardwarePort: 'MR9999', device: 'en11' }
    expect(classifyPath({ iface: 'en11', services: [stale, hotspot] })).toBe('cellular')
    expect(classifyPath({ iface: 'en11', services: [hotspot, stale] })).toBe('cellular')

    // Same rule for the less dramatic clashes: anything outranks `ethernet`,
    // because only `ethernet` can claim the home line.
    expect(classifyPath({ iface: 'en5', services: [stale, { hardwarePort: 'Wi-Fi', device: 'en5' }] })).toBe('wifi')
    expect(classifyPath({ iface: 'en5', services: [stale, { hardwarePort: 'Thunderbolt Bridge', device: 'en5' }] })).toBe('other')

    // Two Ethernet services on one device is agreement, not a clash.
    expect(classifyPath({ iface: 'en5', services: [stale, { hardwarePort: 'USB 10/100/1000 LAN', device: 'en5' }] })).toBe('ethernet')
  })
})

describe('classifyHardwarePort', () => {
  test('classifies port names by shape, not by interface number', () => {
    expect(classifyHardwarePort('Thunderbolt Ethernet Slot 1')).toBe('ethernet')
    expect(classifyHardwarePort('USB 10/100/1000 LAN')).toBe('ethernet')
    expect(classifyHardwarePort('AX88179A')).toBe('other')
    expect(classifyHardwarePort('Wi-Fi')).toBe('wifi')
    expect(classifyHardwarePort('AirPort')).toBe('wifi')
    // Tethering and hotspots are not the home line, and reading them as `other`
    // would understate that.
    expect(classifyHardwarePort('iPhone')).toBe('cellular')
    expect(classifyHardwarePort('iPad USB')).toBe('cellular')
    expect(classifyHardwarePort('Broadband Modem')).toBe('cellular')
    expect(classifyHardwarePort('MR1100')).toBe('cellular')
    // A host-to-host bridge is not a path to the line.
    expect(classifyHardwarePort('Thunderbolt Bridge')).toBe('other')
    expect(classifyHardwarePort('io.tailscale.ipn.macsys')).toBe('other')
  })
})

describe('deriveOnHomeLine', () => {
  const expectedGateway = '192.168.1.1'

  test('is 1 only for Ethernet on the expected gateway', () => {
    expect(deriveOnHomeLine({ pathClass: 'ethernet', gatewayAddr: '192.168.1.1', expectedGateway })).toBe(1)
  })

  test('is 0 for every other path class, however healthy the probes look', () => {
    expect(deriveOnHomeLine({ pathClass: 'wifi', gatewayAddr: '192.168.1.1', expectedGateway })).toBe(0)
    expect(deriveOnHomeLine({ pathClass: 'cellular', gatewayAddr: '172.20.10.1', expectedGateway })).toBe(0)
    expect(deriveOnHomeLine({ pathClass: 'other', gatewayAddr: '192.168.1.1', expectedGateway })).toBe(0)
  })

  test('is 0 for Ethernet through a gateway that is not the expected one', () => {
    expect(deriveOnHomeLine({ pathClass: 'ethernet', gatewayAddr: '10.0.0.1', expectedGateway })).toBe(0)
  })

  test('is 0 for a known non-Ethernet path even with nothing to compare gateways against', () => {
    // Evidence, not absence of it: the home line is the Ethernet one, so naming
    // the path settles the question on its own. This is the mirror of the
    // missing-gateway case below — the two together are the whole rule.
    expect(deriveOnHomeLine({ pathClass: 'cellular', gatewayAddr: null, expectedGateway })).toBe(0)
    expect(deriveOnHomeLine({ pathClass: 'wifi', gatewayAddr: '192.168.1.1', expectedGateway: null })).toBe(0)
  })

  test('is null — never 0 or 1 — when an input is unknown', () => {
    // Unclassifiable path: 0 would claim "not the home line", which is a
    // different statement from "cannot tell" and would let a read path discard
    // good samples.
    expect(deriveOnHomeLine({ pathClass: null, gatewayAddr: '192.168.1.1', expectedGateway })).toBeNull()
    // No configured gateway target to compare against.
    expect(deriveOnHomeLine({ pathClass: 'ethernet', gatewayAddr: '192.168.1.1', expectedGateway: null })).toBeNull()
  })

  test('is null, not 0, for Ethernet on a default route that names no gateway', () => {
    // The regression this test exists for. A default route can legitimately
    // carry no `gateway:` line — host-side PPPoE, a VPN owning the default (see
    // ROUTE_NO_GATEWAY above). Scoring that 0 marked *every* cycle on the real
    // home line "not the home line", and a read path filtering on on_home_line
    // would then throw away the entire dataset. Absence of evidence is not
    // evidence of absence.
    expect(deriveOnHomeLine({ pathClass: 'ethernet', gatewayAddr: null, expectedGateway })).toBeNull()
    // End to end, from the route output that provokes it.
    const route = parseDefaultRoute(ROUTE_NO_GATEWAY)
    expect(deriveOnHomeLine({ pathClass: 'ethernet', gatewayAddr: route.gateway, expectedGateway })).toBeNull()
  })
})

describe('captureVantage', () => {
  /**
   * Runs the real `captureVantage` in a child process whose PATH puts a stub
   * `route` ahead of `/sbin/route`. `captureVantage` shells out, so the
   * link-down branch cannot be reached by feeding it a fixture — the only
   * honest exercise is to make `route` behave the way it does when the host has
   * no default route.
   *
   * A child process rather than mutating this one's PATH, because Bun.spawn
   * resolves the binary against the PATH it captured at startup and ignores a
   * later `process.env['PATH'] = …` unless `env` is passed explicitly (measured
   * — the in-process version of this test silently ran `/sbin/route` and
   * "passed" against live network state). The production code is therefore run
   * untouched, with a PATH that genuinely contains the stub.
   */
  async function withStubbedRoute(stdout: string, exitCode: number): Promise<Vantage> {
    const dir = mkdtempSync(join(tmpdir(), 'linewatch-vantage-'))
    try {
      // The canned output goes in a file the stub cats, rather than inline in
      // the script: `printf '%s'` does not expand the `\n` escapes that come
      // back from JSON.stringify, which collapsed these multi-line fixtures onto
      // one line and made the stub look like a host with no default route.
      writeFileSync(join(dir, 'route.out'), stdout)
      writeFileSync(join(dir, 'route'), `#!/bin/sh\ncat ${JSON.stringify(join(dir, 'route.out'))}\nexit ${exitCode}\n`)
      chmodSync(join(dir, 'route'), 0o755)
      const script = join(dir, 'capture.ts')
      writeFileSync(
        script,
        `import { captureVantage } from ${JSON.stringify(join(import.meta.dir, 'vantage.ts'))}\n` +
          `console.log(JSON.stringify(await captureVantage({ expectedGateway: '192.168.1.1', timeoutMs: 5000 })))\n`,
      )
      const proc = Bun.spawn(['bun', 'run', script], {
        stdout: 'pipe',
        stderr: 'ignore',
        env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}` },
      })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      return JSON.parse(out) as Vantage
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('the stub really does shadow the system route', async () => {
    // Guards the guard. If PATH injection stopped working, every assertion
    // below would quietly measure this host's live network instead, and the
    // link-down test would fail for the right reason only by accident.
    const vantage = await withStubbedRoute(ROUTE_DEFAULT.replace('192.168.1.1', '198.51.100.1'), 0)
    expect(vantage.gatewayAddr).toBe('198.51.100.1')
    expect(vantage.onHomeLine).toBe(0)
  })

  test('reports a vantage even when there is no default route at all', async () => {
    // The state this is for: en0 down, no route, nothing to describe. Returning
    // nothing wrote no probe_cycle row — indistinguishable on the wire from a
    // collector too old to have looked, which is what every cycle before this
    // module says. The row's existence is the measurement; the nulls are the
    // finding. `route` exits non-zero and prints its complaint on stderr here,
    // same shape as ping's 100%-loss case.
    const vantage = await withStubbedRoute('', 1)
    expect(vantage).toEqual({
      pathIf: null,
      pathClass: null,
      linkMedia: null,
      linkMbit: null,
      linkDuplex: null,
      gatewayAddr: null,
      ifIerrs: null,
      ifOerrs: null,
      ifColl: null,
      // Never 0. A hard home-line outage takes the default route with it, and
      // calling that "not the home line" would let a read path filter away the
      // very outage the collector exists to record.
      onHomeLine: null,
      linkMaxMbit: null,
      dhcpBoundAt: null,
      linkWatchS: null,
    })
  })

  test('describes the real path when the route names one', async () => {
    // The other side of the branch, through the same harness: proves the
    // all-null result above comes from the no-route branch and not from a stub
    // that would have nulled everything regardless.
    const vantage = await withStubbedRoute(ROUTE_DEFAULT, 0)
    expect(vantage.pathIf).toBe('en0')
    expect(vantage.gatewayAddr).toBe('192.168.1.1')
    expect(vantage.pathClass).not.toBeNull()
  })
})

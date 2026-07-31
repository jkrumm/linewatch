import { describe, expect, test } from 'bun:test'
import { createLinkSampler, parseIfconfigStatus, type LinkStatus } from './link-sampler.js'

/**
 * Fixtures are **hand-synthesised**, not captured — unlike vantage.test.ts's,
 * which are verbatim with the hardware address scrubbed. `ifconfig en0` prints
 * `ether <MAC>` on its third line and this repo is public, so the line is
 * removed outright here rather than replaced: that lets the MAC assertion at
 * the bottom of this file be absolute instead of a judgement about whether a
 * given placeholder is really a placeholder.
 */
const IFCONFIG_ACTIVE = `en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	options=50b<RXCSUM,TXCSUM,VLAN_HWTAGGING,AV,CHANNEL_IO>
	inet6 fe80::1%en0 prefixlen 64 secured scopeid 0x8
	inet 192.168.1.100 netmask 0xffffff00 broadcast 192.168.1.255
	nd6 options=201<PERFORMNUD,DAD>
	media: autoselect (1000baseT <full-duplex>)
	status: active
`

// The cable-out shape: the interface is still configured, the media descriptor
// collapses to `<unknown type>`, and only `status:` says the link is gone.
const IFCONFIG_INACTIVE = `en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	options=50b<RXCSUM,TXCSUM,VLAN_HWTAGGING,AV,CHANNEL_IO>
	nd6 options=201<PERFORMNUD,DAD>
	media: autoselect (<unknown type>)
	status: inactive
`

// Loopback: configured, up, and no `status:` line at all. The parser has to
// call this unknown rather than reading "no status line" as a live link.
const IFCONFIG_NO_STATUS = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	options=1203<RXCSUM,TXCSUM,TXSTATUS,SW_TIMESTAMP>
	inet 127.0.0.1 netmask 0xff000000
	nd6 options=201<PERFORMNUD,DAD>
`

describe('parseIfconfigStatus', () => {
  test('reads the two states it is allowed to claim', () => {
    expect(parseIfconfigStatus(IFCONFIG_ACTIVE)).toBe('active')
    expect(parseIfconfigStatus(IFCONFIG_INACTIVE)).toBe('inactive')
  })

  test('an absent status line is unknown, never a live link', () => {
    expect(parseIfconfigStatus(IFCONFIG_NO_STATUS)).toBe('unknown')
    // The empty string is what a failed or killed spawn hands over.
    expect(parseIfconfigStatus('')).toBe('unknown')
  })

  test('a status this parser has never seen is unknown, not a guess', () => {
    // Some interfaces print other tokens, and a future OS may print more.
    // Deciding which side of the link `none` falls on is fabrication.
    expect(parseIfconfigStatus('\tstatus: none\n')).toBe('unknown')
    expect(parseIfconfigStatus('\tstatus:\n')).toBe('unknown')
    expect(parseIfconfigStatus('ifconfig: interface en99 does not exist\n')).toBe('unknown')
  })

  test('only a whole status line matches — no reading a state out of prose', () => {
    expect(parseIfconfigStatus('\tsomething status: active reported\n')).toBe('unknown')
  })
})

/**
 * Drives the sampler's state machine on a fake clock: the scheduler hands the
 * tick back instead of running it, and each `sample()` advances the clock by
 * one interval and feeds one reading. A 1 Hz sampler is otherwise untestable
 * without spending real seconds.
 */
function harness(options: { intervalMs?: number; maxWatchS?: number } = {}) {
  const intervalMs = options.intervalMs ?? 1000
  let tick: (() => Promise<void>) | null = null
  let next: LinkStatus = 'unknown'
  let clock = 1_700_000_000_000

  const sampler = createLinkSampler({
    iface: 'en0',
    intervalMs,
    ...(options.maxWatchS === undefined ? {} : { maxWatchS: options.maxWatchS }),
    readStatus: () => Promise.resolve(next),
    now: () => clock,
    scheduler: {
      start: (_intervalMs, fn) => {
        tick = fn
        return () => {
          tick = null
        }
      },
    },
  })

  sampler.start()

  return {
    sampler,
    /** Advance one interval and take one reading. Returns the tick's timestamp. */
    async sample(status: LinkStatus): Promise<number> {
      clock += intervalMs
      next = status
      await tick?.()
      return clock
    },
    restart(): void {
      sampler.stop()
      sampler.start()
    },
  }
}

describe('createLinkSampler', () => {
  test('the first reading establishes the baseline and emits nothing', async () => {
    const h = harness()
    await h.sample('active')

    const drained = h.sampler.drain()
    // A null → value step is not a transition: there is nothing it changed
    // *from*. Same rule diffVantage applies to a collector being upgraded.
    expect(drained.transitions).toEqual([])
    expect(drained.watchedS).toBe(1)
  })

  test('active → inactive → active is exactly two transitions, at the tick that saw them', async () => {
    const h = harness()
    await h.sample('active')
    const downAt = await h.sample('inactive')
    const upAt = await h.sample('active')

    expect(h.sampler.drain().transitions).toEqual([
      { ts: downAt, state: 'down' },
      { ts: upAt, state: 'up' },
    ])
  })

  test('a repeated reading is not a transition', async () => {
    const h = harness()
    await h.sample('active')
    await h.sample('active')
    await h.sample('active')

    expect(h.sampler.drain()).toEqual({ transitions: [], watchedS: 3 })
  })

  test('an unknown reading emits nothing and does not reset the baseline', async () => {
    const h = harness()
    await h.sample('active')
    await h.sample('unknown')
    await h.sample('active')

    // Were `unknown` treated as a state, this would have emitted a down and an
    // up — two fabricated events out of one failed spawn.
    expect(h.sampler.drain().transitions).toEqual([])

    await h.sample('unknown')
    const downAt = await h.sample('inactive')
    // The baseline survived the gap, so the real transition still lands.
    expect(h.sampler.drain().transitions).toEqual([{ ts: downAt, state: 'down' }])
  })

  test('watchedS counts only the readings that succeeded', async () => {
    const h = harness()
    await h.sample('active')
    await h.sample('unknown')
    await h.sample('unknown')
    await h.sample('inactive')

    // 4 ticks, 2 of them read nothing. Reporting 4 would claim four seconds of
    // coverage the sampler does not have.
    expect(h.sampler.drain().watchedS).toBe(2)
  })

  test('drain clears both halves', async () => {
    const h = harness()
    await h.sample('active')
    await h.sample('inactive')
    expect(h.sampler.drain()).toEqual({ transitions: [{ ts: 1_700_000_002_000, state: 'down' }], watchedS: 2 })

    // Second drain with no ticks in between: the cycle watched nothing, and
    // says so, rather than repeating the previous cycle's coverage.
    expect(h.sampler.drain()).toEqual({ transitions: [], watchedS: 0 })
  })

  test('watchedS is clamped to the cycle length', async () => {
    const h = harness({ maxWatchS: 3 })
    await h.sample('active')
    await h.sample('active')
    await h.sample('active')
    await h.sample('active')
    await h.sample('active')

    expect(h.sampler.drain().watchedS).toBe(3)
  })

  test('watchedS is a whole number of seconds at any interval', async () => {
    const h = harness({ intervalMs: 500 })
    await h.sample('active')
    await h.sample('active')
    await h.sample('active')

    // 1.5 s of sampling. probe_cycle.link_watch_s is an integer column and the
    // ingest schema types it `int`, so a fraction here would 422 the whole
    // batch — four real probe samples lost to a coverage counter.
    expect(h.sampler.drain().watchedS).toBe(2)
  })

  test('a stop/start gap re-establishes the baseline instead of dating a change to the resume', async () => {
    const h = harness()
    await h.sample('active')
    h.restart()
    await h.sample('inactive')

    // The link may have gone down at any instant inside the gap. Emitting a
    // transition stamped at the resume would assert a time nobody measured.
    // The coverage count survives, though: both ticks did read the link, and
    // dropping them would under-report seconds that were genuinely sampled.
    expect(h.sampler.drain()).toEqual({ transitions: [], watchedS: 2 })
  })

  test('start is idempotent — a second start does not double the sampling rate', async () => {
    const h = harness()
    h.sampler.start()
    await h.sample('active')

    expect(h.sampler.drain().watchedS).toBe(1)
  })
})

describe('committed fixtures', () => {
  test('carry no MAC address', () => {
    // `ifconfig <if>` prints `ether <MAC>` on line 3 and this repo is public.
    // This is the test that keeps a future "let me just paste the real output"
    // from landing a stable device identifier in git.
    for (const fixture of [IFCONFIG_ACTIVE, IFCONFIG_INACTIVE, IFCONFIG_NO_STATUS]) {
      expect(fixture).not.toMatch(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i)
      expect(fixture).not.toMatch(/\bether\b/)
    }
  })
})

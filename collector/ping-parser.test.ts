import { describe, expect, test } from 'bun:test'
import { parsePingOutput } from './ping-parser.js'

// Fixtures below are verbatim macOS `ping` output (macOS 26, 2026-07-30),
// captured directly rather than hand-written to lock the parser to what the
// real binary actually prints.

const FULL_SUCCESS = `PING 8.8.8.8 (8.8.8.8): 56 data bytes
64 bytes from 8.8.8.8: icmp_seq=0 ttl=118 time=19.803 ms
64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=6.305 ms
64 bytes from 8.8.8.8: icmp_seq=2 ttl=118 time=9.027 ms
64 bytes from 8.8.8.8: icmp_seq=3 ttl=118 time=14.626 ms
64 bytes from 8.8.8.8: icmp_seq=4 ttl=118 time=10.290 ms

--- 8.8.8.8 ping statistics ---
5 packets transmitted, 5 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 6.305/12.010/19.803/4.732 ms
`

// 100% loss: macOS ping exits non-zero (2) here and prints no round-trip
// line at all — only "Request timeout" lines and the summary.
const TOTAL_LOSS = `PING 192.0.2.1 (192.0.2.1): 56 data bytes
Request timeout for icmp_seq 0
Request timeout for icmp_seq 1

--- 192.0.2.1 ping statistics ---
3 packets transmitted, 0 packets received, 100.0% packet loss
`

// Partial loss: some replies, some timeouts, interleaved.
const PARTIAL_LOSS = `PING 1.1.1.1 (1.1.1.1): 56 data bytes
64 bytes from 1.1.1.1: icmp_seq=0 ttl=58 time=10.998 ms
Request timeout for icmp_seq 1
64 bytes from 1.1.1.1: icmp_seq=2 ttl=58 time=4.129 ms
Request timeout for icmp_seq 3
64 bytes from 1.1.1.1: icmp_seq=4 ttl=58 time=2.804 ms

--- 1.1.1.1 ping statistics ---
5 packets transmitted, 3 packets received, 40.0% packet loss
round-trip min/avg/max/stddev = 2.804/5.977/10.998/3.591 ms
`

// Duplicate replies. Captured from `ping -c 3 -i 0.3 224.0.0.1` (multicast is the
// reliable way to provoke dups); responder addresses rewritten to the documentation
// range. Note `received` counts 3 while seven replies were *timed* — `ping`
// excludes duplicates from `received` but still prints a `time=` line for each.
const DUPLICATES = `PING 224.0.0.1 (224.0.0.1): 56 data bytes
64 bytes from 198.51.100.10: icmp_seq=0 ttl=64 time=3.723 ms
64 bytes from 198.51.100.11: icmp_seq=0 ttl=64 time=30.509 ms
64 bytes from 198.51.100.12: icmp_seq=0 ttl=64 time=34.598 ms
64 bytes from 198.51.100.10: icmp_seq=1 ttl=64 time=0.171 ms
64 bytes from 198.51.100.11: icmp_seq=1 ttl=64 time=82.584 ms
64 bytes from 198.51.100.12: icmp_seq=1 ttl=64 time=114.908 ms
64 bytes from 198.51.100.10: icmp_seq=2 ttl=64 time=0.198 ms

--- 224.0.0.1 ping statistics ---
3 packets transmitted, 3 packets received, +4 duplicates, 0.0% packet loss
round-trip min/avg/max/stddev = 0.171/38.099/114.908/41.413 ms
`

// Replies that arrived after the `-W` wait. Captured from
// `ping -c 5 -i 0.3 -W 1 8.8.8.8`: every reply counted as received at 0% loss,
// yet not one `time=` line was printed. Latency here is unmeasured, not low —
// this is the shape that would otherwise draw a flat, flattering latency graph.
const OUT_OF_WAIT_TIME = `PING 8.8.8.8 (8.8.8.8): 56 data bytes

--- 8.8.8.8 ping statistics ---
5 packets transmitted, 5 packets received, 0.0% packet loss, 5 packets out of wait time
round-trip min/avg/max/stddev = 4.708/6.538/12.654/3.063 ms
`

// Both optional clauses at once, in `ping`'s own order (duplicates before the
// loss percentage, out-of-wait-time after it). Captured from
// `ping -c 3 -i 0.3 -W 1 224.0.0.1`.
const DUPLICATES_AND_OUT_OF_WAIT_TIME = `PING 224.0.0.1 (224.0.0.1): 56 data bytes
64 bytes from 198.51.100.10: icmp_seq=1 ttl=64 time=0.219 ms
64 bytes from 198.51.100.10: icmp_seq=2 ttl=64 time=0.217 ms

--- 224.0.0.1 ping statistics ---
3 packets transmitted, 3 packets received, +4 duplicates, 0.0% packet loss, 5 packets out of wait time
round-trip min/avg/max/stddev = 0.217/45.254/116.613/46.479 ms
`

// `+N errors,` is not in macOS /sbin/ping's format strings (checked with
// `strings`), but ping6 and Linux iputils print it and the previous parser
// tolerated it — keep it parseable rather than regressing into a throw.
const ERRORS = `PING 8.8.8.8 (8.8.8.8): 56 data bytes
64 bytes from 8.8.8.8: icmp_seq=0 ttl=118 time=11.402 ms

--- 8.8.8.8 ping statistics ---
3 packets transmitted, 1 packets received, +2 errors, 66.7% packet loss
round-trip min/avg/max/stddev = 11.402/11.402/11.402/0.000 ms
`

describe('parsePingOutput', () => {
  test('parses a fully-successful run', () => {
    const result = parsePingOutput(FULL_SUCCESS)
    expect(result.sent).toBe(5)
    expect(result.received).toBe(5)
    expect(result.lossPct).toBe(0)
    expect(result.rtts).toEqual([19.803, 6.305, 9.027, 14.626, 10.29])
    expect(result.duplicates).toBe(0)
    expect(result.outOfWaitTime).toBe(0)
  })

  test('parses 100% loss with no round-trip summary line and zero RTTs', () => {
    const result = parsePingOutput(TOTAL_LOSS)
    expect(result.sent).toBe(3)
    expect(result.received).toBe(0)
    expect(result.lossPct).toBe(100)
    expect(result.rtts).toEqual([])
  })

  test('parses partial loss, keeping RTTs only for received replies', () => {
    const result = parsePingOutput(PARTIAL_LOSS)
    expect(result.sent).toBe(5)
    expect(result.received).toBe(3)
    expect(result.lossPct).toBe(40)
    expect(result.rtts).toEqual([10.998, 4.129, 2.804])
  })

  test('parses a summary carrying duplicates', () => {
    const result = parsePingOutput(DUPLICATES)
    expect(result.sent).toBe(3)
    expect(result.received).toBe(3)
    expect(result.lossPct).toBe(0)
    expect(result.duplicates).toBe(4)
    expect(result.outOfWaitTime).toBe(0)
    // Duplicates are timed but not counted, so there are more RTTs than replies.
    expect(result.rtts).toEqual([3.723, 30.509, 34.598, 0.171, 82.584, 114.908, 0.198])
  })

  test('parses a summary carrying out-of-wait-time replies and flags the censored latency', () => {
    const result = parsePingOutput(OUT_OF_WAIT_TIME)
    expect(result.sent).toBe(5)
    expect(result.received).toBe(5)
    expect(result.lossPct).toBe(0)
    expect(result.duplicates).toBe(0)
    expect(result.outOfWaitTime).toBe(5)
    // Zero timed replies at 0% loss: the latency statistics do not exist here,
    // and outOfWaitTime is the only thing that says so.
    expect(result.rtts).toEqual([])
    expect(result.rtts.length).toBeLessThan(result.received)
  })

  test('parses duplicates and out-of-wait-time together', () => {
    const result = parsePingOutput(DUPLICATES_AND_OUT_OF_WAIT_TIME)
    expect(result.sent).toBe(3)
    expect(result.received).toBe(3)
    expect(result.lossPct).toBe(0)
    expect(result.duplicates).toBe(4)
    expect(result.outOfWaitTime).toBe(5)
    expect(result.rtts).toEqual([0.219, 0.217])
  })

  test('parses a summary carrying errors', () => {
    const result = parsePingOutput(ERRORS)
    expect(result.sent).toBe(3)
    expect(result.received).toBe(1)
    expect(result.lossPct).toBe(66.7)
    expect(result.duplicates).toBe(0)
    expect(result.outOfWaitTime).toBe(0)
    expect(result.rtts).toEqual([11.402])
  })

  test('never reads an optional clause as loss or as a reply count', () => {
    // A regression guard for the whole class of defect: an unfamiliar clause must
    // not be able to move sent/received/lossPct, because probe.ts records a parse
    // failure as a 100% outage.
    const result = parsePingOutput(
      '--- 8.8.8.8 ping statistics ---\n' +
        '4 packets transmitted, 4 packets received, +1 duplicates, +2 corrupted, 0.0% packet loss, 1 packets out of wait time\n',
    )
    expect(result.sent).toBe(4)
    expect(result.received).toBe(4)
    expect(result.lossPct).toBe(0)
    expect(result.duplicates).toBe(1)
    expect(result.outOfWaitTime).toBe(1)
  })

  test('derives loss from the counts when ping prints no percentage', () => {
    // `ping` replaces the percentage with "-- somebody's printing up packets!"
    // when it counts more replies than it sent. Throwing there would report a
    // 100% outage for a line that is answering fine.
    const result = parsePingOutput(
      '--- 8.8.8.8 ping statistics ---\n' +
        "5 packets transmitted, 6 packets received, -- somebody's printing up packets!\n",
    )
    expect(result.sent).toBe(5)
    expect(result.received).toBe(6)
    expect(result.lossPct).toBe(0)
  })

  test('throws when the output has no summary line at all', () => {
    expect(() => parsePingOutput('ping: cannot resolve foo: Unknown host\n')).toThrow()
  })
})

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

describe('parsePingOutput', () => {
  test('parses a fully-successful run', () => {
    const result = parsePingOutput(FULL_SUCCESS)
    expect(result.sent).toBe(5)
    expect(result.received).toBe(5)
    expect(result.lossPct).toBe(0)
    expect(result.rtts).toEqual([19.803, 6.305, 9.027, 14.626, 10.29])
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

  test('throws when the output has no summary line at all', () => {
    expect(() => parsePingOutput('ping: cannot resolve foo: Unknown host\n')).toThrow()
  })
})

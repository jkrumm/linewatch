/**
 * Parses macOS `ping` output. Dependency-free by design (see probe.ts) — pure
 * string parsing, no imports.
 *
 * macOS `ping` exits non-zero on 100% packet loss (docs/DESIGN.md) — that is
 * a valid measurement, not a failure, so callers must not gate on the process
 * exit code. On 100% loss there is no "round-trip min/avg/max/stddev" line at
 * all, only the transmitted/received/loss summary — this parser tolerates
 * that summary-only shape and returns an empty `rtts` array.
 */

export interface PingResult {
  sent: number
  received: number
  lossPct: number
  /** One entry per successfully-timed reply, in the order `ping` printed them. */
  rtts: number[]
}

const TIME_LINE = /time=([\d.]+)\s*ms/
const SUMMARY_LINE = /(\d+) packets transmitted, (\d+) packets received,(?: \+\d+ errors,)? ([\d.]+)% packet loss/

export function parsePingOutput(output: string): PingResult {
  const rtts: number[] = []
  for (const line of output.split('\n')) {
    const match = TIME_LINE.exec(line)
    if (match?.[1] !== undefined) {
      rtts.push(Number(match[1]))
    }
  }

  const summary = SUMMARY_LINE.exec(output)
  if (!summary || summary[1] === undefined || summary[2] === undefined || summary[3] === undefined) {
    throw new Error('ping output missing the transmitted/received/loss summary line')
  }

  return {
    sent: Number(summary[1]),
    received: Number(summary[2]),
    lossPct: Number(summary[3]),
    rtts,
  }
}

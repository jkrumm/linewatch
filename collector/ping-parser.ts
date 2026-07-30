/**
 * Parses macOS `ping` output. Dependency-free by design (see probe.ts) — pure
 * string parsing, no imports.
 *
 * macOS `ping` exits non-zero on 100% packet loss (docs/DESIGN.md) — that is
 * a valid measurement, not a failure, so callers must not gate on the process
 * exit code. On 100% loss there is no "round-trip min/avg/max/stddev" line at
 * all, only the transmitted/received/loss summary — this parser tolerates
 * that summary-only shape and returns an empty `rtts` array.
 *
 * The summary line is assembled from optional clauses (`+N duplicates,`,
 * `, N packets out of wait time`), so it is parsed clause by clause rather than
 * with one exact pattern. A clause this parser does not know about is ignored
 * instead of throwing: probe.ts turns a throw into received:0/lossPct:100, so
 * every unhandled summary shape would fabricate an outage out of a healthy line.
 */

export interface PingResult {
  sent: number
  received: number
  lossPct: number
  /**
   * One entry per *timed* reply, in the order `ping` printed them.
   *
   * This is not always `received` entries long, and the two mismatch in both
   * directions:
   * - `outOfWaitTime > 0` → those replies were counted but never timed, so
   *   `rtts.length < received` and every statistic derived from it
   *   (min/med/max/jitter) is a **floor, not the truth** — the fast replies
   *   only. Measured: `-W 1` against 8.8.8.8 reports 5 received at 0% loss and
   *   prints not a single `time=` line.
   * - `duplicates > 0` → duplicate replies are timed but not counted in
   *   `received`, so `rtts.length` can exceed `received`.
   */
  rtts: number[]
  /** `+N duplicates,` in the summary; 0 when absent. Normal on a LAN. */
  duplicates: number
  /**
   * `, N packets out of wait time` in the summary; 0 when absent — replies that
   * arrived after `-W` and so count in `received` but print no `time=` line.
   * Non-zero means the latency statistics are censored; see `rtts`.
   */
  outOfWaitTime: number
}

const TIME_LINE = /time=([\d.]+)\s*ms/

/** `%ld packets transmitted, %ld packets received, ` — printed by every run. */
const SUMMARY_COUNTS = /(\d+) packets transmitted, (\d+) packets received,/
const SUMMARY_LOSS = /([\d.]+)% packet loss/
const SUMMARY_DUPLICATES = /\+(\d+) duplicates,/
const SUMMARY_OUT_OF_WAIT_TIME = /, (\d+) packets out of wait time/

export function parsePingOutput(output: string): PingResult {
  const rtts: number[] = []
  let summaryLine = ''
  let counts: RegExpExecArray | null = null

  for (const line of output.split('\n')) {
    const time = TIME_LINE.exec(line)
    if (time?.[1] !== undefined) {
      rtts.push(Number(time[1]))
    }
    const lineCounts = SUMMARY_COUNTS.exec(line)
    if (lineCounts) {
      summaryLine = line
      counts = lineCounts
    }
  }

  if (!counts || counts[1] === undefined || counts[2] === undefined) {
    throw new Error('ping output missing the transmitted/received/loss summary line')
  }

  const sent = Number(counts[1])
  const received = Number(counts[2])
  const loss = SUMMARY_LOSS.exec(summaryLine)

  return {
    sent,
    received,
    // `ping` swaps the percentage for "-- somebody's printing up packets!" when it
    // counts more replies than it sent, so the percentage is not guaranteed to be
    // there. Derive it instead of throwing — see the fabricated-outage note above.
    lossPct: loss?.[1] !== undefined ? Number(loss[1]) : lossFromCounts({ sent, received }),
    rtts,
    duplicates: matchedCount(summaryLine, SUMMARY_DUPLICATES),
    outOfWaitTime: matchedCount(summaryLine, SUMMARY_OUT_OF_WAIT_TIME),
  }
}

function matchedCount(summaryLine: string, clause: RegExp): number {
  const match = clause.exec(summaryLine)
  return match?.[1] === undefined ? 0 : Number(match[1])
}

function lossFromCounts({ sent, received }: { sent: number; received: number }): number {
  if (sent <= 0) return 0
  return Math.max(0, ((sent - received) / sent) * 100)
}

/**
 * SmokePing-style summary stats over a cycle's raw RTT samples. Pure
 * functions — no I/O, safe to import from both the API server and the
 * dependency-free native collector.
 */

/**
 * Linear-interpolated percentile (the standard method — same shape as
 * numpy's default). `p` is 0–100. Returns null for an empty input.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const first = sorted[0]
  if (sorted.length === 1 || first === undefined) return first ?? null

  const rank = (p / 100) * (sorted.length - 1)
  const lowerIndex = Math.floor(rank)
  const upperIndex = Math.ceil(rank)
  const lower = sorted[lowerIndex]
  const upper = sorted[upperIndex]
  if (lower === undefined || upper === undefined) return null
  if (lowerIndex === upperIndex) return lower

  const weight = rank - lowerIndex
  return lower * (1 - weight) + upper * weight
}

/** The 50th percentile — the "band centre" line in the SmokePing-style graph. */
export function median(values: number[]): number | null {
  return percentile(values, 50)
}

/**
 * Population standard deviation, used as the jitter figure (docs/DESIGN.md's
 * baseline: "0.62 ms stddev over 30 packets"). Returns null for empty input,
 * 0 for a single sample.
 */
export function stddev(values: number[]): number | null {
  if (values.length === 0) return null
  if (values.length === 1) return 0

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

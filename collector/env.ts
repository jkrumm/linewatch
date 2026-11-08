/**
 * Startup validation for numeric environment values. Dependency-free so the
 * collector and the heartbeat can both import it.
 *
 * `Number('abc')` is NaN, and NaN is the worst kind of bad config: `sleep(NaN)`
 * becomes a zero-delay spin, and `age > NaN` is always false, so a dead
 * collector reads as `up`. A value that is not a finite positive number stops
 * the process at startup with a message naming the variable, instead of
 * flowing into a comparison that quietly goes the wrong way.
 */
export function positiveNumberFromEnv(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (Number.isFinite(value) && value > 0) return value
  console.error(`invalid ${name}="${raw}": want a finite number greater than 0`)
  process.exit(1)
}

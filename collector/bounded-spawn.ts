/**
 * Run a subprocess with a hard deadline.
 *
 * Every external call in the pushers needs a bound, because a hang does not
 * fail — it holds the loop (watchdog) or the launchd slot (heartbeat) forever,
 * and the monitor that depends on it goes silent with nothing to restart it.
 * `ping` is the one that matters: `-c N -i S` bounds a *healthy* run, not one
 * wedged in the kernel or a resolver.
 *
 * On deadline the child is SIGKILLed (a wedged ping ignores SIGTERM often
 * enough that asking nicely is not a bound) and the result says so, so the
 * caller can treat the check as failed instead of as an empty success.
 *
 * Dependency-free like the rest of collector/.
 */
export interface BoundedResult {
  stdout: string
  timedOut: boolean
}

export async function spawnBounded(args: string[], timeoutMs: number): Promise<BoundedResult> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, timeoutMs)
  try {
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { stdout, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

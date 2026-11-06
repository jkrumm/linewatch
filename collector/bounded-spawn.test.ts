import { describe, expect, test } from 'bun:test'
import { spawnBounded } from './bounded-spawn.js'

describe('spawnBounded', () => {
  test('returns stdout of a command that finishes in time', async () => {
    const result = await spawnBounded(['echo', 'hello'], 5_000)
    expect(result).toEqual({ stdout: 'hello\n', timedOut: false })
  })

  test('kills a hung command at the deadline and says so', async () => {
    const started = Date.now()
    const result = await spawnBounded(['sleep', '30'], 200)
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

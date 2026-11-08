import { describe, expect, test } from 'bun:test'
import { positiveNumberFromEnv } from './env.js'

describe('positiveNumberFromEnv', () => {
  test('falls back when unset or empty', () => {
    expect(positiveNumberFromEnv('X', 30, {})).toBe(30)
    expect(positiveNumberFromEnv('X', 30, { X: '' })).toBe(30)
  })
  test('parses a valid value', () => {
    expect(positiveNumberFromEnv('X', 30, { X: '0.5' })).toBe(0.5)
  })
  test('exits non-zero on NaN, zero, negative and Infinity', async () => {
    for (const bad of ['abc', '0', '-1', 'Infinity']) {
      const proc = Bun.spawn(
        [
          'bun',
          '-e',
          `import { positiveNumberFromEnv } from ${JSON.stringify(import.meta.dir + '/env.ts')}; positiveNumberFromEnv('X', 1, { X: ${JSON.stringify(bad)} })`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const [err] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      expect(proc.exitCode).toBe(1)
      expect(err).toContain('invalid X')
    }
  })
})

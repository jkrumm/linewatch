import { describe, expect, test } from 'bun:test'

/**
 * The retry rule of the scheduled poll. `pollWithRetry` takes its poll and its
 * sleep as inputs, so no socket is opened and no time passes.
 */

process.env['LINEWATCH_DB'] = ':memory:'
process.env['LINEWATCH_TOKEN'] ??= 'test-token-not-the-real-one'

const { pollWithRetry } = await import('./scheduler.js')

type Run = Awaited<ReturnType<typeof pollWithRetry>>

function harness(runs: Run[]) {
  const sleeps: number[] = []
  let calls = 0
  const result = pollWithRetry({
    poll: () => Promise.resolve(runs[calls++] ?? runs[runs.length - 1]!),
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
    delayMs: 30_000,
  })
  return { result, sleeps, calls: () => calls }
}

const stored: Run = { attempt: 'complete', lineStored: true }

describe('pollWithRetry', () => {
  test('a poll that stored its line reading is the only poll', async () => {
    const h = harness([stored])
    expect(await h.result).toEqual(stored)
    expect(h.calls()).toBe(1)
    expect(h.sleeps).toEqual([])
  })

  test('a partial poll that kept the line reading is not retried', async () => {
    const partial: Run = { attempt: 'partial', lineStored: true }
    const h = harness([partial])
    expect(await h.result).toEqual(partial)
    expect(h.calls()).toBe(1)
  })

  test.each([
    ['a login that failed', { attempt: 'login_failed', lineStored: false }],
    ['a poll that threw', { attempt: 'failed', lineStored: false }],
    ['a poll whose first read was lost', { attempt: 'partial', lineStored: false }],
  ] as Array<[string, Run]>)('%s gets one more poll after the pause', async (_name, first) => {
    const h = harness([first, stored])
    expect(await h.result).toEqual(stored)
    expect(h.calls()).toBe(2)
    expect(h.sleeps).toEqual([30_000])
  })

  test('the retry is the last one, however it ends', async () => {
    const failed: Run = { attempt: 'login_failed', lineStored: false }
    const h = harness([failed, failed, stored])
    expect(await h.result).toEqual(failed)
    expect(h.calls()).toBe(2)
  })

  test.each([
    ['skipped', { attempt: 'skipped', lineStored: false }],
    ['unconfigured', { attempt: 'unconfigured', lineStored: false }],
  ] as Array<[string, Run]>)(
    '%s never retries: it is not a failure to read',
    async (_name, run) => {
      const h = harness([run, stored])
      expect(await h.result).toEqual(run)
      expect(h.calls()).toBe(1)
      expect(h.sleeps).toEqual([])
    },
  )
})

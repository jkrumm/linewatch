import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The API must bind loopback unless told otherwise. Bun and Elysia default to every
 * interface, and a native process — unlike the container, whose port compose publishes
 * on 127.0.0.1 — has nothing between it and the LAN. `POST /api/speedtests/run` has no
 * bearer, so an all-interfaces bind is a line-saturation button for the whole network.
 * A source test on `index.ts`, because `.listen()` cannot run under `bun test`.
 */
describe('listen address', () => {
  test('config defaults to loopback', () => {
    // Source, not an import: `config` is one module shared by every test file, and
    // loading it here would freeze its `dbPath` before the files that set
    // `LINEWATCH_DB=:memory:` run.
    const source = readFileSync(join(import.meta.dir, 'config.ts'), 'utf8')
    expect(source).toContain("host: process.env['LINEWATCH_HOST'] ?? '127.0.0.1'")
  })

  test('index.ts passes it to listen()', () => {
    const source = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')
    expect(source).toMatch(/\.listen\(\{[^}]*hostname:\s*config\.host/)
  })

  test('only the container opts into every interface', () => {
    const compose = readFileSync(join(import.meta.dir, '..', 'docker-compose.yml'), 'utf8')
    expect(compose).toMatch(/LINEWATCH_HOST:\s*'0\.0\.0\.0'/)
    const plist = readFileSync(
      join(import.meta.dir, '..', 'collector', 'com.jkrumm.linewatch-app.plist.template'),
      'utf8',
    )
    expect(plist).not.toContain('LINEWATCH_HOST')
  })
})

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LiveExecutor, NullExecutor } from './actions.js'
import type { RouterActionIntent, RouterActionResponse } from './client.js'
import { ADT_WAN_ROWS } from './fixtures.js'
import { redactRow } from './redact.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const THIS_FILE = 'actions.test.ts'

/**
 * A fake with the two methods the executor uses and nothing else, so a test
 * cannot accidentally prove something about a surface the executor does not
 * have.
 */
class FakeClient {
  readonly sent: Array<{ intent: RouterActionIntent; stack: string }> = []
  sessions = 0
  constructor(
    private readonly rows: Array<Record<string, string>> = ADT_WAN_ROWS,
    private readonly answer: (intent: RouterActionIntent) => RouterActionResponse = (intent) => ({
      ok: true,
      errorcode: '0',
      httpStatus: 200,
      oid: `OID_FOR_${intent}`,
    }),
  ) {}

  startSession(): Promise<void> {
    this.sessions += 1
    return Promise.resolve()
  }

  read(): Promise<Array<Record<string, string>>> {
    return Promise.resolve(this.rows.map(redactRow))
  }

  sendAction(input: { intent: RouterActionIntent; stack: string }): Promise<RouterActionResponse> {
    this.sent.push(input)
    return Promise.resolve(this.answer(input.intent))
  }
}

// The executor takes a RouterClient; the fake implements the three members it
// actually calls. Structural typing would reject the missing ones, and widening
// the constructor's type to accept less would weaken the real call site.
const asClient = (fake: FakeClient) => fake as unknown as ConstructorParameters<typeof LiveExecutor>[0]
const executor = (fake: FakeClient) => new LiveExecutor(asClient(fake), () => Promise.resolve())

describe('the write whitelist', () => {
  /**
   * The rule this enforces is not a style preference. `/js/gdprProxy.js` routes
   * `go`, `gl`, `gs`, `so`, `ao`, `do`, `op` and `cgi` to the same
   * `/cgi_gdpr?9` with the verb inside an AES-encrypted body, so a factory
   * reset and a line-statistics read are indistinguishable to any firewall,
   * proxy or URL allowlist. Code is the only layer where the distinction can
   * exist, and the destructive constants are lexical neighbours of the useful
   * ones in the router's own JavaScript — one careless paste away.
   */
  it('contains no destructive operation name anywhere in the router module', () => {
    const dangerous = /ACT[A-Z_]*(FACTORY|RESET|RESTORE|DEFAULT|UPGRADE|FIRMWARE)|FACTORY_RESET/i
    const offenders: string[] = []
    for (const name of readdirSync(moduleDir)) {
      if (!name.endsWith('.ts') || name === THIS_FILE) continue
      const source = readFileSync(join(moduleDir, name), 'utf-8')
      for (const [index, line] of source.split('\n').entries()) {
        if (dangerous.test(line)) offenders.push(`${name}:${index + 1}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * The set of operations this codebase can send, asserted against the source
   * rather than an export, so widening it is a deliberate diff that fails a
   * test rather than a quiet addition to a map.
   */
  it('sends exactly four operations, and they are these four', () => {
    const source = readFileSync(join(moduleDir, 'client.ts'), 'utf-8')
    const found = new Set(source.match(/'ACT_[A-Z_]+'/g)?.map((match) => match.slice(1, -1)) ?? [])
    expect([...found].sort()).toEqual(['ACT_OP_DHCP_RENEW', 'ACT_OP_PPP_CONN', 'ACT_OP_PPP_DISCONN', 'ACT_REBOOT'])
  })

  it('exposes no way to name an operation from outside client.ts', () => {
    const source = readFileSync(join(moduleDir, 'client.ts'), 'utf-8')
    // The map and the assertion set are module-private: neither is exported,
    // and `sendAction` takes an intent, never an oid.
    expect(source).not.toMatch(/export\s+const\s+ACTION_OIDS/)
    expect(source).toMatch(/sendAction\(input:\s*\{\s*intent:\s*RouterActionIntent/)
    expect(source).not.toMatch(/sendAction\([^)]*oid:\s*string/)
  })
})

describe('NullExecutor', () => {
  it('exercises the whole path and sends nothing', async () => {
    const result = await new NullExecutor().reconnect()
    expect(result).toMatchObject({ ok: true, capability: 'null', outcome: 'not_executed', steps: [] })
  })
})

describe('LiveExecutor.reconnect', () => {
  it('bounces PPP using the connection stack, not the interface stack', async () => {
    const fake = new FakeClient()
    const result = await executor(fake).reconnect()

    expect(result.outcome).toBe('executed')
    // DEV2_IP_INTF's ppp0 is stack 4. Using it here would address the wrong object.
    expect(fake.sent).toEqual([
      { intent: 'ppp_disconnect', stack: '3,0,0,0,0,0' },
      { intent: 'ppp_connect', stack: '3,0,0,0,0,0' },
    ])
    expect(result.before?.connType).toBe('PPPoE')
  })

  it('reads the connection fresh on the session it acts over', async () => {
    const fake = new FakeClient()
    await executor(fake).reconnect()
    expect(fake.sessions).toBe(1)
  })

  it('renews the lease instead when the connection is DHCP', async () => {
    const dhcp = ADT_WAN_ROWS.map((row) =>
      row['name'] === 'ipoe_ptm_0_0_d' ? { ...row, connType: 'DHCP' } : row,
    )
    const fake = new FakeClient(dhcp)
    await executor(fake).reconnect()
    expect(fake.sent.map((s) => s.intent)).toEqual(['dhcp_renew'])
  })

  it('refuses a connType it does not recognise rather than guessing a verb', async () => {
    const odd = ADT_WAN_ROWS.map((row) =>
      row['name'] === 'ipoe_ptm_0_0_d' ? { ...row, connType: 'L2TP' } : row,
    )
    const fake = new FakeClient(odd)
    const result = await executor(fake).reconnect()
    expect(result.outcome).toBe('refused')
    expect(fake.sent).toEqual([])
  })

  it('refuses when there is no live connection at all', async () => {
    const fake = new FakeClient([])
    const result = await executor(fake).reconnect()
    expect(result.outcome).toBe('refused')
    expect(fake.sent).toEqual([])
  })

  /**
   * Acting on a connection the router did not vouch for means acting on a stack
   * carried forward from a previous poll. That is exactly the state a WAN
   * failure produces, and it is the wrong moment to start guessing.
   */
  it('refuses when every connection reports disconnected', async () => {
    const allDown = ADT_WAN_ROWS.map((row) => ({
      ...row,
      connStatusV4: 'Disconnected',
      connStatusV6: 'Disconnected',
    }))
    const fake = new FakeClient(allDown)
    const result = await executor(fake).reconnect()
    expect(result.outcome).toBe('refused')
    expect(fake.sent).toEqual([])
  })

  /** Half a disconnect/connect pair is a state nobody asked for. */
  it('does not fire the connect when the disconnect failed', async () => {
    const fake = new FakeClient(ADT_WAN_ROWS, (intent) => ({
      ok: intent !== 'ppp_disconnect',
      errorcode: intent === 'ppp_disconnect' ? '9001' : '0',
      httpStatus: 200,
      oid: `OID_FOR_${intent}`,
    }))
    const result = await executor(fake).reconnect()
    expect(result.outcome).toBe('failed')
    expect(fake.sent.map((s) => s.intent)).toEqual(['ppp_disconnect'])
  })
})

describe('LiveExecutor.reboot', () => {
  /**
   * The one action whose transport error the firmware deliberately swallows,
   * because the device dies before answering — so a wrong operation name and a
   * successful reboot are the same observation from here: silence. Shipping it
   * on an unconfirmed name would mean "no answer" could not be read either way.
   */
  it('refuses, because the operation name is unconfirmed and its failure is silent', async () => {
    const fake = new FakeClient()
    const result = await executor(fake).reboot()
    expect(result.outcome).toBe('refused')
    expect(fake.sent).toEqual([])
  })
})

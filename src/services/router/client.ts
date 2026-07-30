import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { redactRow, type RouterRow } from './redact.js'

/**
 * TP-Link Archer VX800v read client (`/cgi_gdpr` data model).
 *
 * Deep module on purpose: callers get `read(oid, operation)` returning already
 * redacted rows, and every unpleasant property of this device stays in here —
 * the RSA/AES envelope, the TokenID minted out of the logged-in HTML shell, the
 * flaky `getGDPRParm`, the 406s, and the single-admin-session politeness rules.
 *
 * Two protocol facts this client refuses to let a caller get wrong:
 *
 * 1. **The session is held.** The router allows one admin session and a login
 *    force-evicts whoever holds it — including a human in the router UI. So a
 *    login happens on first use and then only after an eviction, and even then
 *    not before `reloginBackoffMs` has passed. Being polite here is a
 *    requirement, not a nicety.
 * 2. **`go` on a LIST object silently returns only the first instance.** It does
 *    not reliably answer errorcode 9003. Measured: `DEV2_HOST_ENTRY` under `go`
 *    returned exactly one host and looked completely healthy; under `gl` it
 *    returned all eight. Callers pass the operation explicitly and cross-check
 *    the row count against a count field where the firmware offers one.
 *
 * Read-only by construction: `read` is the whole surface, and the write
 * operations of this protocol (`so`/`ao`/`do`/`op`) are not implemented at all.
 */

export type RouterOperation = 'go' | 'gl' | 'gs'

export interface RouterClientOptions {
  baseUrl: string
  /** Not "admin": both the login payload and the MD5 hash use "user" on this firmware. */
  user: string
  password: string
  /**
   * How long to wait after an eviction before reclaiming the single admin
   * session. A login kicks a human out of the router UI, so the poller yields
   * for a while rather than fighting for it.
   */
  reloginBackoffMs: number
  requestTimeoutMs: number
}

export interface RouterClientStatus {
  loggedIn: boolean
  /** Number of logins performed in this process — the evidence that the session is held. */
  logins: number
  /** Reads served since the current session was established. */
  readsThisSession: number
  sessionSince: number | null
  /** Epoch ms before which no login will be attempted. */
  nextLoginAllowedAt: number
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** Wrong operation for this object kind — the caller should try the other one. */
const ERRORCODE_WRONG_OPERATION = '9003'

interface Session {
  key: string
  iv: string
  hash: string
  nn: string
  ee: string
  seq: number
  cookie: string
  tokenId: string
  since: number
  reads: number
}

/** The session was lost (evicted, expired, or never valid). Recoverable after a backoff. */
export class RouterSessionLostError extends Error {
  constructor(detail: string) {
    super(`router session lost: ${detail}`)
    this.name = 'RouterSessionLostError'
  }
}

/**
 * This OID could not be read, but the session and the device are fine — the
 * caller can carry on with the rest of the poll. Every other error class in this
 * module means the opposite, so a poll that treats them alike would record a
 * router "reporting nothing" when it is in fact unreachable.
 */
export class RouterReadError extends Error {}

/** The router answered, but refused this OID. */
export class RouterOidError extends RouterReadError {
  constructor(
    readonly oid: string,
    readonly errorcode: string,
  ) {
    super(`router refused ${oid}: errorcode ${errorcode}`)
    this.name = 'RouterOidError'
  }
}

/** The device answered 406 to every attempt: busy, not broken. */
export class RouterBusyError extends RouterReadError {
  constructor(readonly oid: string) {
    super(`router answered 406 four times for ${oid}`)
    this.name = 'RouterBusyError'
  }
}

/**
 * The router did not answer at all. Distinct from a lost session on purpose: a
 * device that is not answering has no session to be polite about, so this does
 * not start the eviction backoff and the next poll simply tries again.
 */
export class RouterUnreachableError extends Error {
  constructor(detail: string) {
    super(`router unreachable: ${detail}`)
    this.name = 'RouterUnreachableError'
  }
}

/** Login is deliberately deferred — the eviction backoff has not elapsed. */
export class RouterBackingOffError extends Error {
  constructor(readonly retryAt: number) {
    super(`router login backing off for another ${Math.round((retryAt - Date.now()) / 1000)}s`)
    this.name = 'RouterBackingOffError'
  }
}

const md5 = (value: string) => createHash('md5').update(value, 'utf8').digest('hex')
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let b = base % modulus
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus
    b = (b * b) % modulus
    e >>= 1n
  }
  return result
}

export class RouterClient {
  private session: Session | null = null
  private logins = 0
  private nextLoginAllowedAt = 0
  /** Serialises everything: one held session cannot answer concurrent requests. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: RouterClientOptions) {}

  status(): RouterClientStatus {
    return {
      loggedIn: this.session !== null,
      logins: this.logins,
      readsThisSession: this.session?.reads ?? 0,
      sessionSince: this.session?.since ?? null,
      nextLoginAllowedAt: this.nextLoginAllowedAt,
    }
  }

  /**
   * Reads one OID and returns its instances, redacted. `operation` is the
   * caller's declared expectation of the object's kind; a 9003 ("wrong
   * operation") falls back to the other read operation once and logs it, so a
   * firmware change turns into a warning rather than a silently truncated list.
   */
  read(oid: string, operation: RouterOperation): Promise<RouterRow[]> {
    return this.serialise(async () => {
      const session = await this.ensureSession()
      try {
        return await this.readWith(session, oid, operation)
      } catch (error) {
        if (error instanceof RouterOidError && error.errorcode === ERRORCODE_WRONG_OPERATION) {
          const fallback: RouterOperation = operation === 'go' ? 'gl' : 'go'
          console.warn(`[router] ${oid} rejected "${operation}" (9003) — retrying as "${fallback}"`)
          return await this.readWith(session, oid, fallback)
        }
        throw error
      }
    })
  }

  /**
   * Drops the held session and starts the politeness backoff. Called on
   * eviction, and available to a caller that has independent evidence the
   * session is gone.
   */
  invalidate(reason: string): void {
    if (this.session === null) return
    this.session = null
    this.nextLoginAllowedAt = Date.now() + this.options.reloginBackoffMs
    console.warn(
      `[router] session dropped (${reason}); not reclaiming it before ${new Date(this.nextLoginAllowedAt).toISOString()}`,
    )
  }

  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    // Keep the chain alive after a rejection, without turning this into an
    // unhandled rejection of its own.
    this.tail = run.catch(() => undefined)
    return run
  }

  private async ensureSession(): Promise<Session> {
    if (this.session !== null) return this.session
    if (Date.now() < this.nextLoginAllowedAt) throw new RouterBackingOffError(this.nextLoginAllowedAt)
    try {
      this.session = await this.login()
    } catch (error) {
      // A login that could not reach the device must surface as "unreachable",
      // not as a generic failure: the caller distinguishes the two, and treating
      // an unreachable router as a per-read problem lets a poll finish
      // "successfully" having recorded nothing.
      if (!(await this.isReachable())) {
        throw new RouterUnreachableError(error instanceof Error ? error.message : String(error))
      }
      throw error
    }
    this.logins += 1
    return this.session
  }

  private headers(session: Session | null, accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Referer: `${this.options.baseUrl}/`,
      Origin: this.options.baseUrl,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: accept,
      'Content-Type': 'text/plain',
    }
    if (session?.cookie) headers['Cookie'] = session.cookie
    if (session?.tokenId) headers['TokenID'] = session.tokenId
    return headers
  }

  private fetch(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    })
  }

  /**
   * `getGDPRParm` intermittently answers 406, or a 200 whose body carries no RSA
   * parameters at all, and recovers on retry. That is device flakiness, not a
   * protocol error: without this loop the poller looks broken every few runs.
   */
  private async fetchRsaParams(): Promise<{ nn: string; ee: string; seq: number }> {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await Bun.sleep(700 * attempt)
      const response = await this.fetch('/cgi/getGDPRParm', {
        method: 'POST',
        headers: this.headers(null, 'text/plain, */*; q=0.01'),
      })
      const body = await response.text()
      const nn = body.match(/var nn="([^"]+)"/)
      const ee = body.match(/var ee="([^"]+)"/)
      const seq = body.match(/var seq="?(\d+)"?/)
      if (nn?.[1] !== undefined && ee?.[1] !== undefined && seq?.[1] !== undefined) {
        return { nn: nn[1], ee: ee[1], seq: Number(seq[1]) }
      }
      console.warn(
        `[router] getGDPRParm attempt ${attempt + 1}: status ${response.status}, ${body.length} bytes, no RSA params`,
      )
    }
    throw new Error('getGDPRParm never returned RSA params after 6 attempts')
  }

  private async login(): Promise<Session> {
    const { nn, ee, seq } = await this.fetchRsaParams()
    const now = Date.now()
    const session: Session = {
      key: String(now).padEnd(16, '0').slice(0, 16),
      iv: String(now + 7).padEnd(16, '0').slice(0, 16),
      hash: md5(this.options.user + this.options.password),
      nn,
      ee,
      seq,
      cookie: '',
      tokenId: '',
      since: now,
      reads: 0,
    }

    const login = await this.post(
      session,
      '/cgi_gdpr?9',
      JSON.stringify({
        data: {
          UserName: b64(this.options.user),
          Passwd: b64(this.options.password),
          Action: '1',
          stack: '0,0,0,0,0,0',
          pstack: '0,0,0,0,0,0',
        },
        operation: 'cgi',
        oid: '/cgi/login',
      }) + '\r\n',
      true,
    )
    if (login.status !== 200) throw new Error(`router login failed with status ${login.status}`)
    await Bun.sleep(400)

    // The TokenID only exists in the logged-in HTML shell; there is no API for it.
    const shell = await this.fetch('/', {
      headers: {
        'User-Agent': UA,
        Referer: `${this.options.baseUrl}/`,
        Cookie: session.cookie,
        Accept: 'text/html',
      },
    })
    const html = await shell.text()
    const token = html.match(/var token="([0-9a-f]+)"/)
    if (token?.[1] === undefined) {
      throw new Error('no TokenID in the logged-in shell — the login did not take')
    }
    session.tokenId = token[1]
    await Bun.sleep(400)
    console.log(`[router] logged in, session established (shell ${html.length} bytes)`)
    return session
  }

  private rsa(session: Session, plain: string): string {
    const n = BigInt('0x' + session.nn)
    const e = BigInt('0x' + session.ee)
    const bytes = Buffer.from(plain, 'utf8')
    let out = ''
    for (let i = 0; i < bytes.length; i += 64) {
      const block = Buffer.alloc(64)
      bytes.subarray(i, i + 64).copy(block)
      let value = 0n
      for (const byte of block) value = (value << 8n) | BigInt(byte)
      out += modPow(value, e, n).toString(16).padStart(128, '0')
    }
    return out
  }

  private async post(
    session: Session,
    path: string,
    plain: string,
    isLogin = false,
  ): Promise<{ status: number; body: string }> {
    const cipher = createCipheriv('aes-128-cbc', Buffer.from(session.key), Buffer.from(session.iv))
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64')
    const signed = isLogin
      ? `key=${session.key}&iv=${session.iv}&h=${session.hash}&s=${session.seq + data.length}`
      : `h=${session.hash}&s=${session.seq + data.length}`

    const response = await this.fetch(path, {
      method: 'POST',
      headers: this.headers(session, 'text/plain, */*; q=0.01'),
      body: `sign=${this.rsa(session, signed)}\r\ndata=${data}\r\n`,
    })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) session.cookie = setCookie.split(';')[0] ?? session.cookie

    const raw = await response.text()
    let body = raw
    try {
      const decipher = createDecipheriv(
        'aes-128-cbc',
        Buffer.from(session.key),
        Buffer.from(session.iv),
      )
      body = Buffer.concat([
        decipher.update(Buffer.from(raw.trim(), 'base64')),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      // Not AES-decryptable: either an error page or a response to a session the
      // router no longer knows. Left as-is for the caller to classify.
    }
    return { status: response.status, body }
  }

  /**
   * Decides what a failed request *means*, which the error itself does not say.
   *
   * Measured: when a second login evicts this session, the router does not answer
   * with a status or an error page — it closes the socket, and every subsequent
   * request on that session does the same. An unclassified transport error would
   * therefore leave the client believing it still holds a session it lost, and
   * hammering the device forever instead of backing off.
   *
   * So the client asks the one question that separates the two causes: is the
   * router answering anyone at all? If it is, this session is the thing that
   * died — back off before reclaiming the single admin slot from whoever took
   * it. If it is not, the device is down or the network is, and there is no
   * session to be polite about.
   */
  private async classifyTransportFailure(error: unknown, oid: string): Promise<Error> {
    const detail = error instanceof Error ? error.message : String(error)
    if (await this.isReachable()) {
      this.invalidate(`transport failure on ${oid} while the router still answers`)
      return new RouterSessionLostError(detail)
    }
    return new RouterUnreachableError(detail)
  }

  private async isReachable(): Promise<boolean> {
    try {
      const response = await this.fetch('/', { method: 'GET', headers: { 'User-Agent': UA } })
      return response.status < 500
    } catch {
      return false
    }
  }

  private async readWith(
    session: Session,
    oid: string,
    operation: RouterOperation,
  ): Promise<RouterRow[]> {
    const payload =
      JSON.stringify({ data: { stack: '0,0,0,0,0,0', pstack: '0,0,0,0,0,0' }, operation, oid }) +
      '\r\n'

    // 406 is this device under load, not a protocol answer. Back off and retry.
    let response: { status: number; body: string } | null = null
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await Bun.sleep(800 * attempt)
      let attempted: { status: number; body: string }
      try {
        attempted = await this.post(session, '/cgi_gdpr?9', payload)
      } catch (error) {
        throw await this.classifyTransportFailure(error, oid)
      }
      if (attempted.status !== 406) {
        response = attempted
        break
      }
      console.warn(`[router] 406 on ${oid} ${operation}, attempt ${attempt + 1}`)
    }
    if (response === null) throw new RouterBusyError(oid)

    if (response.status === 401 || response.status === 403) {
      this.invalidate(`HTTP ${response.status} on ${oid}`)
      throw new RouterSessionLostError(`HTTP ${response.status}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(response.body)
    } catch {
      // A live session always answers with an AES-encrypted JSON envelope. An
      // unparsable body means this session is no longer the one the router
      // holds — the usual cause being a login from the router UI evicting it.
      this.invalidate(`unparsable response to ${oid} (HTTP ${response.status})`)
      throw new RouterSessionLostError(
        `unparsable body (HTTP ${response.status}, ${response.body.length} bytes)`,
      )
    }

    const envelope = parsed as { errorcode?: unknown; data?: unknown }
    const errorcode = envelope.errorcode === undefined ? '0' : String(envelope.errorcode)
    if (errorcode !== '0') throw new RouterOidError(oid, errorcode)

    session.reads += 1
    const instances: Array<Record<string, unknown>> = Array.isArray(envelope.data)
      ? (envelope.data as Array<Record<string, unknown>>)
      : envelope.data !== undefined && envelope.data !== null
        ? [envelope.data as Record<string, unknown>]
        : []
    return instances.map(redactRow)
  }
}

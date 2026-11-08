import { describe, expect, it } from 'bun:test'
import { RouterClient, RouterSessionLostError, RouterUnreachableError } from './client.js'

/**
 * `post` and `fetch` are the two transport seams; everything above them (the
 * envelope parse, the classification) is what these tests exercise. No socket
 * is opened.
 */
interface Seams {
  session: unknown
  post: (...args: unknown[]) => Promise<{ status: number; body: string }>
  fetch: (...args: unknown[]) => Promise<{ status: number }>
}

function clientWith(options: {
  post: Seams['post']
  fetch?: Seams['fetch']
  loggedIn?: boolean
}): RouterClient {
  const client = new RouterClient({
    baseUrl: 'http://router.invalid',
    user: 'user',
    password: 'not-a-real-password',
    requestTimeoutMs: 100,
  })
  const seams = client as unknown as Seams
  seams.session =
    options.loggedIn === false
      ? null
      : { key: 'k', iv: 'i', hash: 'h', nn: 'n', ee: 'e', seq: 0, cookie: '', tokenId: 't' }
  seams.post = options.post
  seams.fetch = options.fetch ?? (() => Promise.resolve({ status: 200 }))
  return client
}

const answer = (status: number, body: string) => () => Promise.resolve({ status, body })

describe('RouterClient.sendAction errorcode parsing', () => {
  it('reads errorcode 0 as ok', async () => {
    const client = clientWith({ post: answer(200, '{"errorcode":0}') })
    const response = await client.sendAction({ intent: 'reboot', stack: '0,0,0,0,0,0' })
    expect(response).toMatchObject({ ok: true, errorcode: '0', httpStatus: 200 })
  })

  it('reads errorcode 1 as an explicit rejection', async () => {
    const client = clientWith({ post: answer(200, '{"errorcode":1}') })
    const response = await client.sendAction({ intent: 'reboot', stack: '0,0,0,0,0,0' })
    expect(response).toMatchObject({ ok: false, errorcode: '1', httpStatus: 200 })
  })

  it('treats an envelope without errorcode as 0, as reads do', async () => {
    const client = clientWith({ post: answer(200, '{}') })
    const response = await client.sendAction({ intent: 'dhcp_renew', stack: '3,0,0,0,0,0' })
    expect(response).toMatchObject({ ok: true, errorcode: '0' })
  })

  it('leaves errorcode null for an unparsable body and never calls it ok', async () => {
    const client = clientWith({ post: answer(200, 'not json') })
    const response = await client.sendAction({ intent: 'reboot', stack: '0,0,0,0,0,0' })
    expect(response).toMatchObject({ ok: false, errorcode: null, httpStatus: 200 })
  })

  it('does not call a non-200 ok even with errorcode 0', async () => {
    const client = clientWith({ post: answer(500, '{"errorcode":0}') })
    const response = await client.sendAction({ intent: 'reboot', stack: '0,0,0,0,0,0' })
    expect(response.ok).toBe(false)
    expect(response.httpStatus).toBe(500)
  })

  it('throws a lost session when no session is held', async () => {
    const client = clientWith({ post: answer(200, '{}'), loggedIn: false })
    await expect(client.sendAction({ intent: 'reboot', stack: 'x' })).rejects.toBeInstanceOf(
      RouterSessionLostError,
    )
  })
})

describe('RouterClient transport failure classification', () => {
  const dies = () => Promise.reject(new Error('socket closed'))

  it('is a lost session, and drops the session, while the router still answers', async () => {
    const client = clientWith({ post: dies, fetch: () => Promise.resolve({ status: 200 }) })
    await expect(client.sendAction({ intent: 'reboot', stack: 'x' })).rejects.toBeInstanceOf(
      RouterSessionLostError,
    )
    expect(client.status().loggedIn).toBe(false)
  })

  it('is unreachable when the router answers nobody', async () => {
    const client = clientWith({ post: dies, fetch: () => Promise.reject(new Error('refused')) })
    await expect(client.sendAction({ intent: 'reboot', stack: 'x' })).rejects.toBeInstanceOf(
      RouterUnreachableError,
    )
  })

  it('is unreachable when the router answers with a 5xx', async () => {
    const client = clientWith({ post: dies, fetch: () => Promise.resolve({ status: 503 }) })
    await expect(client.sendAction({ intent: 'reboot', stack: 'x' })).rejects.toBeInstanceOf(
      RouterUnreachableError,
    )
  })
})

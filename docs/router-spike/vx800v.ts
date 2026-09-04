/**
 * TP-Link Archer VX800v — headless read client.
 * Login -> mint TokenID from the logged-in shell -> read a data-model OID.
 */
import { createHash, createCipheriv, createDecipheriv } from 'node:crypto'

const BASE = 'http://192.168.1.1'
const LOGIN_USER = 'user'                 // <- NOT "admin": hash + UserName both use "user"
const PASS = process.env.ROUTER_PASSWORD!
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
function modPow(b: bigint, e: bigint, m: bigint) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n } return r }

const key = String(Date.now()).padEnd(16, '0').slice(0, 16)
const iv  = String(Date.now() + 7).padEnd(16, '0').slice(0, 16)
const hash = md5(LOGIN_USER + PASS)

let nn = '', ee = '', seq = 0, cookie = '', tokenid = ''

const rsa = (p: string) => {
  const n = BigInt('0x' + nn), e = BigInt('0x' + ee)
  const by = Buffer.from(p, 'utf8'); let o = ''
  for (let i = 0; i < by.length; i += 64) {
    const bl = Buffer.alloc(64); by.subarray(i, i + 64).copy(bl)
    let m = 0n; for (const x of bl) m = (m << 8n) | BigInt(x)
    o += modPow(m, e, n).toString(16).padStart(128, '0')
  }
  return o
}
const encA = (p: string) => { const c = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv)); return Buffer.concat([c.update(p, 'utf8'), c.final()]).toString('base64') }
const decA = (b: string) => { const c = createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv)); return Buffer.concat([c.update(Buffer.from(b, 'base64')), c.final()]).toString('utf8') }

const H = () => {
  const h: Record<string, string> = { 'User-Agent': UA, Referer: `${BASE}/`, Origin: BASE, 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/plain, */*; q=0.01', 'Content-Type': 'text/plain' }
  if (cookie) h.Cookie = cookie
  if (tokenid) h.TokenID = tokenid
  return h
}
async function post(path: string, plain: string, isLogin = false) {
  const d = encA(plain)
  const s = isLogin ? `key=${key}&iv=${iv}&h=${hash}&s=${seq + d.length}` : `h=${hash}&s=${seq + d.length}`
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: H(), body: `sign=${rsa(s)}\r\ndata=${d}\r\n` })
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]
  const raw = await r.text()
  let o = raw; try { o = decA(raw.trim()) } catch {}
  return { status: r.status, o }
}

// 1. RSA params + seq
{
  const t = await (await fetch(`${BASE}/cgi/getGDPRParm`, { method: 'POST', headers: H() })).text()
  nn = t.match(/var nn="([^"]+)"/)![1]; ee = t.match(/var ee="([^"]+)"/)![1]; seq = Number(t.match(/var seq="?(\d+)"?/)![1])
}
// 2. login (payload key order + base64 username matter to nothing, but this is what the UI sends)
const li = await post('/cgi_gdpr?9', JSON.stringify({
  data: { UserName: b64(LOGIN_USER), Passwd: b64(PASS), Action: '1', stack: '0,0,0,0,0,0', pstack: '0,0,0,0,0,0' },
  operation: 'cgi', oid: '/cgi/login',
}) + '\r\n', true)
console.log('login          :', li.status, JSON.stringify(li.o.trim()))
await Bun.sleep(400)

// 3. mint TokenID from the logged-in shell served at "/"
const html = await (await fetch(`${BASE}/`, { headers: { 'User-Agent': UA, Referer: `${BASE}/`, Cookie: cookie, Accept: 'text/html' } })).text()
const tm = html.match(/var token="([0-9a-f]+)"/)
console.log('GET / shell    :', html.length, 'bytes, token', tm ? 'FOUND' : 'NOT FOUND')
if (!tm) process.exit(1)
tokenid = tm[1]
await Bun.sleep(400)

// 4. read
async function read(oid: string, operation: 'go' | 'gl' = 'gl') {
  const r = await post('/cgi_gdpr?9', JSON.stringify({ data: { stack: '0,0,0,0,0,0', pstack: '0,0,0,0,0,0' }, operation, oid }) + '\r\n')
  return { status: r.status, json: (() => { try { return JSON.parse(r.o) } catch { return r.o } })() }
}
for (const oid of ['DEV2_DSL_LINE', 'DEV2_DSL_CHANNEL', 'DEV2_DSL_LINE_STATS']) {
  const r = await read(oid)
  const d = (r.json as any)?.data?.[0] ?? r.json
  console.log(`\n=== ${oid} (${r.status})`)
  if (typeof d === 'object') {
    const pick = Object.entries(d).filter(([k, v]) => v !== '' && v !== undefined).slice(0, 200)
    console.log(pick.map(([k, v]) => `  ${k} = ${v}`).join('\n'))
  } else console.log('  ', d)
  await Bun.sleep(700)
}

/**
 * TP-Link Archer VX800v — OID discovery sweep.
 *
 * Logs in ONCE, holds the session (the router evicts the previous admin session on every
 * login, so re-logging per request would fight a human in the router UI), then reads each
 * OID with `go` and falls back to `gl` when the router answers errorcode 9003.
 *
 * Output is REDACTED before it is written anywhere: DEV2_ADT_WAN returns the PPPoE username
 * and password in cleartext, and this output must be safe to paste into a public repo's
 * design notes. The denylist is applied to every OID, not just the WAN one.
 *
 * Usage:
 *   bun discover.ts                       # curated set
 *   bun discover.ts --all                 # every self-named DEV2_* OID from oid_str.js
 *   bun discover.ts DEV2_HOSTS DEV2_IQOS  # explicit list
 */
import { createHash, createCipheriv, createDecipheriv } from 'node:crypto'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'

const BASE = 'http://192.168.1.1'
const LOGIN_USER = 'user' // NOT "admin": hash + UserName both use "user"
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const OUT = '/tmp/lw-oid-discovery.jsonl'

const PASS =
  process.env.ROUTER_PASSWORD ??
  readFileSync(`${homedir()}/.config/linewatch/router-password`, 'utf8').trim()

/**
 * Anything matching these key patterns is replaced with a marker rather than its value.
 * Deliberately broad: a false positive costs one redacted field in a discovery dump, a false
 * negative puts a household credential in a public repo.
 */
const SECRET_KEY = /pass|pwd|secret|psk|token|credential|\bpin\b|privkey|private_?key|^key$|serial|imei|iccid/i
/** WAN/PPP OIDs additionally leak the account identity, which is as sensitive as the password. */
const IDENTITY_KEY = /user_?name|^user$|account|login|subscriber|circuit_?id/i

function redactValue(oid: string, key: string, value: unknown): unknown {
  if (SECRET_KEY.test(key)) return '<redacted:secret>'
  if (IDENTITY_KEY.test(key)) return '<redacted:identity>'
  // Public IPs are also not committable. Keep RFC1918 / CGNAT so LAN topology stays readable.
  if (typeof value === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const [a, b] = value.split('.').map(Number)
    const priv =
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 192 && b === 168) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      a >= 224
    if (!priv) return '<redacted:public-ip>'
  }
  // MAC addresses: keep the OUI, drop the device-unique half.
  if (typeof value === 'string' && /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(value)) {
    return value.split(/[:-]/).slice(0, 3).join(':') + ':XX:XX:XX'
  }
  return value
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
function modPow(b: bigint, e: bigint, m: bigint) {
  let r = 1n
  b %= m
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m
    b = (b * b) % m
    e >>= 1n
  }
  return r
}

const key = String(Date.now()).padEnd(16, '0').slice(0, 16)
const iv = String(Date.now() + 7).padEnd(16, '0').slice(0, 16)
const hash = md5(LOGIN_USER + PASS)

let nn = '',
  ee = '',
  seq = 0,
  cookie = '',
  tokenid = ''

const rsa = (p: string) => {
  const n = BigInt('0x' + nn),
    e = BigInt('0x' + ee)
  const by = Buffer.from(p, 'utf8')
  let o = ''
  for (let i = 0; i < by.length; i += 64) {
    const bl = Buffer.alloc(64)
    by.subarray(i, i + 64).copy(bl)
    let m = 0n
    for (const x of bl) m = (m << 8n) | BigInt(x)
    o += modPow(m, e, n).toString(16).padStart(128, '0')
  }
  return o
}
const encA = (p: string) => {
  const c = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv))
  return Buffer.concat([c.update(p, 'utf8'), c.final()]).toString('base64')
}
const decA = (b: string) => {
  const c = createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv))
  return Buffer.concat([c.update(Buffer.from(b, 'base64')), c.final()]).toString('utf8')
}

const H = () => {
  const h: Record<string, string> = {
    'User-Agent': UA,
    Referer: `${BASE}/`,
    Origin: BASE,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'text/plain, */*; q=0.01',
    'Content-Type': 'text/plain',
  }
  if (cookie) h.Cookie = cookie
  if (tokenid) h.TokenID = tokenid
  return h
}

async function post(path: string, plain: string, isLogin = false) {
  const d = encA(plain)
  const s = isLogin
    ? `key=${key}&iv=${iv}&h=${hash}&s=${seq + d.length}`
    : `h=${hash}&s=${seq + d.length}`
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: H(),
    body: `sign=${rsa(s)}\r\ndata=${d}\r\n`,
  })
  const sc = r.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]!
  const raw = await r.text()
  let o = raw
  try {
    o = decA(raw.trim())
  } catch {}
  return { status: r.status, o }
}

// ---------------------------------------------------------------------------

/**
 * getGDPRParm intermittently answers 406 (or a 200 with an unrelated body) under any load and
 * recovers on retry. That is device flakiness, not a protocol error — treat it as such, or the
 * poller will look broken every few runs.
 */
async function fetchRsaParams() {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await Bun.sleep(700 * attempt)
    const r = await fetch(`${BASE}/cgi/getGDPRParm`, { method: 'POST', headers: H() })
    const t = await r.text()
    const mn = t.match(/var nn="([^"]+)"/)
    const me = t.match(/var ee="([^"]+)"/)
    const ms = t.match(/var seq="?(\d+)"?/)
    if (mn && me && ms) return { nn: mn[1]!, ee: me[1]!, seq: Number(ms[1]) }
    console.error(
      `[retry] getGDPRParm attempt ${attempt + 1}: status ${r.status}, ${t.length} bytes, no RSA params`,
    )
  }
  throw new Error('getGDPRParm never returned RSA params after 6 attempts')
}

async function login() {
  const p = await fetchRsaParams()
  nn = p.nn
  ee = p.ee
  seq = p.seq

  const li = await post(
    '/cgi_gdpr?9',
    JSON.stringify({
      data: {
        UserName: b64(LOGIN_USER),
        Passwd: b64(PASS),
        Action: '1',
        stack: '0,0,0,0,0,0',
        pstack: '0,0,0,0,0,0',
      },
      operation: 'cgi',
      oid: '/cgi/login',
    }) + '\r\n',
    true,
  )
  if (li.status !== 200) throw new Error(`login failed: ${li.status} ${li.o.slice(0, 200)}`)
  await Bun.sleep(400)

  const html = await (
    await fetch(`${BASE}/`, {
      headers: { 'User-Agent': UA, Referer: `${BASE}/`, Cookie: cookie, Accept: 'text/html' },
    })
  ).text()
  const tm = html.match(/var token="([0-9a-f]+)"/)
  if (!tm) throw new Error('no TokenID in the logged-in shell — login did not take')
  tokenid = tm[1]!
  await Bun.sleep(400)
  console.error(`[login] ok, token minted, shell ${html.length} bytes`)
}

/** One read attempt. Returns null on 406 so the caller can back off and retry. */
async function tryRead(oid: string, operation: 'go' | 'gl') {
  const r = await post(
    '/cgi_gdpr?9',
    JSON.stringify({ data: { stack: '0,0,0,0,0,0', pstack: '0,0,0,0,0,0' }, operation, oid }) +
      '\r\n',
  )
  if (r.status === 406) return null
  let json: unknown = r.o
  try {
    json = JSON.parse(r.o)
  } catch {}
  return { status: r.status, json }
}

async function readOid(oid: string) {
  for (const operation of ['go', 'gl'] as const) {
    let res: Awaited<ReturnType<typeof tryRead>> = null
    for (let attempt = 0; attempt < 4 && res === null; attempt++) {
      if (attempt > 0) await Bun.sleep(800 * attempt)
      res = await tryRead(oid, operation)
      if (res === null) console.error(`[406] ${oid} ${operation} attempt ${attempt + 1}`)
    }
    if (res === null) return { oid, operation, outcome: '406-exhausted' as const }

    const j = res.json as any
    const errorcode = j?.errorcode
    // 9003 = wrong operation for this object kind; try the other one.
    if (String(errorcode) === '9003') continue
    if (errorcode !== undefined && String(errorcode) !== '0') {
      return { oid, operation, outcome: 'errorcode' as const, errorcode: String(errorcode) }
    }

    const entries: Array<Record<string, unknown>> = Array.isArray(j?.data)
      ? j.data
      : j?.data
        ? [j.data]
        : []
    const rows = entries.map((e) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(e)) {
        if (v === '' || v === undefined) continue
        out[k] = redactValue(oid, k, v)
      }
      return out
    })
    const populated = rows.some((r) => Object.keys(r).filter((k) => k !== 'stack').length > 0)
    return {
      oid,
      operation,
      outcome: populated ? ('populated' as const) : ('empty' as const),
      instances: rows.length,
      rows: rows.slice(0, 12),
    }
  }
  return { oid, operation: 'both', outcome: 'unsupported' as const }
}

// ---------------------------------------------------------------------------

const CURATED = [
  // line / carrier
  'DEV2_DSL_LINE', 'DEV2_DSL_LINE_STATS', 'DEV2_DSL_LINE_STATS_TOT', 'DEV2_DSL_LINE_SHOW_TIME',
  'DEV2_DSL_LINE_CURR_DAY', 'DEV2_DSL_LINE_QUART_HOUR', 'DEV2_DSL_CHANNEL', 'DEV2_FAST_LINE',
  // wan / connection state (credentials redacted)
  'DEV2_ADT_WAN', 'DEV2_WAN_COMMON', 'DEV2_DEV_INFO', 'DEV2_MEM_STATUS', 'DEV2_PROC_STATUS',
  // who is connected
  'DEV2_HOSTS', 'DEV2_ADT_WIFI_CLIENT', 'DEV2_WIFI_APDEV_ASSOCDEV', 'DEV2_ADT_WIFI_MACTABLE',
  'DEV2_WIFI_APDEV_QOE',
  // per-client bandwidth / queues
  'DEV2_IQOS', 'DEV2_IQOS_DB', 'DEV2_QOS_FLOW', 'DEV2_QOS_QUEUE', 'DEV2_QOS_POLICER',
  // interfaces
  'DEV2_ETH_INTF_STATS', 'DEV2_IP_INTF_STATS', 'DEV2_ETH_LINK',
  // future: fibre
  'DEV2_GPON_INFO', 'DEV2_GPON_STATS',
]

let oids: string[]
const args = process.argv.slice(2)
if (args.includes('--all')) {
  const src = readFileSync(`${import.meta.dir}/oid_str.js`, 'utf8')
  const seen = new Set<string>()
  for (const m of src.matchAll(/var ([A-Z0-9_]+) = "([^"]+)"/g)) {
    if (m[1] === m[2] && m[1]!.startsWith('DEV2')) seen.add(m[1]!)
  }
  oids = [...seen]
} else if (args.length > 0) {
  oids = args
} else {
  oids = CURATED
}

await login()
writeFileSync(OUT, '')
console.error(`[sweep] ${oids.length} OIDs -> ${OUT}`)

const tally: Record<string, number> = {}
for (const [i, oid] of oids.entries()) {
  let rec: Awaited<ReturnType<typeof readOid>>
  try {
    rec = await readOid(oid)
  } catch (e) {
    rec = { oid, operation: 'both', outcome: 'threw' as any, errorcode: String(e) } as any
  }
  tally[rec.outcome] = (tally[rec.outcome] ?? 0) + 1
  appendFileSync(OUT, JSON.stringify(rec) + '\n')
  const mark =
    rec.outcome === 'populated' ? '+' : rec.outcome === 'empty' ? '.' : rec.outcome === 'unsupported' ? '-' : '!'
  console.error(`${mark} [${i + 1}/${oids.length}] ${oid} ${rec.outcome}`)
  await Bun.sleep(350)
}

console.error(`\n[done] ${JSON.stringify(tally)}`)
console.error(`[done] ${OUT}`)

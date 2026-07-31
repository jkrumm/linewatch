/**
 * Router-response redaction, applied at PARSE time.
 *
 * `DEV2_ADT_WAN` returns `PPPUserName` and `PPPPassword` in cleartext, plus the
 * unit's serial number, the WAN IPv6 address and the ISP's own tariff name in
 * `customConnName`/`alias`. This repository is public and its logs get pasted
 * into design notes, so the denylist runs inside the client — every row is
 * redacted before it is logged, persisted or returned by a route. Redacting at
 * the log site instead would leave the raw value one careless `console.log`
 * away from a commit.
 *
 * Deliberately broad: a false positive costs one unused field, a false negative
 * puts a household credential in a public repository.
 */

const SECRET_KEY =
  /pass|pwd|secret|psk|token|credential|\bpin\b|privkey|private_?key|^key$|serial|imei|iccid/i

/**
 * The account identity is as sensitive as the password, and on this unit the
 * ISP's product name (`customConnName`, the per-connection `alias`) and the
 * DS-Lite AFTR hostname identify the line's owner just as well. None of the
 * fields the poller actually reads match these patterns — the port alias it
 * stores is `X_TP_IfNameAlias`, which `^alias$` does not touch.
 *
 * Device names are here for a second reason: 20 of 102 host entries this line
 * stored were vendor defaults of the form three-letter prefix + 12 hex digits,
 * i.e. a MAC address with its separators stripped, which the value-level MAC
 * pattern below cannot see. The name column is gone from `router_host`
 * entirely, so this only has to stop a raw row reaching a log — but a key
 * denylist is the cheaper of the two guards to keep.
 */
const IDENTITY_KEY =
  /user_?name|^user$|account|login|subscriber|circuit_?id|customconnname|^alias$|aftr|host_?name|device_?name|nick_?name|friendly_?name/i

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const MAC = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/
const IPV6 = /^[0-9A-Fa-f]*:[0-9A-Fa-f:]*(\/\d{1,3})?$/

export const REDACTED_SECRET = '<redacted:secret>'
export const REDACTED_IDENTITY = '<redacted:identity>'
export const REDACTED_PUBLIC_IP = '<redacted:public-ip>'
export const DROPPED_NESTED = '<dropped:nested>'

/** True for addresses that reveal nothing about the subscriber. */
function isPrivateIpv4(value: string): boolean {
  const [a, b] = value.split('.').map(Number)
  if (a === undefined || b === undefined) return false
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  )
}

/** Unspecified, loopback, link-local (fe80::/10) and unique-local (fc00::/7). */
function isPrivateIpv6(value: string): boolean {
  const address = value.toLowerCase().split('/')[0] ?? ''
  if (address === '' || address === '::' || address === '::1') return true
  return address.startsWith('fe80') || /^f[cd]/.test(address)
}

/** The redacted form of one field, decided by key first and value second. */
export function redactValue(key: string, value: unknown): string {
  if (SECRET_KEY.test(key)) return REDACTED_SECRET
  if (IDENTITY_KEY.test(key)) return REDACTED_IDENTITY

  // A nested object could smuggle a secret past the key check, and this API
  // never returns one — so drop it rather than flatten it and hope.
  if (value !== null && typeof value === 'object') return DROPPED_NESTED

  const text = String(value)
  // MAC before IPv6: a MAC matches the IPv6 character class too. Keep the OUI
  // (which identifies the vendor, not the device) and drop the unique half.
  if (MAC.test(text)) return text.split(/[:-]/).slice(0, 3).join(':') + ':XX:XX:XX'
  if (IPV4.test(text) && !isPrivateIpv4(text)) return REDACTED_PUBLIC_IP
  if (IPV6.test(text) && text.includes(':') && !isPrivateIpv6(text)) return REDACTED_PUBLIC_IP
  return text
}

/** One router row, values redacted and empty fields dropped. */
export type RouterRow = Record<string, string>

export function redactRow(row: Record<string, unknown>): RouterRow {
  const out: RouterRow = {}
  for (const [key, value] of Object.entries(row)) {
    if (value === '' || value === undefined || value === null) continue
    out[key] = redactValue(key, value)
  }
  return out
}

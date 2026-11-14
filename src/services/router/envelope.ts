import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * The AES half of the router's `/cgi_gdpr` envelope: AES-128-GCM, as the
 * firmware's own `tpEncrypt.js` does it (`encryptGCM` / `decryptGCM`).
 *
 * The device used to speak AES-128-CBC with a 16-character key and IV, over
 * plain HTTP. It now redirects every HTTP path to an HTTPS-only welcome page
 * (a 200 with no RSA params, which is how the poller first noticed) and speaks
 * GCM. Wire shape, measured against the live device on 2026-11-14:
 *
 * - key: 16 random bytes, IV: 12 random bytes, both sent base64 in the login
 *   signature (`key=<24 chars>&iv=<16 chars>`).
 * - request: `data=<base64 ciphertext>` and a separate `tag=<base64 16-byte tag>`.
 * - response: ONE string, `base64(ciphertext)` immediately followed by
 *   `base64(tag)` — two independently padded base64 blobs back to back, not one
 *   blob. The tag is always 16 bytes = 24 base64 chars, so the split is the last
 *   24 characters.
 */
export interface EnvelopeKey {
  /** base64, 24 characters (16 bytes). */
  key: string
  /** base64, 16 characters (12 bytes). */
  iv: string
}

const TAG_BYTES = 16
const TAG_B64_CHARS = 24

export function newEnvelopeKey(): EnvelopeKey {
  return { key: randomBytes(16).toString('base64'), iv: randomBytes(12).toString('base64') }
}

export function seal(envelope: EnvelopeKey, plain: string): { data: string; tag: string } {
  const cipher = createCipheriv(
    'aes-128-gcm',
    Buffer.from(envelope.key, 'base64'),
    Buffer.from(envelope.iv, 'base64'),
  )
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return { data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

/** Throws when the body is not an authentic GCM answer for this key. */
export function open(envelope: EnvelopeKey, raw: string): string {
  const text = raw.trim()
  if (text.length <= TAG_B64_CHARS) throw new Error('response too short to carry a GCM tag')
  const decipher = createDecipheriv(
    'aes-128-gcm',
    Buffer.from(envelope.key, 'base64'),
    Buffer.from(envelope.iv, 'base64'),
  )
  const tag = Buffer.from(text.slice(-TAG_B64_CHARS), 'base64')
  if (tag.length !== TAG_BYTES) throw new Error('malformed GCM tag')
  decipher.setAuthTag(tag)
  const data = Buffer.from(text.slice(0, -TAG_B64_CHARS), 'base64')
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

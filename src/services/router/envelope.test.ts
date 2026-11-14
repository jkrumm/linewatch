import { describe, expect, it } from 'bun:test'
import { createCipheriv } from 'node:crypto'
import { newEnvelopeKey, open, seal } from './envelope.js'

describe('router GCM envelope', () => {
  it('mints a 16-byte key and a 12-byte IV, base64', () => {
    const { key, iv } = newEnvelopeKey()
    expect(Buffer.from(key, 'base64')).toHaveLength(16)
    expect(key).toHaveLength(24)
    expect(Buffer.from(iv, 'base64')).toHaveLength(12)
    expect(iv).toHaveLength(16)
  })

  it('opens what the device sends: base64(ciphertext) then base64(tag), back to back', () => {
    const envelope = newEnvelopeKey()
    // Odd-length plaintext so the ciphertext blob carries '=' padding mid-string,
    // exactly as the live device's answers do.
    const plain = '$.ret=0;'
    const cipher = createCipheriv(
      'aes-128-gcm',
      Buffer.from(envelope.key, 'base64'),
      Buffer.from(envelope.iv, 'base64'),
    )
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const wire = ct.toString('base64') + cipher.getAuthTag().toString('base64') + '\n'
    expect(wire.slice(0, -1)).toContain('=')
    expect(open(envelope, wire)).toBe(plain)
  })

  it('round-trips what seal produces when tag is appended', () => {
    const envelope = newEnvelopeKey()
    const { data, tag } = seal(envelope, '{"errorcode":0}')
    expect(open(envelope, data + tag)).toBe('{"errorcode":0}')
  })

  it('rejects a tampered body, a foreign key and an HTML page', () => {
    const envelope = newEnvelopeKey()
    const { data, tag } = seal(envelope, '{"errorcode":0}')
    const flipped = (data[0] === 'A' ? 'B' : 'A') + data.slice(1)
    expect(() => open(envelope, flipped + tag)).toThrow()
    expect(() => open(newEnvelopeKey(), data + tag)).toThrow()
    expect(() => open(envelope, '<html>406 Not Acceptable</html>')).toThrow()
    expect(() => open(envelope, '')).toThrow()
  })
})

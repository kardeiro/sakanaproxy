import crypto from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12 // GCM recommended IV length

function getKey(): Buffer {
  // Derive a stable key from a fixed app secret.
  // Note: this protects cookies at rest in the local SQLite DB; it is NOT
  // intended as a strong secret — operators should restrict filesystem access
  // to the data/ directory in production.
  const secret = process.env.SAKANAPROXY_SECRET || 'sakanaproxy-default-local-key-please-change'
  return crypto.createHash('sha256').update(secret).digest()
}

export interface EncryptedPayload {
  v: 1
  iv: string
  data: string
  tag: string
}

export function encrypt(plaintext: string): string {
  if (!plaintext) return ''
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload: EncryptedPayload = {
    v: 1,
    iv: iv.toString('base64'),
    data: enc.toString('base64'),
    tag: tag.toString('base64'),
  }
  return `enc::${JSON.stringify(payload)}`
}

export function decrypt(stored: string): string {
  if (!stored) return ''
  if (!isEncrypted(stored)) return stored
  const json = stored.slice(5)
  const payload = JSON.parse(json) as EncryptedPayload
  const iv = Buffer.from(payload.iv, 'base64')
  const data = Buffer.from(payload.data, 'base64')
  const tag = Buffer.from(payload.tag, 'base64')
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(data), decipher.final()])
  return dec.toString('utf8')
}

export function isEncrypted(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith('enc::')
}

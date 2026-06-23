import crypto from 'crypto'
import { getDatabase } from './database.js'
import { encrypt, decrypt } from './crypto-utils.js'
import { logger } from './logger.js'

export interface SakanaAccount {
  id: string
  label: string
  cookie: string // The sakana-chat=UUID value (without the cookie name prefix)
  email?: string | null
  createdAt?: string
  updatedAt?: string
  cooldown_until?: number
  cooldown_reason?: string | null
}

let accountsCache: SakanaAccount[] | null = null
let accountsCacheTimestamp = 0
const ACCOUNTS_CACHE_TTL = 60_000

function getCachedAccounts(): SakanaAccount[] {
  const now = Date.now()
  if (!accountsCache || (now - accountsCacheTimestamp) > ACCOUNTS_CACHE_TTL) {
    const db = getDatabase()
    const rows = db.prepare(
      'SELECT id, label, cookie, email, created_at, updated_at, cooldown_until, cooldown_reason FROM accounts ORDER BY created_at ASC'
    ).all() as any[]
    accountsCache = rows.map(row => ({
      ...row,
      cookie: decrypt(row.cookie),
    }))
    accountsCacheTimestamp = now
  }
  return accountsCache
}

export function invalidateAccountsCache(): void {
  accountsCache = null
  accountsCacheTimestamp = 0
}

/**
 * Returns accounts with cookies redacted (safe to log/expose).
 */
export function loadAccounts(): SakanaAccount[] {
  return getCachedAccounts().map(a => ({ ...a, cookie: '***' }))
}

export function addAccount(label: string, cookie: string, email?: string): SakanaAccount {
  if (!cookie || typeof cookie !== 'string' || cookie.trim().length === 0) {
    throw new Error('Cookie value is required')
  }

  const cleanCookie = extractCookieValue(cookie.trim())
  if (!cleanCookie) {
    throw new Error('Could not extract sakana-chat cookie value from input')
  }

  const db = getDatabase()
  const id = crypto.randomUUID()
  const encryptedCookie = encrypt(cleanCookie)

  db.prepare(
    'INSERT INTO accounts (id, label, cookie, email) VALUES (?, ?, ?, ?)'
  ).run(id, label || `Account ${id.slice(0, 8)}`, encryptedCookie, email || null)

  invalidateAccountsCache()
  logger.info('Accounts', `Added account ${label || id}`, { id })
  return { id, label, cookie: cleanCookie, email: email || null }
}

export function removeAccount(id: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  if (result.changes > 0) {
    invalidateAccountsCache()
    logger.info('Accounts', `Removed account ${id}`)
  }
  return result.changes > 0
}

export function getAccountCredentials(id: string): SakanaAccount | undefined {
  // Reach into the cache directly so the cookie value is preserved.
  const cached = getCachedAccounts()
  return cached.find(a => a.id === id)
}

/**
 * Returns the full Cookie header value for the given account, e.g.
 *   "sakana-chat=UUID"
 * Suitable for use as the `Cookie` header in fetch calls.
 */
export function buildCookieHeader(account: SakanaAccount): string {
  return `sakana-chat=${account.cookie}`
}

export function updateAccountCooldown(id: string, cooldownUntil: number, reason: string | null): void {
  const db = getDatabase()
  db.prepare('UPDATE accounts SET cooldown_until = ?, cooldown_reason = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(cooldownUntil, reason, id)
  invalidateAccountsCache()
}

/**
 * Accepts either:
 *  - the raw cookie value (UUID)
 *  - a full cookie string like "sakana-chat=UUID; Path=/"
 *  - a JSON array of cookie objects (exported from browser extensions)
 */
export function extractCookieValue(input: string): string | null {
  if (!input) return null

  // Try JSON array of cookie objects (like browser export)
  const trimmed = input.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      for (const c of arr) {
        if (c && c.name === 'sakana-chat' && c.value) {
          return String(c.value)
        }
      }
    } catch {
      // fall through
    }
  }

  // Try parsing as cookie header
  const parts = trimmed.split(';').map(p => p.trim())
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq > 0) {
      const name = part.slice(0, eq).trim()
      const value = part.slice(eq + 1).trim()
      if (name === 'sakana-chat') return value
    }
  }

  // If looks like a UUID, return as-is
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed
  }

  return null
}

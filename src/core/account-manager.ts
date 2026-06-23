import crypto from 'crypto'
import type { SakanaAccount } from './accounts.js'
import { getDatabase } from './database.js'
import { decrypt } from './crypto-utils.js'
import { logger } from './logger.js'

let currentIndex = 0
const inUseAccounts = new Set<string>()

interface CooldownEntry {
  until: number
  reason: string
}

const cooldowns = new Map<string, CooldownEntry>()

const DEFAULT_COOLDOWN_MS = 3 * 60 * 1000

/**
 * Reads the unredacted account list directly from the database (cookies intact).
 * Bypasses the cache used by `loadAccounts()` which redacts cookies for safe display.
 */
export function getUnredactedAccounts(): SakanaAccount[] {
  const db = getDatabase()
  const rows = db.prepare(
    'SELECT id, label, cookie, email, created_at, updated_at, cooldown_until, cooldown_reason FROM accounts ORDER BY created_at ASC'
  ).all() as any[]
  const now = Date.now()
  return rows.map(row => {
    const cooldownUntil = row.cooldown_until || cooldowns.get(row.id)?.until || 0
    const cooldownReason = row.cooldown_reason || cooldowns.get(row.id)?.reason || 'RateLimited'
    if (cooldownUntil && cooldownUntil > now) {
      cooldowns.set(row.id, { until: cooldownUntil, reason: cooldownReason })
    } else if (cooldowns.has(row.id) && (!cooldownUntil || cooldownUntil <= now)) {
      cooldowns.delete(row.id)
    }
    return {
      ...row,
      cookie: decrypt(row.cookie),
    } as SakanaAccount
  })
}

export function markAccountRateLimited(accountId: string, cooldownMs?: number, reason?: string): void {
  const duration = cooldownMs ?? DEFAULT_COOLDOWN_MS
  const until = Date.now() + duration
  const cooldownReason = reason ?? 'RateLimited'

  cooldowns.set(accountId, { until, reason: cooldownReason })

  if (accountId !== 'global') {
    try {
      const db = getDatabase()
      db.prepare('UPDATE accounts SET cooldown_until = ?, cooldown_reason = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(until, cooldownReason, accountId)
    } catch (err) {
      logger.error('AccountManager', `Failed to save cooldown for account ${accountId}`, { error: (err as Error).message })
    }
  }

  logger.warn('AccountManager', `Account ${accountId} marked as rate-limited`, {
    until: new Date(until).toISOString(),
    reason: cooldownReason,
  })
}

export function clearAccountCooldown(accountId: string): void {
  cooldowns.delete(accountId)
  if (accountId !== 'global') {
    try {
      const db = getDatabase()
      db.prepare('UPDATE accounts SET cooldown_until = 0, cooldown_reason = NULL, updated_at = datetime(\'now\') WHERE id = ?')
        .run(accountId)
    } catch (err) {
      logger.error('AccountManager', `Failed to clear cooldown for account ${accountId}`, { error: (err as Error).message })
    }
  }
}

export function getAccountCooldownInfo(accountId: string): { onCooldown: boolean; remainingMs: number; reason: string } | null {
  const entry = cooldowns.get(accountId)
  if (!entry) return null
  const remaining = entry.until - Date.now()
  if (remaining <= 0) {
    cooldowns.delete(accountId)
    if (accountId !== 'global') {
      try {
        const db = getDatabase()
        db.prepare('UPDATE accounts SET cooldown_until = 0, cooldown_reason = NULL WHERE id = ?').run(accountId)
      } catch (err) {
        logger.error('AccountManager', `Failed to clear expired cooldown for ${accountId}`, { error: (err as Error).message })
      }
    }
    return null
  }
  return { onCooldown: true, remainingMs: remaining, reason: entry.reason }
}

function isAccountOnCooldown(accountId: string): boolean {
  return getAccountCooldownInfo(accountId) !== null
}

function isAccountInUse(accountId: string): boolean {
  return inUseAccounts.has(accountId)
}

export function markAccountInUse(accountId: string): void {
  inUseAccounts.add(accountId)
}

export function releaseAccountInUse(accountId: string): void {
  inUseAccounts.delete(accountId)
}

export function getInUseAccounts(): string[] {
  return Array.from(inUseAccounts)
}

/**
 * Returns the next available account (round-robin), preferring accounts not
 * on cooldown and not in use. Falls back to the account with the shortest
 * remaining cooldown if all are rate-limited.
 */
export function getNextAccount(): SakanaAccount | null {
  const accounts = getUnredactedAccounts()
  if (accounts.length === 0) return null

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[currentIndex % accounts.length]
    currentIndex = (currentIndex + 1) % accounts.length
    if (!isAccountOnCooldown(account.id) && !isAccountInUse(account.id)) {
      return account
    }
  }

  // All accounts on cooldown — return the one with the shortest remaining cooldown
  let best: SakanaAccount | null = null
  let bestRemaining = Infinity
  for (const account of accounts) {
    const info = getAccountCooldownInfo(account.id)
    if (info && info.remainingMs < bestRemaining) {
      bestRemaining = info.remainingMs
      best = account
    }
  }
  return best
}

export function getNextAvailableAccount(triedAccountIds?: Set<string> | string): SakanaAccount | null {
  const accounts = getUnredactedAccounts()
  if (accounts.length === 0) return null

  const triedSet = triedAccountIds instanceof Set
    ? triedAccountIds
    : new Set(triedAccountIds ? [triedAccountIds] : [])

  for (let i = 0; i < accounts.length; i++) {
    const idx = (currentIndex + i) % accounts.length
    const account = accounts[idx]
    if (triedSet.has(account.id)) continue
    if (!isAccountOnCooldown(account.id) && !isAccountInUse(account.id)) {
      currentIndex = (idx + 1) % accounts.length
      return account
    }
  }

  // Shortest remaining cooldown among untried
  let best: SakanaAccount | null = null
  let bestRemaining = Infinity
  for (const account of accounts) {
    if (triedSet.has(account.id)) continue
    const info = getAccountCooldownInfo(account.id)
    if (info && info.remainingMs < bestRemaining) {
      bestRemaining = info.remainingMs
      best = account
    }
  }
  return best
}

export function getAccountCount(): number {
  return getUnredactedAccounts().length
}

export function getActiveAccountCount(): number {
  return getUnredactedAccounts().filter(account => !isAccountOnCooldown(account.id)).length
}

export function getCooldownStatus(): Record<string, { remainingMs: number; reason: string }> {
  const result: Record<string, { remainingMs: number; reason: string }> = {}
  for (const [id, info] of cooldowns.entries()) {
    const remaining = info.until - Date.now()
    if (remaining > 0) {
      result[id] = { remainingMs: remaining, reason: info.reason }
    }
  }
  return result
}

// Re-export for convenience
export { loadAccounts } from './accounts.js'

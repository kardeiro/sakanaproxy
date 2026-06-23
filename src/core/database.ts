import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { encrypt, isEncrypted } from './crypto-utils.js'
import { logger } from './logger.js'

const DATA_DIR = path.resolve('data')
const DB_PATH = path.join(DATA_DIR, 'sakanaproxy.db')

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (db) return db

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }

  db = new Database(DB_PATH)

  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = -64000')
  db.pragma('foreign_keys = ON')

  runMigrations(db)
  encryptPlaintextCookies(db)

  return db
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      cookie TEXT NOT NULL,
      email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      cooldown_until INTEGER DEFAULT 0,
      cooldown_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_label ON accounts(label);
  `)
}

function encryptPlaintextCookies(db: Database.Database): void {
  const rows = db.prepare('SELECT id, cookie FROM accounts').all() as Array<{ id: string; cookie: string }>
  const update = db.prepare('UPDATE accounts SET cookie = ? WHERE id = ?')
  let migrated = 0

  const migrate = db.transaction(() => {
    for (const row of rows) {
      if (row.cookie && !isEncrypted(row.cookie)) {
        update.run(encrypt(row.cookie), row.id)
        migrated++
      }
    }
  })

  migrate()

  if (migrated > 0) {
    logger.info('Database', `Encrypted ${migrated} plaintext cookie(s) in database`)
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

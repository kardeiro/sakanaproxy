/**
 * Helper to add an account non-interactively.
 * Usage: npx tsx scripts/add-account.ts <cookie> [label] [email]
 */
import 'dotenv/config'
import { addAccount } from '../src/core/accounts.js'
import { closeDatabase } from '../src/core/database.js'
import { getUserInfo } from '../src/services/sakana.js'
import { logger } from '../src/core/logger.js'

const [cookie, label, email] = process.argv.slice(2)

if (!cookie) {
  console.error('Usage: npx tsx scripts/add-account.ts <cookie> [label] [email]')
  process.exit(1)
}

async function main() {
  const account = addAccount(label || `Account ${Date.now()}`, cookie, email)
  logger.info('AddAccount', `Added ${account.label} (id=${account.id})`)

  const info = await getUserInfo(account)
  if (info && !info.isAnonymous) {
    logger.info('AddAccount', `Valid — logged in as ${info.username || info.email || info.id}`)
  } else if (info) {
    logger.warn('AddAccount', 'Cookie returned anonymous user')
  } else {
    logger.error('AddAccount', 'Cookie is invalid or expired')
  }
  closeDatabase()
}

main().catch(err => {
  logger.error('AddAccount', err.message)
  process.exit(1)
})

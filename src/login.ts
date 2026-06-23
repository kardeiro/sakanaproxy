import 'dotenv/config'
import readline from 'readline'
import { addAccount, loadAccounts, removeAccount, getAccountCredentials } from './core/accounts.js'
import { getUserInfo } from './services/sakana.js'
import { logger } from './core/logger.js'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function prompt(question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, ans => resolve(ans.trim())))
}

async function showMenu(): Promise<string> {
  console.log('\n=== SakanaProxy — Account Manager ===')
  console.log('[A] Add account (paste sakana-chat cookie)')
  console.log('[L] List accounts')
  console.log('[R] Remove an account')
  console.log('[T] Test an account (call /api/user)')
  console.log('[Q] Quit')
  return prompt('\nChoice: ')
}

async function addAccountFlow(): Promise<void> {
  console.log('\n--- Add Account ---')
  console.log('You can paste any of the following:')
  console.log('  • The raw cookie value (UUID) — e.g. f52850d0-515e-445c-8b83-c3b22c0e49c5')
  console.log('  • The full Cookie header — e.g. sakana-chat=UUID; Path=/; Secure')
  console.log('  • The JSON array exported from a cookie browser extension (must contain a name="sakana-chat" entry)')
  console.log('')
  const cookie = await prompt('Paste cookie: ')
  if (!cookie) {
    console.log('Aborted.')
    return
  }
  const label = await prompt('Label (optional, e.g. "main"): ')
  const email = await prompt('Email (optional): ')

  try {
    const account = addAccount(label || `Account ${Date.now()}`, cookie, email || undefined)
    console.log(`\n✓ Added account ${account.label} (id=${account.id})`)

    // Validate immediately
    console.log('Validating cookie via /api/user ...')
    const info = await getUserInfo(account)
    if (info && !info.isAnonymous) {
      console.log(`✓ Valid — logged in as ${info.username || info.email || info.id}`)
    } else if (info) {
      console.log('⚠ Cookie accepted but returned anonymous user.')
    } else {
      console.log('✗ Cookie is invalid or expired.')
    }
  } catch (err: any) {
    console.log(`✗ Failed: ${err.message}`)
  }
}

async function listAccountsFlow(): Promise<void> {
  const accounts = loadAccounts()
  if (accounts.length === 0) {
    console.log('\nNo accounts configured. Run `npm run login` and choose [A] to add one.')
    return
  }
  console.log('\n--- Accounts ---')
  for (const a of accounts) {
    console.log(`  [${a.id}] ${a.label}${a.email ? ` <${a.email}>` : ''}${a.cooldown_until ? ` (cooldown until ${new Date(a.cooldown_until).toISOString()})` : ''}`)
  }
  console.log(`\nTotal: ${accounts.length}`)
}

async function removeAccountFlow(): Promise<void> {
  const accounts = loadAccounts()
  if (accounts.length === 0) {
    console.log('\nNo accounts to remove.')
    return
  }
  await listAccountsFlow()
  const id = await prompt('\nAccount id to remove: ')
  if (!id) {
    console.log('Aborted.')
    return
  }
  if (removeAccount(id)) {
    console.log(`✓ Removed account ${id}`)
  } else {
    console.log(`✗ Account ${id} not found`)
  }
}

async function testAccountFlow(): Promise<void> {
  const accounts = loadAccounts()
  if (accounts.length === 0) {
    console.log('\nNo accounts to test.')
    return
  }
  await listAccountsFlow()
  const id = await prompt('\nAccount id to test: ')
  if (!id) {
    console.log('Aborted.')
    return
  }
  const creds = getAccountCredentials(id)
  if (!creds) {
    console.log(`✗ Account ${id} not found`)
    return
  }
  console.log(`Validating ${creds.label} via /api/user ...`)
  const info = await getUserInfo(creds)
  if (info && !info.isAnonymous) {
    console.log(`✓ Valid — logged in as ${info.username || info.email || info.id}`)
  } else if (info) {
    console.log('⚠ Cookie returned anonymous user.')
  } else {
    console.log('✗ Cookie is invalid or expired.')
  }
}

async function main(): Promise<void> {
  console.log('SakanaProxy — Account Manager')
  console.log(`Default model: ${process.env.SAKANA_DEFAULT_MODEL || 'sakana/namazu-v6.3'}`)

  while (true) {
    const choice = (await showMenu()).toUpperCase()
    if (choice === 'A') await addAccountFlow()
    else if (choice === 'L') await listAccountsFlow()
    else if (choice === 'R') await removeAccountFlow()
    else if (choice === 'T') await testAccountFlow()
    else if (choice === 'Q') break
    else console.log('Invalid choice.')
  }

  rl.close()
  process.exit(0)
}

main().catch(err => {
  logger.error('Login', `Error: ${err.message}`)
  process.exit(1)
})

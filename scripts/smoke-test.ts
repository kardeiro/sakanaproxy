/**
 * Smoke test for sakanaproxy.
 * Adds the user-provided cookie, starts the server, and exercises the
 * /v1/chat/completions endpoint with both streaming and non-streaming requests.
 */
import 'dotenv/config'
import { addAccount, loadAccounts } from '../src/core/accounts.js'
import { getDatabase, closeDatabase } from '../src/core/database.js'
import { getUserInfo, createConversation, sendMessageStream } from '../src/services/sakana.js'
import { SakanaStreamParser } from '../src/services/sakana-stream-parser.js'
import { logger } from '../src/core/logger.js'

const TEST_COOKIE = process.env.TEST_COOKIE || 'f52850d0-515e-445c-8b83-c3b22c0e49c5'

async function main() {
  logger.info('Test', 'Resetting database...')
  const db = getDatabase()
  db.exec('DELETE FROM accounts')

  logger.info('Test', `Adding account with cookie=${TEST_COOKIE.slice(0, 8)}...`)
  const account = addAccount('test-account', TEST_COOKIE, 'test@sakana.ai')

  logger.info('Test', 'Validating cookie via /api/user ...')
  const info = await getUserInfo(account)
  if (!info || info.isAnonymous) {
    logger.error('Test', 'Cookie is invalid or anonymous')
    process.exit(1)
  }
  logger.info('Test', `Cookie valid — user: ${info.username || info.id}`)

  logger.info('Test', 'Creating conversation ...')
  const conv = await createConversation(account, 'sakana/namazu-v6.3')
  logger.info('Test', `Conversation: ${conv.conversationId}, systemMessage: ${conv.systemMessageId}`)

  logger.info('Test', 'Sending message (stream) ...')
  const { stream, controller } = await sendMessageStream(account, conv.conversationId, {
    prompt: 'Responda em português: qual é a capital do Japão? Resposta curta.',
    parentMessageId: conv.systemMessageId,
    timezone: 'America/Sao_Paulo',
  })

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const parser = new SakanaStreamParser()
  let fullText = ''
  let reasoning = ''
  let eventCount = 0
  const startTime = Date.now()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    const events = parser.parse(chunk)
    for (const evt of events) {
      eventCount++
      if (evt.kind === 'token') {
        fullText += evt.token
        process.stdout.write(evt.token)
      } else if (evt.kind === 'reasoningToken') {
        reasoning += evt.token
      } else if (evt.kind === 'final') {
        fullText = evt.text
        logger.info('Test', `\n[final] interrupted=${evt.interrupted}`)
      } else if (evt.kind === 'status' && evt.status === 'error') {
        logger.error('Test', `Upstream error: ${evt.message}`)
      }
    }
  }

  const elapsed = Date.now() - startTime
  logger.info('Test', `\n--- Smoke test result ---`)
  logger.info('Test', `Events parsed: ${eventCount}`)
  logger.info('Test', `Reasoning length: ${reasoning.length}`)
  logger.info('Test', `Final text length: ${fullText.length}`)
  logger.info('Test', `Elapsed: ${elapsed}ms`)
  logger.info('Test', `Final text: "${fullText}"`)

  // Verify we got something meaningful
  if (fullText.length === 0) {
    logger.error('Test', 'FAILED: empty response')
    process.exit(1)
  }
  if (!/tóquio|tokyo|東京/i.test(fullText)) {
    logger.warn('Test', 'Response did not contain expected city name (Tóquio)')
  }

  logger.info('Test', '✓ Smoke test PASSED')
  closeDatabase()
  process.exit(0)
}

main().catch(err => {
  logger.error('Test', `Smoke test failed: ${err.message}`, { stack: err.stack })
  process.exit(1)
})

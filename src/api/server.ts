import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import crypto from 'crypto'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { cache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { logger } from '../core/logger.js'
import { app as modelsApp } from '../routes/models.js'
import { chatCompletions, chatCompletionsStop } from '../routes/chat.js'
import { loadAccounts } from '../core/accounts.js'
import { getUnredactedAccounts } from '../core/account-manager.js'
import { getUserInfo } from '../services/sakana.js'

const app = new Hono()

let watchdog: Watchdog
let server: any

app.use('*', async (c, next) => {
  metrics.increment('requests.total')
  const start = Date.now()
  await next()
  const duration = Date.now() - start
  metrics.histogram('latency.request', duration)
  c.header('X-Response-Time', `${duration}ms`)
})

app.use('/v1/*', async (c, next) => {
  const apiKey = config.apiKey
  if (apiKey) {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }
    const token = auth.slice(7)
    const tokenBuf = Buffer.from(token)
    const keyBuf = Buffer.from(apiKey)
    if (tokenBuf.length !== keyBuf.length || !crypto.timingSafeEqual(tokenBuf, keyBuf)) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
  }
  await next()
})

app.route('', modelsApp)
app.post('/v1/chat/completions', chatCompletions)
app.post('/v1/chat/completions/stop', chatCompletionsStop)

app.get('/health', async (c) => {
  const status = await watchdog?.getStatus()
  return c.json({
    status: status?.overall || 'unknown',
    timestamp: Date.now(),
    accounts: status?.accounts || 0,
    activeAccounts: status?.activeAccounts || 0,
    activeStreams: status?.activeStreams || 0,
    cache: await cache?.getStats(),
  })
})

app.get('/metrics', (c) => {
  return c.text(metrics.formatPrometheus(), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
  })
})

app.get('/v1/accounts', (c) => {
  const accounts = loadAccounts()
  return c.json({ accounts, total: accounts.length })
})

app.onError((err, c) => {
  metrics.increment('requests.errors')
  logger.error('API', `Unhandled error: ${err.message}`, { stack: err.stack })
  return c.json({ error: { message: err.message } }, 500)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export async function startServer(): Promise<void> {
  await cache.connect()

  const accounts = getUnredactedAccounts()
  logger.info('Server', `Loaded ${accounts.length} account(s) from database`)

  // Validate each account cookie by hitting /api/user (best-effort, in parallel with bounded concurrency)
  if (accounts.length > 0) {
    const concurrency = Math.min(config.accounts.initConcurrency, accounts.length)
    let validCount = 0
    let invalidCount = 0

    await Promise.all(accounts.slice(0, concurrency).map(async (account) => {
      try {
        const info = await getUserInfo(account)
        if (info && !info.isAnonymous) {
          validCount++
          logger.info('Server', `Account ${account.label} → user ${info.username || info.id}`)
        } else if (info) {
          logger.warn('Server', `Account ${account.label} returned anonymous user (cookie may be invalid)`)
          invalidCount++
        } else {
          logger.warn('Server', `Account ${account.label} returned no user info (cookie likely expired)`)
          invalidCount++
        }
      } catch (err: any) {
        logger.warn('Server', `Account ${account.label} validation failed: ${err.message}`)
        invalidCount++
      }
    }))

    if (accounts.length > concurrency) {
      logger.info('Server', `(validated ${concurrency}/${accounts.length} accounts at startup; the rest will be validated lazily)`)
    }
    logger.info('Server', `Account validation: ${validCount} valid, ${invalidCount} invalid`)
  } else {
    logger.warn('Server', 'No accounts configured. Run `npm run login` to add a Sakana session cookie.')
  }

  watchdog = new Watchdog()
  watchdog.start()

  metrics.startCollection()

  server = serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host,
  }, (info) => {
    logger.info('Server', `Listening on http://${info.address}:${info.port}`)
  })

  const shutdown = async (signal: string) => {
    logger.info('Server', `Received ${signal}, shutting down gracefully...`)
    watchdog.stop()
    metrics.stopCollection()
    await cache.close()
    const { closeDatabase } = await import('../core/database.js')
    closeDatabase()
    server?.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }

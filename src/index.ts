import 'dotenv/config'
import { startServer } from './api/server.js'
import { logger } from './core/logger.js'

startServer().catch(error => {
  logger.error('Index', `Failed to start server: ${error.message}`, { stack: error.stack })
  process.exit(1)
})

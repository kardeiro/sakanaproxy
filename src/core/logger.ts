import { config } from './config.js'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const CURRENT_LEVEL = LEVEL_PRIORITY[config.logLevel as LogLevel] ?? LEVEL_PRIORITY.info

function format(level: LogLevel, scope: string, msg: string, extra?: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  const base = `[${ts}] [${level.toUpperCase()}] [${scope}] ${msg}`
  if (extra && Object.keys(extra).length > 0) {
    try {
      return `${base} ${JSON.stringify(extra)}`
    } catch {
      return base
    }
  }
  return base
}

export const logger = {
  debug(scope: string, msg: string, extra?: Record<string, unknown>) {
    if (LEVEL_PRIORITY.debug < CURRENT_LEVEL) return
    console.debug(format('debug', scope, msg, extra))
  },
  info(scope: string, msg: string, extra?: Record<string, unknown>) {
    console.log(format('info', scope, msg, extra))
  },
  warn(scope: string, msg: string, extra?: Record<string, unknown>) {
    console.warn(format('warn', scope, msg, extra))
  },
  error(scope: string, msg: string, extra?: Record<string, unknown>) {
    console.error(format('error', scope, msg, extra))
  },
}

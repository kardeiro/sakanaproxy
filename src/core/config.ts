import { z } from 'zod'

const envSchema = z.object({
  PORT: z.string().default('3000'),
  HOST: z.string().default('0.0.0.0'),
  API_KEY: z.string().default(''),
  SAKANA_DEFAULT_MODEL: z.string().default('sakana/namazu-v6.3'),
  HTTP_TIMEOUT: z.string().default('60000'),
  CHAT_TIMEOUT: z.string().default('180000'),
  STREAM_IDLE_TIMEOUT: z.string().default('180000'),
  CACHE_TTL: z.string().default('300'),
  RESPONSE_TTL: z.string().default('1800'),
  METRICS_INTERVAL: z.string().default('10000'),
  WATCHDOG_INTERVAL: z.string().default('30000'),
  WATCHDOG_FAILURES: z.string().default('3'),
  ACCOUNT_INIT_CONCURRENCY: z.string().default('2'),
  METRICS_ENABLED: z.string().default('true'),
  LOG_LEVEL: z.string().default('info'),
})

const env = envSchema.parse(process.env)

export const config = {
  server: {
    port: parseInt(env.PORT),
    host: env.HOST,
  },
  apiKey: env.API_KEY,
  sakana: {
    baseUrl: 'https://chat.sakana.ai',
    defaultModel: env.SAKANA_DEFAULT_MODEL,
    cookieName: 'sakana-chat',
  },
  timeouts: {
    http: parseInt(env.HTTP_TIMEOUT),
    chat: parseInt(env.CHAT_TIMEOUT),
    streamIdle: parseInt(env.STREAM_IDLE_TIMEOUT),
  },
  cache: {
    defaultTTL: parseInt(env.CACHE_TTL),
    responseTTL: parseInt(env.RESPONSE_TTL),
  },
  metrics: {
    interval: parseInt(env.METRICS_INTERVAL),
    enabled: env.METRICS_ENABLED === 'true',
  },
  watchdog: {
    interval: parseInt(env.WATCHDOG_INTERVAL),
    consecutiveFailuresThreshold: parseInt(env.WATCHDOG_FAILURES),
  },
  accounts: {
    initConcurrency: parseInt(env.ACCOUNT_INIT_CONCURRENCY),
  },
  logLevel: env.LOG_LEVEL,
}

export type Config = typeof config

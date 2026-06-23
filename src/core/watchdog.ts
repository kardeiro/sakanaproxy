import { config } from './config.js'
import { getActiveStreamCount } from './stream-registry.js'
import { getActiveAccountCount, getAccountCount } from './account-manager.js'
import { logger } from './logger.js'

export class Watchdog {
  private interval: ReturnType<typeof setInterval> | null = null
  private consecutiveFailures = 0
  private lastStatus: 'ok' | 'degraded' | 'down' = 'ok'

  start(): void {
    if (this.interval) return
    this.interval = setInterval(() => this.tick(), config.watchdog.interval)
    logger.info('Watchdog', `Started (interval=${config.watchdog.interval}ms)`)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private tick(): void {
    try {
      const accounts = getAccountCount()
      const activeAccounts = getActiveAccountCount()
      const activeStreams = getActiveStreamCount()

      let status: 'ok' | 'degraded' | 'down' = 'ok'
      if (accounts === 0) {
        status = 'down'
      } else if (activeAccounts === 0) {
        status = 'degraded'
      }

      if (status !== 'ok') {
        this.consecutiveFailures++
      } else {
        this.consecutiveFailures = 0
      }

      this.lastStatus = status

      if (this.consecutiveFailures >= config.watchdog.consecutiveFailuresThreshold) {
        logger.warn('Watchdog', `System degraded: accounts=${accounts} active=${activeAccounts} streams=${activeStreams}`)
      }
    } catch (err) {
      logger.error('Watchdog', `Tick failed: ${(err as Error).message}`)
    }
  }

  async getStatus(): Promise<{ overall: 'ok' | 'degraded' | 'down'; accounts: number; activeAccounts: number; activeStreams: number }> {
    return {
      overall: this.lastStatus,
      accounts: getAccountCount(),
      activeAccounts: getActiveAccountCount(),
      activeStreams: getActiveStreamCount(),
    }
  }
}

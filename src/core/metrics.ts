import { config } from './config.js'

interface MetricEntry {
  value: number
  count: number
  sum: number
  min: number
  max: number
}

type MetricType = 'counter' | 'gauge' | 'histogram'

class MetricsRegistry {
  private counters = new Map<string, number>()
  private gauges = new Map<string, number>()
  private histograms = new Map<string, MetricEntry>()
  private interval: ReturnType<typeof setInterval> | null = null
  private startedAt = Date.now()

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value)
  }

  histogram(name: string, value: number): void {
    const existing = this.histograms.get(name) ?? {
      value: 0,
      count: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
    }
    existing.count++
    existing.sum += value
    existing.min = Math.min(existing.min, value)
    existing.max = Math.max(existing.max, value)
    existing.value = value
    this.histograms.set(name, existing)
  }

  startCollection(): void {
    if (this.interval || !config.metrics.enabled) return
    this.interval = setInterval(() => {
      // heartbeat — could push to Prometheus pushgateway in the future
    }, config.metrics.interval)
  }

  stopCollection(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  formatPrometheus(): string {
    const lines: string[] = []
    const uptimeSeconds = Math.floor((Date.now() - this.startedAt) / 1000)

    lines.push(`# HELP sakanaproxy_uptime_seconds Server uptime in seconds`)
    lines.push(`# TYPE sakanaproxy_uptime_seconds counter`)
    lines.push(`sakanaproxy_uptime_seconds ${uptimeSeconds}`)

    for (const [name, value] of this.counters.entries()) {
      lines.push(`# TYPE ${name} counter`)
      lines.push(`${name} ${value}`)
    }

    for (const [name, value] of this.gauges.entries()) {
      lines.push(`# TYPE ${name} gauge`)
      lines.push(`${name} ${value}`)
    }

    for (const [name, h] of this.histograms.entries()) {
      const avg = h.count > 0 ? h.sum / h.count : 0
      lines.push(`# TYPE ${name}_sum counter`)
      lines.push(`${name}_sum ${h.sum}`)
      lines.push(`# TYPE ${name}_count counter`)
      lines.push(`${name}_count ${h.count}`)
      lines.push(`# TYPE ${name}_avg gauge`)
      lines.push(`${name}_avg ${avg}`)
      lines.push(`# TYPE ${name}_min gauge`)
      lines.push(`${name}_min ${h.count > 0 ? h.min : 0}`)
      lines.push(`# TYPE ${name}_max gauge`)
      lines.push(`${name}_max ${h.count > 0 ? h.max : 0}`)
    }

    return lines.join('\n') + '\n'
  }

  snapshot(): Record<string, any> {
    return {
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(this.histograms),
    }
  }
}

export const metrics = new MetricsRegistry()

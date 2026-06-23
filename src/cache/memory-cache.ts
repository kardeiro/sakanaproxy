interface CacheEntry<T> {
  value: T
  expiresAt: number
}

class MemoryCache {
  private store = new Map<string, CacheEntry<any>>()
  private connected = false
  private gcInterval: ReturnType<typeof setInterval> | null = null

  async connect(): Promise<void> {
    this.connected = true
    this.gcInterval = setInterval(() => this.gc(), 60_000)
  }

  async close(): Promise<void> {
    this.connected = false
    if (this.gcInterval) {
      clearInterval(this.gcInterval)
      this.gcInterval = null
    }
    this.store.clear()
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key)
      return null
    }
    return entry.value as T
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? 300
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    })
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  async clear(): Promise<void> {
    this.store.clear()
  }

  async getStats(): Promise<{ size: number; connected: boolean }> {
    return { size: this.store.size, connected: this.connected }
  }

  private gc(): void {
    const now = Date.now()
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt < now) {
        this.store.delete(key)
      }
    }
  }
}

export const cache = new MemoryCache()

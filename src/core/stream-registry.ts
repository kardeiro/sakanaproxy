interface StreamEntry {
  abortController: AbortController
  accountId: string
  conversationId: string
  messageId: string | null
  createdAt: number
}

const streams = new Map<string, StreamEntry>()

export function registerStream(id: string, entry: StreamEntry): void {
  streams.set(id, entry)
}

export function removeStream(id: string): void {
  streams.delete(id)
}

export function getStream(id: string): StreamEntry | undefined {
  return streams.get(id)
}

export function getActiveStreamCount(): number {
  return streams.size
}

export function listActiveStreams(): Array<{ id: string } & Omit<StreamEntry, 'abortController'>> {
  const result: Array<{ id: string } & Omit<StreamEntry, 'abortController'>> = []
  for (const [id, entry] of streams.entries()) {
    result.push({
      id,
      accountId: entry.accountId,
      conversationId: entry.conversationId,
      messageId: entry.messageId,
      createdAt: entry.createdAt,
    })
  }
  return result
}

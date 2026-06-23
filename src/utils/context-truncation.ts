import type { Message } from './types.js'

/**
 * Rough token estimator (~3.5 chars/token). Good enough for context-window
 * guards; the upstream provider will re-tokenize authoritatively.
 */
export function estimateTokenCount(text: string, _modelId?: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.5)
}

/**
 * Truncates the message list from the front so the resulting prompt fits
 * within `maxTokens`. Preserves the system message at position 0 if present.
 */
export function truncateMessages(
  messages: Message[],
  maxTokens: number,
  systemPrompt: string,
  modelId?: string,
): Message[] {
  if (messages.length === 0) return []
  const systemTokens = estimateTokenCount(systemPrompt, modelId)
  const budget = maxTokens - 1000 - systemTokens
  if (budget <= 0) return messages.slice(-1)

  const result: Message[] = []
  let total = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
    const tokens = estimateTokenCount(content, modelId)
    if (total + tokens > budget) break
    result.unshift(m)
    total += tokens
  }
  // Always keep at least the last user message
  if (result.length === 0) result.push(messages[messages.length - 1])
  return result
}

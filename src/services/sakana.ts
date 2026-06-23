import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../core/config.js'
import { logger } from '../core/logger.js'
import type { SakanaAccount } from '../core/accounts.js'
import { buildCookieHeader } from '../core/accounts.js'

const BASE_URL = config.sakana.baseUrl
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

export interface SakanaMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface CreateConversationResult {
  conversationId: string
  systemMessageId: string
}

export interface SendMessageOptions {
  prompt: string
  parentMessageId: string
  generationId?: string
  timezone?: string
  isRetry?: boolean
  signal?: AbortSignal
}

export interface SakanaStreamEvent {
  type: string
  [key: string]: any
}

/**
 * Creates a new conversation on Sakana Chat.
 *
 * POST https://chat.sakana.ai/conversation
 * Body: {"model":"sakana/namazu-v6.3"}
 * Returns: {"conversationId":"...","systemMessageId":"..."}
 */
export async function createConversation(
  account: SakanaAccount,
  model: string = config.sakana.defaultModel,
): Promise<CreateConversationResult> {
  const cookie = buildCookieHeader(account)
  const response = await fetch(`${BASE_URL}/conversation`, {
    method: 'POST',
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/`,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(config.timeouts.http),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new SakanaApiError(`Failed to create conversation: ${response.status} ${response.statusText}`, response.status, text)
  }

  const json = await response.json() as CreateConversationResult
  if (!json.conversationId || !json.systemMessageId) {
    throw new SakanaApiError(`Unexpected conversation response: ${JSON.stringify(json).slice(0, 200)}`, 500)
  }
  return json
}

/**
 * Sends a message to a Sakana Chat conversation and returns a ReadableStream
 * of NDJSON events. Each event is one line of JSON terminated by \n.
 *
 * POST https://chat.sakana.ai/conversation/{id}
 * Body: multipart/form-data with field "data" = JSON string
 * Returns: NDJSON stream of MessageUpdate events
 */
export async function sendMessageStream(
  account: SakanaAccount,
  conversationId: string,
  options: SendMessageOptions,
): Promise<{
  stream: ReadableStream<Uint8Array>
  controller: AbortController
}> {
  const cookie = buildCookieHeader(account)
  const generationId = options.generationId || uuidv4()
  const timezone = options.timezone || 'UTC'

  const data = {
    inputs: options.prompt,
    id: options.parentMessageId,
    is_retry: options.isRetry ?? false,
    generationId,
    selectedMcpServerNames: [],
    selectedMcpServers: [],
    timezone,
  }

  // Build multipart/form-data manually because Sakana expects a "data" field
  // containing a JSON string (not a JSON body).
  const boundary = `----sakanaproxy${crypto.randomBytes(8).toString('hex')}`
  const formBody = buildMultipartForm(boundary, [{ name: 'data', value: JSON.stringify(data) }])

  const controller = new AbortController()
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort())
  }

  const response = await fetch(`${BASE_URL}/conversation/${conversationId}`, {
    method: 'POST',
    headers: {
      'Cookie': cookie,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Accept': '*/*',
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/conversation/${conversationId}`,
      'User-Agent': USER_AGENT,
    },
    body: formBody,
    signal: controller.signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new SakanaApiError(`Failed to send message: ${response.status} ${response.statusText}`, response.status, text)
  }
  if (!response.body) {
    throw new SakanaApiError('No stream body returned from Sakana', 500)
  }

  return { stream: response.body, controller }
}

/**
 * Stops generation for a conversation.
 *
 * POST https://chat.sakana.ai/conversation/{id}/stop-generating
 * Body: {"generationId":"...","seenContentLength":N}
 */
export async function stopGeneration(
  account: SakanaAccount,
  conversationId: string,
  generationId: string,
  seenContentLength: number = 0,
): Promise<boolean> {
  const cookie = buildCookieHeader(account)
  try {
    const response = await fetch(`${BASE_URL}/conversation/${conversationId}/stop-generating`, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Origin': BASE_URL,
        'Referer': `${BASE_URL}/conversation/${conversationId}`,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ generationId, seenContentLength }),
      signal: AbortSignal.timeout(config.timeouts.http),
    })
    return response.ok
  } catch (err) {
    logger.warn('Sakana', `stopGeneration failed: ${(err as Error).message}`)
    return false
  }
}

/**
 * Deletes a conversation.
 * DELETE https://chat.sakana.ai/conversation/{id}
 */
export async function deleteConversation(
  account: SakanaAccount,
  conversationId: string,
): Promise<boolean> {
  const cookie = buildCookieHeader(account)
  try {
    const response = await fetch(`${BASE_URL}/conversation/${conversationId}`, {
      method: 'DELETE',
      headers: {
        'Cookie': cookie,
        'Accept': '*/*',
        'Origin': BASE_URL,
        'Referer': `${BASE_URL}/`,
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(config.timeouts.http),
    })
    return response.ok
  } catch (err) {
    logger.warn('Sakana', `deleteConversation failed: ${(err as Error).message}`)
    return false
  }
}

/**
 * Lists conversations for the account.
 * GET https://chat.sakana.ai/api/conversations
 */
export async function listConversations(account: SakanaAccount): Promise<Array<{ id: string; title: string; updatedAt: string }>> {
  const cookie = buildCookieHeader(account)
  const response = await fetch(`${BASE_URL}/api/conversations`, {
    headers: {
      'Cookie': cookie,
      'Accept': 'application/json',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(config.timeouts.http),
  })
  if (!response.ok) {
    throw new SakanaApiError(`Failed to list conversations: ${response.status}`, response.status)
  }
  return await response.json() as any
}

/**
 * Fetches the user info for the account — useful for validating that the
 * cookie is still alive.
 * GET https://chat.sakana.ai/api/user
 */
export async function getUserInfo(account: SakanaAccount): Promise<{ id: string; username?: string; email?: string; isAnonymous: boolean } | null> {
  const cookie = buildCookieHeader(account)
  try {
    const response = await fetch(`${BASE_URL}/api/user`, {
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(config.timeouts.http),
    })
    if (!response.ok) return null
    return await response.json() as any
  } catch {
    return null
  }
}

// --- Helpers ---

function buildMultipartForm(boundary: string, fields: Array<{ name: string; value: string }>): string {
  const parts: string[] = []
  for (const field of fields) {
    parts.push(`--${boundary}\r\n`)
    parts.push(`Content-Disposition: form-data; name="${field.name}"\r\n\r\n`)
    parts.push(`${field.value}\r\n`)
  }
  parts.push(`--${boundary}--\r\n`)
  return parts.join('')
}

export class SakanaApiError extends Error {
  status: number
  body?: string
  constructor(message: string, status: number, body?: string) {
    super(message)
    this.name = 'SakanaApiError'
    this.status = status
    this.body = body
  }
}

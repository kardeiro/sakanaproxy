import type { Context } from 'hono'
import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../core/config.js'
import { logger } from '../core/logger.js'
import { metrics } from '../core/metrics.js'
import { resolveModelId, isThinkingModel, getModelContextWindow } from '../core/model-registry.js'
import { estimateTokenCount, truncateMessages } from '../utils/context-truncation.js'
import type { OpenAIRequest, Message } from '../utils/types.js'
import {
  getNextAccount,
  getNextAvailableAccount,
  markAccountInUse,
  releaseAccountInUse,
  markAccountRateLimited,
  getAccountCooldownInfo,
  getInUseAccounts,
} from '../core/account-manager.js'
import { loadAccounts } from '../core/accounts.js'
import { registerStream, removeStream } from '../core/stream-registry.js'
import {
  createConversation,
  sendMessageStream,
  stopGeneration,
  SakanaApiError,
} from '../services/sakana.js'
import { SakanaStreamParser } from '../services/sakana-stream-parser.js'
import { handleStreamingResponse, handleNonStreamingResponse } from './stream-handler.js'

export async function chatCompletions(c: Context) {
  metrics.increment('requests.total')
  const start = Date.now()

  try {
    const body = await c.req.json() as OpenAIRequest
    const isStream = body.stream ?? false

    // --- Build prompt ---
    let systemPrompt = ''
    let prompt = ''
    const messages = body.messages || []

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      let contentStr = ''
      if (Array.isArray(msg.content)) {
        // Multimodal content — extract text parts only (sakana/namazu is not multimodal)
        const textParts = (msg.content as any[])
          .filter(p => p.type === 'text' && p.text)
          .map(p => p.text)
        contentStr = textParts.join('\n')
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        contentStr = JSON.stringify(msg.content)
      } else {
        contentStr = msg.content || ''
      }

      if (msg.role === 'system') {
        systemPrompt += (contentStr || '') + '\n\n'
      } else if (msg.role === 'user') {
        prompt += `User: ${contentStr || ''}\n\n`
      } else if (msg.role === 'assistant') {
        let assistantContent = contentStr || ''
        const reasoning = (msg as any).reasoning_content
        if (reasoning) {
          assistantContent = `<think>\n${reasoning}\n</think>\n${assistantContent}`
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const args = tc.function?.arguments
            let parsedArgs: any = {}
            if (typeof args === 'string') {
              try { parsedArgs = JSON.parse(args) } catch { parsedArgs = {} }
            } else if (args && typeof args === 'object') {
              parsedArgs = args
            }
            const payload = { name: tc.function?.name, arguments: parsedArgs }
            const toolCallStr = `\n<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`
            assistantContent = assistantContent ? assistantContent + toolCallStr : toolCallStr.trim()
          }
        }
        prompt += `Assistant: ${assistantContent.trim()}\n\n`
      } else if (msg.role === 'tool' || msg.role === 'function') {
        let toolName = msg.name
        if (!toolName && msg.tool_call_id) {
          for (let j = i - 1; j >= 0; j--) {
            const prevMsg = messages[j]
            if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
              const call = prevMsg.tool_calls.find(tc => tc.id === msg.tool_call_id)
              if (call) {
                toolName = call.function?.name
                break
              }
            }
          }
        }
        prompt += `Tool Response (${toolName || 'tool'}): ${contentStr || ''}\n\n`
      }
    }

    // --- Tools (announce to the model via system prompt) ---
    const bodyAny = body as any
    const hasTools = Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0
    if (hasTools) {
      const formattedTools = bodyAny.tools.map((t: any) => {
        if (t.type === 'function') {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters,
          }
        }
        return t
      })
      const toolsJson = JSON.stringify(formattedTools, null, 2)
      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, output a JSON object wrapped EXACTLY in <tool_call> tags:\n\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling.\n2. You can call multiple tools by outputting multiple <tool_call> blocks.\n3. Do NOT output any other text after <tool_call> blocks.\n4. The JSON inside the tags MUST be valid.\n5. NEVER invent tool names — use ONLY names from the TOOLS AVAILABLE list.\n\n`
    }

    // --- Resolve model ---
    const modelId = resolveModelId(body.model)
    const thinkingEnabled = isThinkingModel(modelId)
    const modelContextWindow = getModelContextWindow(modelId)

    const estimatedTokens = estimateTokenCount(systemPrompt + prompt, modelId)
    let finalPrompt: string
    if (estimatedTokens > modelContextWindow - 1000) {
      const truncated = truncateMessages(messages, modelContextWindow, systemPrompt, modelId)
      const truncatedBody = truncated.map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`).join('\n\n')
      finalPrompt = systemPrompt ? `${systemPrompt}\n\n${truncatedBody}` : truncatedBody
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt
    }

    // --- Acquire account ---
    const completionId = 'chatcmpl-' + crypto.randomUUID()
    let account = getNextAccount()
    const triedAccountIds = new Set<string>()

    if (!account) {
      const inUse = getInUseAccounts()
      const message = inUse.length > 0
        ? `All configured account lanes are busy: ${inUse.join(', ')}`
        : 'No accounts configured. Run `npm run login` to add a Sakana session cookie.'
      throw new RetryableError(message, 1000)
    }

    let stream: ReadableStream<Uint8Array> | undefined
    let conversationId = ''
    let parentMessageId = ''
    let generationId = ''
    let usedAccountId = ''
    let lastError: any = null

    while (account) {
      const accountId = account.id
      const accountLabel = account.label

      if (triedAccountIds.has(accountId)) {
        account = getNextAvailableAccount(triedAccountIds)
        continue
      }
      triedAccountIds.add(accountId)

      const cooldownInfo = getAccountCooldownInfo(accountId)
      if (cooldownInfo) {
        logger.info('Chat', `Skipping account ${accountLabel} (${accountId}) — on cooldown ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`)
        account = getNextAvailableAccount(triedAccountIds)
        continue
      }

      logger.info('Chat', `Routing request to account: ${accountLabel} (${accountId})`)
      markAccountInUse(accountId)

      let success = false
      try {
        // 1) Create conversation
        const conv = await createConversation(account, modelId.replace('-no-thinking', ''))
        conversationId = conv.conversationId
        parentMessageId = conv.systemMessageId
        generationId = uuidv4()

        // 2) Send message → get NDJSON stream
        const result = await sendMessageStream(account, conversationId, {
          prompt: finalPrompt,
          parentMessageId,
          generationId,
          timezone: 'UTC',
        })
        stream = result.stream
        usedAccountId = accountId
        success = true

        registerStream(completionId, {
          abortController: result.controller,
          accountId,
          conversationId,
          messageId: null,
          createdAt: Date.now(),
        })
        break
      } catch (err: any) {
        if (err instanceof SakanaApiError) {
          if (err.status === 401 || err.status === 403) {
            // Cookie expired / invalid
            markAccountRateLimited(accountId, 60 * 60 * 1000, 'AuthExpired')
            logger.warn('Chat', `Account ${accountLabel} cookie expired (HTTP ${err.status}). 1h cooldown.`)
            lastError = err
          } else if (err.status === 429) {
            markAccountRateLimited(accountId, 5 * 60 * 1000, 'RateLimited')
            logger.warn('Chat', `Account ${accountLabel} rate-limited. 5min cooldown.`)
            lastError = err
          } else if (err.status >= 500) {
            markAccountRateLimited(accountId, 60 * 1000, 'ServerError')
            logger.warn('Chat', `Account ${accountLabel} got server error ${err.status}. 1min cooldown.`)
            lastError = err
          } else {
            lastError = err
          }
        } else {
          lastError = err
        }
      } finally {
        if (!success) {
          releaseAccountInUse(accountId)
        }
      }

      account = getNextAvailableAccount(triedAccountIds)
    }

    if (!stream) {
      removeStream(completionId)
      throw lastError || new Error('All accounts failed')
    }

    const duration = Date.now() - start
    metrics.histogram('latency.chat_init', duration)

    // --- Respond ---
    if (!isStream) {
      return await handleNonStreamingResponse(c, {
        stream: stream!,
        completionId,
        model: body.model,
        accountId: usedAccountId,
        conversationId,
        finalPrompt,
      })
    }

    return handleStreamingResponse(c, {
      stream: stream!,
      completionId,
      model: body.model,
      accountId: usedAccountId,
      conversationId,
      finalPrompt,
      streamOptions: body.stream_options,
    })
  } catch (err: any) {
    metrics.increment('requests.errors')
    logger.error('Chat', `Error: ${err.message}`, { stack: err.stack })
    const status = err.status || (err instanceof SakanaApiError ? err.status : 500)
    return c.json({ error: { message: err.message, type: err.name || 'UnknownError' } }, status >= 400 && status <= 599 ? status : 500)
  }
}

export async function chatCompletionsStop(c: Context) {
  try {
    const body = await c.req.json()
    const { chat_id } = body

    if (!chat_id) {
      return c.json({ error: 'chat_id is required' }, 400)
    }

    const stream = registerStream.toString() // placeholder to satisfy TS
    void stream
    const entry = (await import('../core/stream-registry.js')).getStream(chat_id)
    if (!entry) {
      return c.json({ error: 'Stream not found' }, 404)
    }

    const { loadAccounts } = await import('../core/accounts.js')
    const accounts = loadAccounts()
    const account = accounts.find(a => a.id === entry.accountId)
    if (!account) {
      return c.json({ error: 'Account not found' }, 404)
    }

    await stopGeneration(account, entry.conversationId, entry.conversationId)
    entry.abortController.abort()
    removeStream(chat_id)

    return c.json({ success: true })
  } catch (err: any) {
    logger.error('Chat', `Stop error: ${err.message}`)
    return c.json({ error: err.message }, 500)
  }
}

class RetryableError extends Error {
  retryAfterMs: number
  constructor(message: string, retryAfterMs: number) {
    super(message)
    this.name = 'RetryableError'
    this.retryAfterMs = retryAfterMs
  }
}

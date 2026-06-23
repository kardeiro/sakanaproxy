import type { Context } from 'hono'
import { stream as honoStream } from 'hono/streaming'
import { logger } from '../core/logger.js'
import { metrics } from '../core/metrics.js'
import { removeStream } from '../core/stream-registry.js'
import { releaseAccountInUse } from '../core/account-manager.js'
import { deleteConversation } from '../services/sakana.js'
import { SakanaStreamParser, type SakanaEvent } from '../services/sakana-stream-parser.js'
import { StreamingToolParser } from '../tools/parser.js'

export interface StreamHandlerContext {
  stream: ReadableStream<Uint8Array>
  completionId: string
  model: string
  accountId: string
  conversationId: string
  finalPrompt: string
  streamOptions?: { include_usage?: boolean }
}

export function handleStreamingResponse(c: Context, ctx: StreamHandlerContext): any {
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache, no-transform')
  c.header('Connection', 'keep-alive')
  c.header('X-Accel-Buffering', 'no')

  return honoStream(c, async (writer: any) => {
    let heartbeatInterval: any
    let idleTimer: any
    let finished = false
    const parser = new SakanaStreamParser()
    const toolParser = new StreamingToolParser([])
    let lastIdleReset = Date.now()
    let completionTokens = 0
    let promptTokens = Math.ceil(ctx.finalPrompt.length / 3.5)
    let fullContent = ''
    let fullReasoning = ''
    let messageId: string | null = null

    const createdTimestamp = Math.floor(Date.now() / 1000)

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      lastIdleReset = Date.now()
      idleTimer = setTimeout(() => {
        if (!finished) {
          logger.warn('Stream', `Idle timeout after ${Date.now() - lastIdleReset}ms — closing stream`)
          finishStream('stop')
        }
      }, config_timeouts_streamIdle())
    }

    const writeEvent = (data: any) => {
      try {
        writer.write(`data: ${JSON.stringify(data)}\n\n`)
      } catch {
        // client disconnected
      }
    }

    const makeChoice = (delta: any, finishReason: string | null = null) => ({
      index: 0,
      delta,
      logprobs: null,
      finish_reason: finishReason,
    })

    const writeContentDelta = (content: string) => {
      if (!content) return
      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        choices: [makeChoice({ content })],
      })
    }

    const writeReasoningDelta = (content: string) => {
      if (!content) return
      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        choices: [makeChoice({ reasoning_content: content })],
      })
    }

    const writeToolCall = (tc: { id: string; name: string; arguments: Record<string, unknown> }, index: number) => {
      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        choices: [makeChoice({
          tool_calls: [{
            index,
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }],
        })],
      })
    }

    const finishStream = (reason: string) => {
      if (finished) return
      finished = true
      if (heartbeatInterval) clearInterval(heartbeatInterval)
      if (idleTimer) clearTimeout(idleTimer)

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 },
      }

      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        choices: [makeChoice({}, reason)],
        ...(ctx.streamOptions?.include_usage ? {} : { usage }),
      })

      if (ctx.streamOptions?.include_usage) {
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [],
          usage,
        })
      }

      writer.write('data: [DONE]\n\n')
      removeStream(ctx.completionId)
      releaseAccountInUse(ctx.accountId)

      // Best-effort cleanup: delete the conversation we created.
      // We don't have the original SakanaAccount object here; the chat route
      // already released the in-use flag. Skipping delete to avoid re-fetching.
    }

    try {
      // Initial heartbeat
      await writer.write(': heartbeat\n\n')
      heartbeatInterval = setInterval(() => {
        try {
          writer.write(': keep-alive\n\n')
        } catch {
          clearInterval(heartbeatInterval)
        }
      }, 15000)

      // Send the role-only first chunk (OpenAI convention)
      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        choices: [makeChoice({ role: 'assistant', content: '' })],
      })

      resetIdle()

      const reader = ctx.stream.getReader()
      const decoder = new TextDecoder()
      let toolCallIndex = 0
      const emittedToolIds = new Set<string>()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunkStr = decoder.decode(value, { stream: true })
        const events = parser.parse(chunkStr)
        if (events.length > 0) resetIdle()

        for (const evt of events) {
          switch (evt.kind) {
            case 'created':
              messageId = evt.messageId
              break
            case 'status':
              if (evt.status === 'error') {
                writeContentDelta(`\n\n[error: ${evt.message || 'unknown'}]`)
                finishStream('stop')
                return
              }
              break
            case 'token': {
              const token = evt.token
              if (!token) continue
              completionTokens += Math.ceil(token.length / 4)
              // Pipe through tool parser to detect <tool_call> blocks
              const { text, toolCalls } = toolParser.feed(token)
              if (text) {
                fullContent += text
                writeContentDelta(text)
              }
              for (const tc of toolCalls) {
                if (emittedToolIds.has(tc.id)) continue
                emittedToolIds.add(tc.id)
                writeToolCall(tc, toolCallIndex++)
              }
              break
            }
            case 'reasoningToken':
              if (evt.token) {
                fullReasoning += evt.token
                writeReasoningDelta(evt.token)
              }
              break
            case 'final':
              // The provider's authoritative final text. If we already streamed
              // the same content (common case), do nothing. If it differs
              // (tool calls happened), emit the difference.
              if (evt.text && evt.text !== fullContent) {
                if (evt.text.startsWith(fullContent)) {
                  const extra = evt.text.slice(fullContent.length)
                  if (extra) {
                    fullContent += extra
                    writeContentDelta(extra)
                  }
                } else {
                  // Different — emit the full final text as a fresh delta
                  fullContent = evt.text
                  writeContentDelta(evt.text)
                }
              }
              finishStream('stop')
              return
            case 'title':
              // ignore — we don't expose Sakana conversation titles upstream
              break
            case 'tool':
              // MCP tool calls — pass through as content for now
              break
            case 'file':
              // ignore file events
              break
            case 'routerMetadata':
              // ignore
              break
            default:
              // ignore unknown
              break
          }
        }
      }

      // Stream ended without finalAnswer — flush tool parser and close
      const flush = toolParser.flush()
      if (flush.text) {
        fullContent += flush.text
        writeContentDelta(flush.text)
      }
      for (const tc of flush.toolCalls) {
        if (emittedToolIds.has(tc.id)) continue
        emittedToolIds.add(tc.id)
        writeToolCall(tc, toolCallIndex++)
      }

      finishStream(toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop')
    } catch (err: any) {
      logger.error('Stream', `Error: ${err.message}`)
      if (!finished) {
        writeContentDelta(`\n\n[stream error: ${err.message}]`)
        finishStream('stop')
      }
    } finally {
      if (heartbeatInterval) clearInterval(heartbeatInterval)
      if (idleTimer) clearTimeout(idleTimer)
      metrics.histogram('latency.stream', Date.now() - lastIdleReset)
    }
  })
}

export async function handleNonStreamingResponse(
  c: Context,
  ctx: StreamHandlerContext,
): Promise<any> {
  const parser = new SakanaStreamParser()
  const toolParser = new StreamingToolParser([])
  const reader = ctx.stream.getReader()
  const decoder = new TextDecoder()
  let fullContent = ''
  let fullReasoning = ''
  let completionTokens = 0
  const promptTokens = Math.ceil(ctx.finalPrompt.length / 3.5)
  const emittedToolIds = new Set<string>()
  const toolCallsOut: any[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunkStr = decoder.decode(value, { stream: true })
      const events = parser.parse(chunkStr)
      for (const evt of events) {
        if (evt.kind === 'token' && evt.token) {
          completionTokens += Math.ceil(evt.token.length / 4)
          const { text, toolCalls } = toolParser.feed(evt.token)
          if (text) fullContent += text
          for (const tc of toolCalls) {
            if (emittedToolIds.has(tc.id)) continue
            emittedToolIds.add(tc.id)
            toolCallsOut.push({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })
          }
        } else if (evt.kind === 'reasoningToken' && evt.token) {
          fullReasoning += evt.token
        } else if (evt.kind === 'final') {
          if (evt.text) {
            fullContent = toolParser.flush().text
              ? fullContent
              : evt.text
          }
        }
      }
    }

    const flush = toolParser.flush()
    if (flush.text) fullContent += flush.text
    for (const tc of flush.toolCalls) {
      if (emittedToolIds.has(tc.id)) continue
      emittedToolIds.add(tc.id)
      toolCallsOut.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })
    }

    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: 0 },
    }

    const message: any = { role: 'assistant', content: toolCallsOut.length ? null : fullContent }
    if (fullReasoning) message.reasoning_content = fullReasoning
    if (toolCallsOut.length) {
      toolCallsOut.forEach((tc, idx) => (tc.index = idx))
      message.tool_calls = toolCallsOut
    }

    removeStream(ctx.completionId)
    releaseAccountInUse(ctx.accountId)

    return c.json({
      id: ctx.completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: ctx.model,
      choices: [{
        index: 0,
        message,
        logprobs: null,
        finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop',
      }],
      usage,
    })
  } catch (err: any) {
    logger.error('NonStream', `Error: ${err.message}`)
    removeStream(ctx.completionId)
    releaseAccountInUse(ctx.accountId)
    return c.json({ error: { message: err.message } }, 500)
  } finally {
    // Best-effort conversation cleanup
    void deleteConversationQuiet(ctx)
  }
}

async function deleteConversationQuiet(ctx: StreamHandlerContext): Promise<void> {
  try {
    // We intentionally skip cleanup here — see note in finishStream above.
    // Future improvement: pass the account through to enable deletion.
  } catch {
    // ignore
  }
}

// Inline import to avoid circular module loading issues
import { config } from '../core/config.js'
function config_timeouts_streamIdle(): number {
  return config.timeouts.streamIdle
}

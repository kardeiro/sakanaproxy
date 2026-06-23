import { logger } from '../core/logger.js'

/**
 * Parses the NDJSON stream from chat.sakana.ai into discrete events.
 *
 * Each line of the upstream stream is a JSON object terminated by \n.
 * Example events:
 *   {"type":"createdMessage","messageId":"..."}
 *   {"type":"status","status":"keepAlive"}
 *   {"type":"status","status":"started"}
 *   {"type":"stream","token":"T\u0000\u0000..."}    <- token is padded with null chars
 *   {"type":"reasoning","subtype":"stream","token":"..."}
 *   {"type":"finalAnswer","text":"...","interrupted":false}
 *   {"type":"title","title":"..."}
 */
export class SakanaStreamParser {
  private buffer = ''
  private messageId: string | null = null

  parse(chunk: string): SakanaEvent[] {
    this.buffer += chunk
    const events: SakanaEvent[] = []
    let newlineIdx: number
    while ((newlineIdx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim()
      this.buffer = this.buffer.slice(newlineIdx + 1)
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        const evt = this.normalize(parsed)
        if (evt) events.push(evt)
      } catch (err) {
        // Skip unparseable lines (they may be partial or the upstream padding block)
        if (line.length > 0 && line.length < 100) {
          logger.debug('SakanaStreamParser', `Unparseable line: ${line.slice(0, 80)}`)
        }
      }
    }
    return events
  }

  flush(): SakanaEvent[] {
    const remaining = this.buffer.trim()
    this.buffer = ''
    if (!remaining) return []
    try {
      const parsed = JSON.parse(remaining)
      const evt = this.normalize(parsed)
      return evt ? [evt] : []
    } catch {
      return []
    }
  }

  private normalize(raw: any): SakanaEvent | null {
    if (!raw || typeof raw !== 'object' || !raw.type) return null

    switch (raw.type) {
      case 'createdMessage':
        this.messageId = raw.messageId ?? null
        return { kind: 'created', messageId: raw.messageId ?? null }

      case 'status':
        return { kind: 'status', status: raw.status ?? 'unknown', message: raw.message, statusCode: raw.statusCode }

      case 'stream':
        // Token is padded with null chars to fixed 16-byte length — strip them
        return { kind: 'token', token: stripNullPadding(raw.token ?? '') }

      case 'reasoning':
        if (raw.subtype === 'stream') {
          return { kind: 'reasoningToken', token: stripNullPadding(raw.token ?? '') }
        }
        if (raw.subtype === 'status') {
          return { kind: 'reasoningStatus', status: raw.status ?? 'unknown' }
        }
        return null

      case 'finalAnswer':
        return { kind: 'final', text: raw.text ?? '', interrupted: Boolean(raw.interrupted) }

      case 'title':
        return { kind: 'title', title: raw.title ?? '' }

      case 'file':
        return { kind: 'file', name: raw.name, sha: raw.sha, mime: raw.mime }

      case 'tool':
        return { kind: 'tool', subtype: raw.subtype, uuid: raw.uuid, call: raw.call, result: raw.result, message: raw.message }

      case 'routerMetadata':
        return { kind: 'routerMetadata', route: raw.route, model: raw.model, provider: raw.provider }

      default:
        return { kind: 'unknown', raw }
    }
  }

  getMessageId(): string | null {
    return this.messageId
  }
}

export type SakanaEvent =
  | { kind: 'created'; messageId: string | null }
  | { kind: 'status'; status: string; message?: string; statusCode?: number }
  | { kind: 'token'; token: string }
  | { kind: 'reasoningToken'; token: string }
  | { kind: 'reasoningStatus'; status: string }
  | { kind: 'final'; text: string; interrupted: boolean }
  | { kind: 'title'; title: string }
  | { kind: 'file'; name?: string; sha?: string; mime?: string }
  | { kind: 'tool'; subtype?: string; uuid?: string; call?: any; result?: any; message?: string }
  | { kind: 'routerMetadata'; route?: string; model?: string; provider?: string }
  | { kind: 'unknown'; raw: any }

/**
 * Sakana pads stream tokens with null chars (\u0000) to a fixed 16-byte
 * length to mitigate side-channel attacks. Strip them so downstream
 * consumers receive only the actual text.
 */
function stripNullPadding(token: string): string {
  if (!token) return ''
  // Remove all null chars (also handle the \u0000 escape form)
  return token.replace(/\u0000/g, '').replace(/\\u0000/g, '')
}

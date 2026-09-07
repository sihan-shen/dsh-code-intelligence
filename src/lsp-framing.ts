const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

const CLIENT_METHODS = new Set([
  'initialize',
  'initialized',
  'textDocument/didOpen',
  'textDocument/documentSymbol',
  'textDocument/didClose',
  'shutdown',
  'exit',
])
const NOTIFICATION_METHODS = new Set(['initialized', 'textDocument/didOpen', 'textDocument/didClose', 'exit'])
const RESPONSE_METHODS = new Set(['initialize', 'textDocument/documentSymbol', 'shutdown'])

export type LspMessage = Record<string, unknown>

function protocolError(message: string): TypeError {
  return new TypeError(`LSP protocol error: ${message}`)
}

function objectMessage(value: unknown): LspMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw protocolError('message must be an object')
  return value as LspMessage
}

function validJsonRpc(message: LspMessage): void {
  if (message.jsonrpc !== '2.0') throw protocolError('jsonrpc must be 2.0')
}

function encodedLength(value: string): number {
  return textEncoder.encode(value).byteLength
}

export function encodeLspFrame(value: unknown, maxMessageBytes: number): Buffer {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) throw new RangeError('message byte limit is invalid')
  const message = objectMessage(value)
  let body: string
  try {
    body = JSON.stringify(message)
  } catch {
    throw protocolError('message is not serializable')
  }
  const bytes = Buffer.from(body, 'utf8')
  if (bytes.byteLength > maxMessageBytes) throw new RangeError('message is too large')
  return Buffer.concat([Buffer.from(`Content-Length: ${bytes.byteLength}\r\n\r\n`, 'ascii'), bytes])
}

export function encodeLspClientMessage(value: unknown, maxMessageBytes: number): Buffer {
  const message = objectMessage(value)
  validJsonRpc(message)
  if (typeof message.method !== 'string' || !CLIENT_METHODS.has(message.method)) throw protocolError('client method is not permitted')
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
  if (NOTIFICATION_METHODS.has(message.method) && hasId) throw protocolError('notification must not have an id')
  if (!NOTIFICATION_METHODS.has(message.method) && !hasId) throw protocolError('request requires an id')
  return encodeLspFrame(message, maxMessageBytes)
}

function hasWriteShape(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasWriteShape)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([key, child]) => key === 'workspaceEdit' || key === 'commands' || key === 'edit' || hasWriteShape(child))
}

export function parseLspResponse(value: unknown, options: { readonly expectedId: string | number | null; readonly method: string }): LspMessage {
  const message = objectMessage(value)
  validJsonRpc(message)
  if (typeof message.method === 'string') throw protocolError('server requests are not permitted')
  if (!RESPONSE_METHODS.has(options.method)) throw protocolError('response method is not permitted')
  if (!Object.prototype.hasOwnProperty.call(message, 'id') || message.id !== options.expectedId) throw protocolError('response id does not match request')
  if (!Object.prototype.hasOwnProperty.call(message, 'result') && !Object.prototype.hasOwnProperty.call(message, 'error')) throw protocolError('response has no result or error')
  if (hasWriteShape(message.result)) throw protocolError('write-capable response is not permitted')
  return message
}

export class LspFrameDecoder {
  #buffer = Buffer.alloc(0)
  #failed = false

  constructor(readonly maxMessageBytes: number) {
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) throw new RangeError('message byte limit is invalid')
  }

  push(chunk: Uint8Array): LspMessage[] {
    if (this.#failed) throw protocolError('decoder is unusable after failure')
    if (!(chunk instanceof Uint8Array)) throw protocolError('input must be bytes')
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)])
    const messages: LspMessage[] = []
    while (true) {
      const boundary = this.#buffer.indexOf('\r\n\r\n')
      if (boundary < 0) {
        if (this.#buffer.byteLength > this.maxMessageBytes + 4096) return this.fail('header is too large')
        break
      }
      let header: string
      try {
        header = textDecoder.decode(this.#buffer.subarray(0, boundary))
      } catch {
        return this.fail('header is not valid UTF-8')
      }
      const lines = header.split('\r\n')
      let length: number | undefined
      for (const line of lines) {
        const separator = line.indexOf(':')
        if (separator <= 0) return this.fail('header line is malformed')
        const name = line.slice(0, separator).trim().toLowerCase()
        const value = line.slice(separator + 1).trim()
        if (name === 'content-length') {
          if (length !== undefined) return this.fail('duplicate content-length')
          if (!/^\d+$/.test(value)) return this.fail('content-length is invalid')
          length = Number(value)
          if (!Number.isSafeInteger(length)) return this.fail('content-length is invalid')
        } else if (name !== 'content-type') {
          return this.fail('unknown header')
        }
      }
      if (length === undefined) return this.fail('content-length is missing')
      if (length > this.maxMessageBytes) return this.fail('message is too large')
      const bodyStart = boundary + 4
      const bodyEnd = bodyStart + length
      if (this.#buffer.byteLength < bodyEnd) break
      let body: string
      try {
        body = textDecoder.decode(this.#buffer.subarray(bodyStart, bodyEnd))
      } catch {
        return this.fail('body is not valid UTF-8')
      }
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        return this.fail('body is not valid JSON')
      }
      messages.push(objectMessage(value))
      this.#buffer = this.#buffer.subarray(bodyEnd)
    }
    return messages
  }

  finish(): void {
    if (this.#failed) throw protocolError('decoder failed')
    if (this.#buffer.byteLength !== 0) this.fail('incomplete frame at EOF')
  }

  private fail(message: string): never {
    this.#failed = true
    throw protocolError(message)
  }
}

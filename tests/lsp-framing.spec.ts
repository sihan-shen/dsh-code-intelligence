import { describe, expect, it } from 'vitest'
import {
  encodeLspClientMessage,
  encodeLspFrame,
  LspFrameDecoder,
  parseLspResponse,
} from '../src/lsp-framing.ts'

const encoder = new TextEncoder()

describe('LSP Content-Length framing', () => {
  it('decodes split headers and bodies and multiple frames without losing bytes', () => {
    const decoder = new LspFrameDecoder(1024)
    const first = encodeLspFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } }, 1024)
    const second = encodeLspFrame({ jsonrpc: '2.0', id: 2, result: null }, 1024)
    const joined = Buffer.concat([first, second])

    expect(decoder.push(joined.subarray(0, 7))).toEqual([])
    expect(decoder.push(joined.subarray(7, first.byteLength - 2))).toEqual([])
    expect(decoder.push(joined.subarray(first.byteLength - 2))).toEqual([
      { jsonrpc: '2.0', id: 1, result: { ok: true } },
      { jsonrpc: '2.0', id: 2, result: null },
    ])
    expect(() => decoder.finish()).not.toThrow()
  })

  it('accepts Content-Length case-insensitively', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 3, result: [] })
    const frame = Buffer.concat([
      Buffer.from(`content-length: ${Buffer.byteLength(body)}\r\n\r\n`, 'ascii'),
      Buffer.from(body),
    ])
    expect(new LspFrameDecoder(1024).push(frame)).toEqual([{ jsonrpc: '2.0', id: 3, result: [] }])
  })

  it.each([
    ['missing length', 'X-Test: 1\r\n\r\n{}'],
    ['duplicate length', 'Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}'],
    ['negative length', 'Content-Length: -1\r\n\r\n'],
    ['non-decimal length', 'Content-Length: 1.5\r\n\r\n{}'],
    ['stdout diagnostics', 'language server started\nContent-Length: 2\r\n\r\n{}'],
  ])('rejects %s', (_label, frame) => {
    expect(() => new LspFrameDecoder(1024).push(encoder.encode(frame))).toThrow(/content-length|header|protocol/i)
  })

  it('rejects an oversized declared body before buffering it', () => {
    expect(() => new LspFrameDecoder(8).push(encoder.encode('Content-Length: 9\r\n\r\n'))).toThrow(/large|limit|length/i)
  })

  it('rejects invalid UTF-8 and invalid JSON bodies', () => {
    const invalidUtf8 = Buffer.concat([Buffer.from('Content-Length: 2\r\n\r\n'), Buffer.from([0xc3, 0x28])])
    expect(() => new LspFrameDecoder(1024).push(invalidUtf8)).toThrow(/utf-8|protocol/i)
    const invalidJson = Buffer.from('Content-Length: 1\r\n\r\n{')
    expect(() => new LspFrameDecoder(1024).push(invalidJson)).toThrow(/json|protocol/i)
  })

  it('fails closed on an incomplete frame at EOF', () => {
    const decoder = new LspFrameDecoder(1024)
    decoder.push(encoder.encode('Content-Length: 4\r\n\r\n{}'))
    expect(() => decoder.finish()).toThrow(/incomplete|protocol/i)
  })

  it('bounds encoded messages too', () => {
    expect(() => encodeLspFrame({ text: 'too long' }, 4)).toThrow(/large|limit/i)
  })

  it('rejects a response with a mismatched id', () => {
    expect(() => parseLspResponse(
      { jsonrpc: '2.0', id: 2, result: [] },
      { expectedId: 1, method: 'textDocument/documentSymbol' },
    )).toThrow(/id|protocol/i)
  })

  it('rejects server requests and write-capable response shapes', () => {
    expect(() => parseLspResponse(
      { jsonrpc: '2.0', id: 1, method: 'workspace/applyEdit', params: {} },
      { expectedId: 1, method: 'initialize' },
    )).toThrow(/request|server|protocol/i)
    expect(() => parseLspResponse(
      { jsonrpc: '2.0', id: 1, result: { workspaceEdit: { changes: {} } } },
      { expectedId: 1, method: 'initialize' },
    )).toThrow(/workspace|write|protocol/i)
    expect(() => parseLspResponse(
      { jsonrpc: '2.0', id: 1, result: { commands: [] } },
      { expectedId: 1, method: 'initialize' },
    )).toThrow(/command|write|protocol/i)
  })

  it('allows only the read-only client protocol messages', () => {
    expect(() => encodeLspClientMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 1024)).not.toThrow()
    expect(() => encodeLspClientMessage({ jsonrpc: '2.0', method: 'initialized', params: {} }, 1024)).not.toThrow()
    expect(() => encodeLspClientMessage({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {} }, 1024)).not.toThrow()
    expect(() => encodeLspClientMessage({ jsonrpc: '2.0', id: 2, method: 'textDocument/documentSymbol', params: {} }, 1024)).not.toThrow()
    expect(() => encodeLspClientMessage({ jsonrpc: '2.0', method: 'textDocument/didClose', params: {} }, 1024)).not.toThrow()
    expect(() => encodeLspClientMessage({ jsonrpc: '2.0', id: 3, method: 'shutdown', params: null }, 1024)).not.toThrow()
    expect(() => encodeLspClientMessage({ jsonrpc: '2.0', method: 'exit' }, 1024)).not.toThrow()
    expect(() => encodeLspClientMessage({ jsonrpc: '2.0', id: 1, method: 'workspace/executeCommand', params: {} }, 1024)).toThrow(/method|protocol/i)
    expect(() => encodeLspClientMessage({ jsonrpc: '2.0', id: 1, method: 'workspace/applyEdit', params: {} }, 1024)).toThrow(/method|protocol/i)
  })
})

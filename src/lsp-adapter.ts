import { pathToFileURL } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { canonicalJson, sha256Utf8, type InternalSymbolEntryV1, type RepositorySnapshotV1 } from '@han_05/dsh-context'
import { encodeLspClientMessage, LspFrameDecoder, parseLspResponse, type LspMessage } from './lsp-framing.js'
import type { AdapterUnavailableCode, AdapterUnavailableV1, HostNetworkIsolation, LspDeploymentConfigV1, SymbolAdapterResultV1 } from './types.js'
import type { RepositorySnapshotStore } from './snapshot.js'

const VERSION = '0.2.1'
const JS_LANGUAGES = new Set(['javascript', 'typescript'])
const KIND_NAMES: Record<number, string> = {
  5: 'class',
  6: 'method',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
}

function unavailable(code: AdapterUnavailableCode): AdapterUnavailableV1 {
  return Object.freeze({ adapterId: 'typescript-lsp', adapterVersion: VERSION, code })
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectOnce = () => reject(abortReason(signal))
    if (signal.aborted) rejectOnce()
    else signal.addEventListener('abort', rejectOnce, { once: true })
  })
}

class MessageInbox {
  readonly #decoder: LspFrameDecoder
  readonly #messages: LspMessage[] = []
  readonly #waiters: Array<{ resolve: (message: LspMessage) => void; reject: (error: unknown) => void }> = []
  #failure: unknown

  constructor(stream: Readable, maxMessageBytes: number) {
    this.#decoder = new LspFrameDecoder(maxMessageBytes)
    stream.on('data', chunk => {
      if (this.#failure !== undefined) return
      try {
        this.#messages.push(...this.#decoder.push(Buffer.from(chunk)))
        this.#flush()
      } catch (error) {
        this.#failure = error
        this.#rejectAll(error)
      }
    })
    stream.once('error', error => {
      this.#failure = error
      this.#rejectAll(error)
    })
    stream.once('end', () => {
      if (this.#failure === undefined) {
        try { this.#decoder.finish() } catch (error) { this.#failure = error }
      }
      this.#rejectAll(this.#failure ?? new Error('LSP stdout ended before response'))
    })
  }

  next(signal: AbortSignal): Promise<LspMessage> {
    if (this.#messages.length > 0) return Promise.resolve(this.#messages.shift()!)
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    return Promise.race([
      new Promise<LspMessage>((resolve, reject) => this.#waiters.push({ resolve, reject })),
      waitForAbort(signal),
    ])
  }

  #flush(): void {
    while (this.#messages.length > 0 && this.#waiters.length > 0) this.#waiters.shift()!.resolve(this.#messages.shift()!)
  }

  #rejectAll(error: unknown): void {
    while (this.#waiters.length > 0) this.#waiters.shift()!.reject(error)
  }
}

async function writeMessage(stream: Writable, value: unknown, maxMessageBytes: number, signal: AbortSignal): Promise<void> {
  const frame = encodeLspClientMessage(value, maxMessageBytes)
  if (signal.aborted) throw abortReason(signal)
  if (stream.write(frame)) return
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      stream.once('drain', resolve)
      stream.once('error', reject)
    }),
    waitForAbort(signal),
  ])
}

function position(value: unknown): { readonly line: number; readonly column: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('LSP symbol position is invalid')
  const object = value as Record<string, unknown>
  if (!Number.isSafeInteger(object.line) || !Number.isSafeInteger(object.character) || (object.line as number) < 0 || (object.character as number) < 0) throw new TypeError('LSP symbol position is invalid')
  return { line: (object.line as number) + 1, column: object.character as number }
}

function symbolId(snapshotId: string, path: string, kind: string, name: string, start: { readonly line: number; readonly column: number }, end: { readonly line: number; readonly column: number }): string {
  return sha256Utf8(canonicalJson([snapshotId, path, kind, name, start, end, null]))
}

function entriesFromResult(snapshot: RepositorySnapshotV1, filePath: string, sourceHash: string, result: unknown): InternalSymbolEntryV1[] {
  if (result === null) return []
  if (!Array.isArray(result)) throw new TypeError('LSP document symbols result is invalid')
  return result.map(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new TypeError('LSP document symbol is invalid')
    const symbol = item as Record<string, unknown>
    if (typeof symbol.name !== 'string' || symbol.name.length === 0 || symbol.name.length > 512 || typeof symbol.kind !== 'number' || !Number.isSafeInteger(symbol.kind)) throw new TypeError('LSP document symbol fields are invalid')
    const rangeValue = symbol.selectionRange ?? symbol.range
    if (typeof rangeValue !== 'object' || rangeValue === null || Array.isArray(rangeValue)) throw new TypeError('LSP document symbol range is invalid')
    const range = rangeValue as Record<string, unknown>
    const start = position(range.start)
    const end = position(range.end)
    if (end.line < start.line || (end.line === start.line && end.column < start.column)) throw new TypeError('LSP document symbol range is invalid')
    const kind = KIND_NAMES[symbol.kind as number] ?? `lsp-${symbol.kind as number}`
    return Object.freeze({
      symbolId: symbolId(snapshot.snapshotId, filePath, kind, symbol.name, start, end),
      path: filePath,
      sourceHash,
      start: Object.freeze(start),
      end: Object.freeze(end),
      kind,
      name: symbol.name,
      score: 0,
    })
  })
}

async function cleanup(handle: SubprocessHandle, graceMs: number): Promise<void> {
  handle.terminate()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(5_000, Math.max(1, graceMs)))
  try { await handle.waitForExit(controller.signal) } catch { /* cleanup is best effort and bounded */ }
  finally { clearTimeout(timer) }
}

export class ReadonlyLspAdapter {
  readonly #config: LspDeploymentConfigV1
  readonly #store: RepositorySnapshotStore
  readonly #capability: HostNetworkIsolation
  readonly #subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>

  constructor(config: LspDeploymentConfigV1, store: RepositorySnapshotStore, capability: HostNetworkIsolation, subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>) {
    if (capability.networkIsolation !== 'enforced' || typeof capability.capabilityId !== 'symbol') throw new TypeError('enforced network isolation capability is required')
    this.#config = config
    this.#store = store
    this.#capability = capability
    this.#subprocess = subprocess
  }

  async index(store: RepositorySnapshotStore = this.#store, callerSignal?: AbortSignal): Promise<SymbolAdapterResultV1 | AdapterUnavailableV1> {
    if (store.snapshot.snapshotId !== this.#store.snapshot.snapshotId) return unavailable('protocol-invalid')
    if (callerSignal?.aborted) throw abortReason(callerSignal)
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(new DOMException('LSP indexing timed out', 'TimeoutError')), this.#config.timeoutMs)
    const signal = AbortSignal.any(callerSignal ? [callerSignal, timeoutController.signal] : [timeoutController.signal])
    let handle: SubprocessHandle | undefined
    let failure: AdapterUnavailableCode | undefined
    let callerFailure: unknown
    try {
      const executable = await this.#subprocess.resolveExecutable(this.#config.executable, this.#config.environment, signal)
      if (executable !== this.#config.executable) { failure = 'spawn-failed'; return unavailable(failure) }
      const env: NodeJS.ProcessEnv = {}
      for (const key of Object.keys(process.env)) env[key] = undefined
      for (const [key, value] of Object.entries(this.#config.environment)) env[key] = value
      handle = this.#subprocess.spawn({
        argv: Object.freeze([this.#config.executable, ...this.#config.fixedArgs]),
        cwd: this.#config.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: this.#config.maxStderrBytes } },
        graceMs: this.#config.graceMs,
        signal,
        env,
      })
      if (!handle.stdin || !handle.stdout) { failure = 'spawn-failed'; return unavailable(failure) }
      const inbox = new MessageInbox(handle.stdout, this.#config.maxMessageBytes)
      let id = 1
      await writeMessage(handle.stdin, { jsonrpc: '2.0', id, method: 'initialize', params: { processId: null, rootUri: pathToFileURL(this.#config.cwd).href, capabilities: {} } }, this.#config.maxMessageBytes, signal)
      const initialized = parseLspResponse(await inbox.next(signal), { expectedId: id, method: 'initialize' })
      if (Object.prototype.hasOwnProperty.call(initialized, 'error')) throw new TypeError('LSP initialize failed')
      await writeMessage(handle.stdin, { jsonrpc: '2.0', method: 'initialized', params: {} }, this.#config.maxMessageBytes, signal)
      const entries: InternalSymbolEntryV1[] = []
      for (const file of store.snapshot.files) {
        if (!JS_LANGUAGES.has(file.language)) continue
        const source = await store.readVerifiedFile(file.path, file.contentHash)
        const uri = pathToFileURL(`${this.#config.cwd}/${file.path}`).href
        await writeMessage(handle.stdin, { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: file.language, version: 1, text: source } } }, this.#config.maxMessageBytes, signal)
        id += 1
        await writeMessage(handle.stdin, { jsonrpc: '2.0', id, method: 'textDocument/documentSymbol', params: { textDocument: { uri } } }, this.#config.maxMessageBytes, signal)
        const response = parseLspResponse(await inbox.next(signal), { expectedId: id, method: 'textDocument/documentSymbol' })
        if (Object.prototype.hasOwnProperty.call(response, 'error')) throw new TypeError('LSP document symbols failed')
        entries.push(...entriesFromResult(store.snapshot, file.path, file.contentHash, response.result))
        await writeMessage(handle.stdin, { jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } }, this.#config.maxMessageBytes, signal)
      }
      id += 1
      await writeMessage(handle.stdin, { jsonrpc: '2.0', id, method: 'shutdown', params: null }, this.#config.maxMessageBytes, signal)
      const shutdown = parseLspResponse(await inbox.next(signal), { expectedId: id, method: 'shutdown' })
      if (Object.prototype.hasOwnProperty.call(shutdown, 'error')) throw new TypeError('LSP shutdown failed')
      await writeMessage(handle.stdin, { jsonrpc: '2.0', method: 'exit' }, this.#config.maxMessageBytes, signal)
      await handle.done
      const unique = new Map<string, InternalSymbolEntryV1>()
      for (const entry of entries) unique.set(entry.symbolId, entry)
      return Object.freeze({ adapterId: 'typescript-lsp', adapterVersion: VERSION, entries: Object.freeze([...unique.values()]), relations: Object.freeze({}) })
    } catch (error) {
      if (callerSignal?.aborted) callerFailure = abortReason(callerSignal)
      else if (timeoutController.signal.aborted) failure = 'timed-out'
      else if (failure === undefined) failure = error instanceof TypeError ? 'protocol-invalid' : 'spawn-failed'
    } finally {
      clearTimeout(timer)
      if (handle) await cleanup(handle, this.#config.graceMs)
    }
    if (callerFailure !== undefined) throw callerFailure
    return unavailable(failure ?? 'protocol-invalid')
  }
}

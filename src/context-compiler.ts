import {
  canonicalJson,
  createContextBlockV1,
  MAX_CONTEXT_BLOCK_BYTES,
  MAX_CONTEXT_SESSION_BYTES,
  parseContextBlockV1,
  parseRepoMapPageV1,
  parseSymbolQueryResultV1,
  type ContextBlockV1,
  type RepoMapPageV1,
  type SymbolQueryResultV1,
} from '@han_05/dsh-context'
import type { CacheBoundaryV1, CacheLookupKeyV1, ContextCacheStoreApiV1 } from '@han_05/dsh-context-cache'
import { buildRepoMap, querySymbols, type RepoMapOptionsV1, type SymbolQueryV1 } from './projections.js'
import type { InternalSymbolIndexStore } from './symbol-index.js'
import type { RepositorySnapshotStore } from './snapshot.js'
import type { ContextCompiler, ContextCompilerOptions, ContextCompilerStats, SourceMeasurementV1 } from './types.js'

export const CONTEXT_COMPILER_POLICY_VERSION = 'dsh-context-compiler-v1' as const
export const CONTEXT_CAPABILITY_VERSION = 'dsh-context-capability-v1' as const

const MAX_LIMIT = 50
const MAX_QUERY_BYTES = 256
const MAX_CURSOR_BYTES = 1_024
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

type ProjectionKind = 'repo-map' | 'symbol'
type Window = { readonly path: string; readonly startOffset: number; readonly endOffset: number }
type SessionState = { usedBytes: number; readonly windows: Window[] }
const SHARED_SESSION_KEY = '__shared__'

type ContextCompilerHandle = ContextCompiler & {
  readonly cacheStats: ContextCompilerStats
  readonly stats: ContextCompilerStats
  readonly dispose: () => Promise<void>
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unknown ${name} argument: ${key}`)
}

function aborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  return value
}

function requiredHash(value: unknown, name: string): string {
  const hash = requiredString(value, name)
  if (!HASH_PATTERN.test(hash)) throw new TypeError(`${name} must be a sha256 hash`)
  return hash
}

function validateSnapshotId(value: unknown, snapshot: RepositorySnapshotStore['snapshot']): string {
  const snapshotId = requiredString(value, 'snapshotId')
  if (snapshotId !== snapshot.snapshotId) throw new TypeError('snapshotId is stale or does not match the current snapshot')
  return snapshotId
}

function validateLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) throw new RangeError('limit must be an integer between 1 and 50')
  return value
}

function optionalCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || utf8Length(value) > MAX_CURSOR_BYTES) throw new RangeError('cursor exceeds 1024 UTF-8 bytes')
  return value
}

function repoMapRequest(value: unknown, snapshot: RepositorySnapshotStore['snapshot']): { snapshotId: string; options: RepoMapOptionsV1 } {
  const input = record(value, 'repo map')
  exactKeys(input, ['snapshotId', 'limit', 'cursor'], 'repo map')
  const snapshotId = validateSnapshotId(input.snapshotId, snapshot)
  const limit = validateLimit(input.limit)
  const cursor = optionalCursor(input.cursor)
  return { snapshotId, options: { limit, ...(cursor === undefined ? {} : { cursor }) } }
}

function symbolQueryRequest(value: unknown, snapshot: RepositorySnapshotStore['snapshot']): { snapshotId: string; options: SymbolQueryV1 } {
  const input = record(value, 'symbol query')
  exactKeys(input, ['snapshotId', 'query', 'limit', 'cursor'], 'symbol query')
  const snapshotId = validateSnapshotId(input.snapshotId, snapshot)
  const query = requiredString(input.query, 'query')
  if (utf8Length(query) > MAX_QUERY_BYTES) throw new RangeError('query exceeds 256 UTF-8 bytes')
  const limit = validateLimit(input.limit)
  const cursor = optionalCursor(input.cursor)
  return { snapshotId, options: { query, limit, ...(cursor === undefined ? {} : { cursor }) } }
}

function safeRelativePath(value: unknown): string {
  const path = requiredString(value, 'path')
  if (path.length === 0 || path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new TypeError('path must be a repository-relative POSIX path')
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new TypeError('path must not contain traversal, dot, or empty path segments')
  return path
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
  return value
}

function expansionRequest(value: unknown): { blockId: string; path: string; sourceHash: string; startOffset: number; endOffset: number } {
  const input = record(value, 'source expansion')
  exactKeys(input, ['blockId', 'path', 'sourceHash', 'startOffset', 'endOffset'], 'source expansion')
  const blockId = requiredHash(input.blockId, 'blockId')
  const path = safeRelativePath(input.path)
  const sourceHash = requiredHash(input.sourceHash, 'sourceHash')
  const startOffset = nonNegativeInteger(input.startOffset, 'startOffset')
  const endOffset = nonNegativeInteger(input.endOffset, 'endOffset')
  if (endOffset < startOffset) throw new RangeError('endOffset must be greater than or equal to startOffset')
  if (endOffset - startOffset > MAX_CONTEXT_BLOCK_BYTES) throw new RangeError('source window exceeds the per-block UTF-8 byte budget')
  return { blockId, path, sourceHash, startOffset, endOffset }
}

function pageBlock(
  workspaceRoot: string,
  page: RepoMapPageV1 | SymbolQueryResultV1,
  kind: ProjectionKind,
  boundary: CacheBoundaryV1,
  sources: readonly { path: string; contentHash: string }[],
): ContextBlockV1 {
  const parsed = 'items' in page ? parseRepoMapPageV1(page) : parseSymbolQueryResultV1(page)
  const text = JSON.stringify(parsed)
  if (utf8Length(text) > MAX_CONTEXT_BLOCK_BYTES) throw new RangeError('context projection exceeds the per-block UTF-8 byte budget')
  return parseContextBlockV1(createContextBlockV1({
    schemaVersion: 1,
    workspaceRoot,
    kind,
    workspaceFingerprint: boundary.workspaceFingerprint,
    snapshotId: boundary.snapshotId,
    adapterId: boundary.adapterId,
    adapterVersion: boundary.adapterVersion,
    compilerPolicyVersion: boundary.compilerPolicyVersion,
    sources,
    text,
    truncated: false,
  }))
}

function sourceBlock(workspaceRoot: string, measurement: SourceMeasurementV1, boundary: CacheBoundaryV1): ContextBlockV1 {
  if (measurement.byteLength > MAX_CONTEXT_BLOCK_BYTES) throw new RangeError('source window exceeds the per-block UTF-8 byte budget')
  return parseContextBlockV1(createContextBlockV1({
    schemaVersion: 1,
    workspaceRoot,
    kind: 'source-window',
    workspaceFingerprint: boundary.workspaceFingerprint,
    snapshotId: boundary.snapshotId,
    adapterId: boundary.adapterId,
    adapterVersion: boundary.adapterVersion,
    compilerPolicyVersion: boundary.compilerPolicyVersion,
    sources: [{ path: measurement.path, contentHash: measurement.sourceHash }],
    text: measurement.text,
    truncated: false,
  }))
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xDC00 || next > 0xDFFF) return true
      index += 1
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true
    }
  }
  return false
}

function overlaps(first: Window, second: Window): boolean {
  return first.path === second.path && first.startOffset < second.endOffset && second.startOffset < first.endOffset
}

function projectionDependencies(snapshot: RepositorySnapshotStore['snapshot']): readonly string[] {
  return [...snapshot.files].map(file => file.contentHash).sort()
}

function projectionSources(snapshot: RepositorySnapshotStore['snapshot']): readonly { path: string; contentHash: string }[] {
  return snapshot.files.map(file => ({ path: file.path, contentHash: file.contentHash }))
}

function sameSources(left: readonly { path: string; contentHash: string }[], right: readonly { path: string; contentHash: string }[]): boolean {
  return left.length === right.length && left.every((source, index) => {
    const expected = right[index]
    return expected !== undefined && source.path === expected.path && source.contentHash === expected.contentHash
  })
}

function projectionContainsSource(block: ContextBlockV1, path: string, sourceHash: string): boolean {
  const projection = block.kind === 'repo-map'
    ? parseRepoMapPageV1(JSON.parse(block.text))
    : parseSymbolQueryResultV1(JSON.parse(block.text))
  const values = 'items' in projection ? projection.items : projection.matches
  return values.some(value => value.path === path && value.sourceHash === sourceHash)
}

function validateProjectionBlock(
  block: ContextBlockV1,
  kind: ProjectionKind,
  boundary: CacheBoundaryV1,
  snapshot: RepositorySnapshotStore['snapshot'],
): ContextBlockV1 {
  if (block.kind !== kind) throw new TypeError('cached context block kind does not match the requested projection')
  if (
    block.workspaceFingerprint !== boundary.workspaceFingerprint
    || block.snapshotId !== boundary.snapshotId
    || block.adapterId !== boundary.adapterId
    || block.adapterVersion !== boundary.adapterVersion
    || block.compilerPolicyVersion !== boundary.compilerPolicyVersion
  ) throw new TypeError('cached context block provenance does not match the current boundary')
  const currentSources = projectionSources(snapshot)
  if (!sameSources(block.sources, currentSources)) throw new TypeError('cached context block sources do not match the current snapshot')
  const projection = kind === 'repo-map'
    ? parseRepoMapPageV1(JSON.parse(block.text))
    : parseSymbolQueryResultV1(JSON.parse(block.text))
  if (projection.snapshotId !== snapshot.snapshotId) throw new TypeError('cached projection snapshotId does not match the current snapshot')
  const blockSources = new Map(block.sources.map(source => [source.path, source.contentHash]))
  const snapshotSources = new Map(currentSources.map(source => [source.path, source.contentHash]))
  const values = 'items' in projection ? projection.items : projection.matches
  for (const value of values) {
    if (blockSources.get(value.path) !== value.sourceHash || snapshotSources.get(value.path) !== value.sourceHash) {
      throw new TypeError('cached projection source path or hash does not match block and snapshot provenance')
    }
  }
  return block
}

function lookupKey(boundary: CacheBoundaryV1, normalizedQuery: string, dependencyHashes: readonly string[]): CacheLookupKeyV1 {
  return { ...boundary, normalizedQuery, dependencyHashes }
}

function projectionLookupKey(kind: ProjectionKind, request: RepoMapOptionsV1 | SymbolQueryV1, boundary: CacheBoundaryV1, dependencies: readonly string[]): CacheLookupKeyV1 {
  return lookupKey(boundary, canonicalJson({ kind, request }), dependencies)
}

function makeBoundary(
  snapshot: RepositorySnapshotStore['snapshot'],
  index: InternalSymbolIndexStore,
  compilerPolicyVersion: string,
  capabilityVersion: string,
): CacheBoundaryV1 {
  return {
    workspaceFingerprint: snapshot.workspaceFingerprint,
    snapshotId: snapshot.snapshotId,
    adapterId: index.adapterId,
    adapterVersion: index.adapterVersion,
    compilerPolicyVersion,
    capabilityVersion,
  }
}

export function createContextCompiler(options: ContextCompilerOptions): ContextCompilerHandle {
  const { workspaceRoot, store, index, cache } = options
  const compilerPolicyVersion = options.compilerPolicyVersion ?? CONTEXT_COMPILER_POLICY_VERSION
  const capabilityVersion = options.capabilityVersion ?? CONTEXT_CAPABILITY_VERSION
  const sessions = new Map<string, SessionState>()
  const queues = new Map<string, Promise<void>>()
  let cacheHits = 0
  let cacheMisses = 0
  let disposed = false

  function checkOpen(): void {
    if (disposed) throw new Error('context compiler is disposed')
  }

  function currentBoundary(): CacheBoundaryV1 {
    return makeBoundary(store.snapshot, index, compilerPolicyVersion, capabilityVersion)
  }

  function queueKey(sessionKey: string | undefined): string {
    return sessionKey === undefined ? SHARED_SESSION_KEY : `session:${sessionKey}`
  }

  function serialized<T>(sessionKey: string | undefined, operation: () => Promise<T>): Promise<T> {
    const key = queueKey(sessionKey)
    const previous = queues.get(key) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    const tail = current.then(() => undefined, () => undefined)
    queues.set(key, tail)
    return current.finally(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
  }

  async function cached(
    key: CacheLookupKeyV1,
    boundary: CacheBoundaryV1,
    kind: ProjectionKind,
    signal: AbortSignal,
    compute: () => ContextBlockV1 | Promise<ContextBlockV1>,
  ): Promise<ContextBlockV1> {
    checkOpen()
    aborted(signal)
    const blockIds = await cache.getLookup(key)
    checkOpen()
    aborted(signal)
    if (blockIds?.length === 1) {
      const block = await cache.getBlock(blockIds[0]!, boundary)
      checkOpen()
      aborted(signal)
      if (block !== undefined) {
        validateProjectionBlock(parseContextBlockV1(block), kind, boundary, store.snapshot)
        cacheHits += 1
        return parseContextBlockV1(block)
      }
    }
    cacheMisses += 1
    const block = parseContextBlockV1(await compute())
    checkOpen()
    aborted(signal)
    await cache.putBlock(block, boundary)
    checkOpen()
    aborted(signal)
    await cache.putLookup(key, [block.blockId])
    checkOpen()
    aborted(signal)
    return block
  }

  async function repoMap(value: { snapshotId: string; limit: number; cursor?: string }, signal: AbortSignal, _sessionKey?: string): Promise<ContextBlockV1> {
    checkOpen()
    aborted(signal)
    const request = repoMapRequest(value, store.snapshot)
    const boundary = currentBoundary()
    const dependencies = projectionDependencies(store.snapshot)
    const block = await cached(
      projectionLookupKey('repo-map', request.options, boundary, dependencies),
      boundary,
      'repo-map',
      signal,
      () => pageBlock(workspaceRoot, buildRepoMap(store.snapshot, index, request.options), 'repo-map', boundary, projectionSources(store.snapshot)),
    )
    return validateProjectionBlock(block, 'repo-map', boundary, store.snapshot)
  }

  async function symbolQuery(value: { snapshotId: string; query: string; limit: number; cursor?: string }, signal: AbortSignal, _sessionKey?: string): Promise<ContextBlockV1> {
    checkOpen()
    aborted(signal)
    const request = symbolQueryRequest(value, store.snapshot)
    const boundary = currentBoundary()
    const dependencies = projectionDependencies(store.snapshot)
    const block = await cached(
      projectionLookupKey('symbol', request.options, boundary, dependencies),
      boundary,
      'symbol',
      signal,
      () => pageBlock(workspaceRoot, querySymbols(store.snapshot, index, request.options), 'symbol', boundary, projectionSources(store.snapshot)),
    )
    return validateProjectionBlock(block, 'symbol', boundary, store.snapshot)
  }

  async function expandSource(value: { blockId: string; path: string; sourceHash: string; startOffset: number; endOffset: number }, signal: AbortSignal, sessionKey?: string): Promise<ContextBlockV1> {
    checkOpen()
    aborted(signal)
    const request = expansionRequest(value)
    const boundary = currentBoundary()
    const base = await cache.getBlock(request.blockId, boundary)
    checkOpen()
    aborted(signal)
    if (base === undefined) throw new TypeError('source expansion requires a prior cached projection block')
    if (base.kind !== 'repo-map' && base.kind !== 'symbol') throw new TypeError('source expansion requires a repo-map or symbol block')
    const validatedBase = validateProjectionBlock(base, base.kind, boundary, store.snapshot)
    const source = validatedBase.sources.find(item => item.path === request.path)
    if (source === undefined || source.contentHash !== request.sourceHash) throw new TypeError('source path or hash is not present in the cached projection block')
    if (!projectionContainsSource(validatedBase, request.path, request.sourceHash)) throw new TypeError('source path is not present in the cached projection')

    return serialized(sessionKey, async () => {
      checkOpen()
      aborted(signal)
      const state = sessions.get(queueKey(sessionKey)) ?? { usedBytes: 0, windows: [] }
      sessions.set(queueKey(sessionKey), state)
      const requestedWindow = { path: request.path, startOffset: request.startOffset, endOffset: request.endOffset }
      if (state.windows.some(window => overlaps(window, requestedWindow))) throw new TypeError('source window overlaps a previous expansion')

      const measurement = await store.readSourceMeasurement(request.path, request.sourceHash, request.startOffset, request.endOffset)
      checkOpen()
      aborted(signal)
      if (hasUnpairedSurrogate(measurement.text)) throw new TypeError('source window must end on UTF-16 code-point boundaries')
      const block = sourceBlock(workspaceRoot, measurement, boundary)
      if (state.usedBytes + block.byteLength > MAX_CONTEXT_SESSION_BYTES) throw new RangeError('source expansion exceeds the session byte budget')
      checkOpen()
      aborted(signal)
      const cachedBlock = await cache.getBlock(block.blockId, boundary)
      checkOpen()
      aborted(signal)
      if (cachedBlock !== undefined) {
        cacheHits += 1
      } else {
        cacheMisses += 1
        await cache.putBlock(block, boundary)
        checkOpen()
        aborted(signal)
      }
      state.usedBytes += block.byteLength
      state.windows.push(requestedWindow)
      return cachedBlock ?? block
    })
  }

  const compiler: ContextCompilerHandle = {
    repoMap,
    symbolQuery,
    expandSource,
    get cacheStats(): ContextCompilerStats { return { hits: cacheHits, misses: cacheMisses } },
    get stats(): ContextCompilerStats { return { hits: cacheHits, misses: cacheMisses } },
    async dispose(): Promise<void> {
      disposed = true
      await cache.close()
    },
  }
  return Object.freeze(compiler)
}

export type { ContextCompilerHandle }

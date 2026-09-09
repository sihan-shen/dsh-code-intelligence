import {
  canonicalJson,
  createContextBlockV1,
  parseContextBlockV1,
  parseRelationQueryResultP0,
  parseRepoMapPageP0,
  parseSymbolQueryResultP0,
  type ContextBlockV1,
  type RelationQueryResultP0,
  type RepoMapPageP0,
  type SymbolQueryResultP0,
} from '@han_05/dsh-context'
import type {
  CacheBlockReadV1,
  CacheBoundaryV1,
  CacheLookupKeyV1,
  CacheWriteResultV1,
  ContextCacheStoreApiV1,
} from '@han_05/dsh-context-cache'
import type { RuntimeP0 } from './p0-runtime.js'
import type { BuiltIndexP0 } from './p0-types.js'

export type P0QueryKind = 'repo-map' | 'symbol-query' | 'relation-query'
export type P0QueryResult = RepoMapPageP0 | SymbolQueryResultP0 | RelationQueryResultP0
export type P0QueryParser = (value: unknown) => P0QueryResult

const COMPILER_POLICY = 'dsh-code-intelligence-p0-v1'
const CAPABILITY = 'dsh-code-intelligence-p0-cache-v1'

function boundary(index: BuiltIndexP0): CacheBoundaryV1 {
  return {
    workspaceFingerprint: index.snapshot.workspaceFingerprint,
    snapshotId: index.snapshot.snapshotId,
    indexFingerprint: index.indexFingerprint,
    adapterId: index.providerConfigIdentity.providerId,
    adapterVersion: index.providerConfigIdentity.providerVersion,
    compilerPolicyVersion: COMPILER_POLICY,
    capabilityVersion: CAPABILITY,
  }
}

function sourceBoundary(value: CacheBoundaryV1): CacheBoundaryV1 {
  const { indexFingerprint: _indexFingerprint, ...result } = value
  return result
}

function dependencies(index: BuiltIndexP0): readonly string[] {
  return [...index.snapshot.files].map(file => file.contentHash).sort()
}

function sources(index: BuiltIndexP0): readonly { readonly path: string; readonly contentHash: string }[] {
  return index.snapshot.files.map(file => ({ path: file.path, contentHash: file.contentHash }))
}

function lookupKey(index: BuiltIndexP0, kind: P0QueryKind, request: unknown): CacheLookupKeyV1 {
  const b = boundary(index)
  return {
    ...b,
    normalizedQuery: canonicalJson({ kind, request }),
    dependencyHashes: dependencies(index),
  }
}

function blockKind(kind: P0QueryKind): 'repo-map' | 'symbol' | 'relation' {
  return kind === 'repo-map' ? 'repo-map' : kind === 'symbol-query' ? 'symbol' : 'relation'
}

function makeBlock(index: BuiltIndexP0, kind: P0QueryKind, value: P0QueryResult, workspaceRoot: string): ContextBlockV1 {
  const b = boundary(index)
  return parseContextBlockV1(createContextBlockV1({
    schemaVersion: 1,
    workspaceRoot,
    kind: blockKind(kind),
    workspaceFingerprint: b.workspaceFingerprint,
    snapshotId: b.snapshotId,
    indexFingerprint: b.indexFingerprint,
    adapterId: b.adapterId,
    adapterVersion: b.adapterVersion,
    compilerPolicyVersion: b.compilerPolicyVersion,
    sources: sources(index),
    text: JSON.stringify(value),
    truncated: false,
  }))
}

function parserFor(kind: P0QueryKind): P0QueryParser {
  return kind === 'repo-map' ? parseRepoMapPageP0 : kind === 'symbol-query' ? parseSymbolQueryResultP0 : parseRelationQueryResultP0
}

function validateQueryBlock(index: BuiltIndexP0, kind: P0QueryKind, block: ContextBlockV1): P0QueryResult {
  const b = boundary(index)
  if (block.kind !== blockKind(kind)
    || block.workspaceFingerprint !== b.workspaceFingerprint
    || block.snapshotId !== b.snapshotId
    || block.indexFingerprint !== b.indexFingerprint
    || block.adapterId !== b.adapterId
    || block.adapterVersion !== b.adapterVersion
    || block.compilerPolicyVersion !== b.compilerPolicyVersion
    || JSON.stringify(block.sources) !== JSON.stringify(sources(index))) throw new TypeError('cache boundary mismatch')
  return parserFor(kind)(JSON.parse(block.text))
}

function readBlock(cache: ContextCacheStoreApiV1, blockId: string, b: CacheBoundaryV1): Promise<CacheBlockReadV1> {
  return cache.readBlock === undefined
    ? cache.getBlock(blockId, b).then(block => block === undefined
      ? { status: 'missing' as const, reason: 'record-missing' as const }
      : { status: 'hit' as const, block })
    : cache.readBlock(blockId, b)
}

async function confirmedBlock(cache: ContextCacheStoreApiV1, block: ContextBlockV1, b: CacheBoundaryV1): Promise<CacheWriteResultV1> {
  try {
    return cache.putBlockConfirmed === undefined
      ? (await cache.putBlock(block, b), { status: 'confirmed' })
      : await cache.putBlockConfirmed(block, b)
  } catch {
    return { status: 'unavailable', reason: 'storage-error' }
  }
}

async function confirmedLookup(cache: ContextCacheStoreApiV1, key: CacheLookupKeyV1, blockId: string): Promise<CacheWriteResultV1> {
  try {
    return cache.putLookupConfirmed === undefined
      ? (await cache.putLookup(key, [blockId]), { status: 'confirmed' })
      : await cache.putLookupConfirmed(key, [blockId])
  } catch {
    return { status: 'unavailable', reason: 'storage-error' }
  }
}

/** Cache failures are deliberately converted to a normal query miss. */
export async function cachedP0Query(
  runtime: RuntimeP0,
  workspaceRoot: string,
  kind: P0QueryKind,
  request: unknown,
  execute: () => P0QueryResult,
): Promise<P0QueryResult> {
  const cache = runtime.cache
  if (cache === undefined) return execute()
  const index = runtime.index
  const b = boundary(index)
  const key = lookupKey(index, kind, request)
  let blockIds: readonly string[] | undefined
  try {
    const lookup = cache.readLookup === undefined
      ? { status: 'hit' as const, blockIds: (await cache.getLookup(key)) ?? [] }
      : await cache.readLookup(key)
    if (lookup.status === 'hit') blockIds = lookup.blockIds
  } catch { /* unavailable: continue without cache */ }
  if (blockIds?.length === 1) {
    try {
      const read = await readBlock(cache, blockIds[0]!, b)
      if (read.status === 'hit') {
        const parsed = parseContextBlockV1(read.block)
        const value = validateQueryBlock(index, kind, parsed)
        return { ...value, blockId: parsed.blockId } as P0QueryResult
      }
    } catch { /* corrupt or forged cache record: recompute */ }
  }
  const value = execute()
  const block = makeBlock(index, kind, value, workspaceRoot)
  const stored = await confirmedBlock(cache, block, b)
  if (stored.status !== 'confirmed') return value
  const indexed = await confirmedLookup(cache, key, block.blockId)
  return indexed.status === 'confirmed' ? { ...value, blockId: block.blockId } as P0QueryResult : value
}

export type ExplicitBlockStatus = 'hit' | 'not-found' | 'stale-block' | 'cache-unavailable'
export type ExplicitBlockRead = { readonly status: ExplicitBlockStatus; readonly block?: ContextBlockV1 }

/** Validate an explicit source association without ever using cached text as the source read. */
export async function readExplicitP0Block(runtime: RuntimeP0, blockId: string, path: string, sourceHash: string): Promise<ExplicitBlockRead> {
  const cache = runtime.cache
  if (cache === undefined) return { status: 'cache-unavailable' }
  const index = runtime.index
  const current = boundary(index)
  let read: CacheBlockReadV1
  try { read = await readBlock(cache, blockId, current) } catch { return { status: 'cache-unavailable' } }
  if (read.status === 'unavailable') return { status: 'cache-unavailable' }
  if (read.status === 'missing' || read.status === 'corrupt') return { status: 'not-found' }
  if (read.status === 'boundary-mismatch') {
    // Pure source blocks intentionally omit indexFingerprint. They may be valid
    // across an unrelated index rebuild, but still remain snapshot-bound.
    try {
      const sourceRead = await readBlock(cache, blockId, sourceBoundary(current))
      if (sourceRead.status === 'unavailable') return { status: 'cache-unavailable' }
      if (sourceRead.status !== 'hit') return { status: 'stale-block' }
      const source = parseContextBlockV1(sourceRead.block)
      if (source.kind !== 'source-window') return { status: 'stale-block' }
      return source.workspaceFingerprint === current.workspaceFingerprint && source.snapshotId === current.snapshotId
        && source.sources.some(item => item.path === path && item.contentHash === sourceHash)
        ? { status: 'hit', block: source } : { status: 'stale-block' }
    } catch { return { status: 'stale-block' } }
  }
  if (read.status !== 'hit') return { status: 'stale-block' }
  try {
    const block = parseContextBlockV1(read.block)
    if (block.kind === 'source-window') return { status: 'stale-block' }
    if (block.indexFingerprint !== current.indexFingerprint || block.snapshotId !== current.snapshotId) return { status: 'stale-block' }
    const value = block.kind === 'repo-map' ? parseRepoMapPageP0(JSON.parse(block.text))
      : block.kind === 'symbol' ? parseSymbolQueryResultP0(JSON.parse(block.text))
        : block.kind === 'relation' ? parseRelationQueryResultP0(JSON.parse(block.text)) : undefined
    if (value === undefined) return { status: 'stale-block' }
    const values = 'items' in value ? value.items : 'matches' in value ? value.matches : []
    return values.some(item => item.path === path && item.sourceHash === sourceHash)
      ? { status: 'hit', block } : { status: 'stale-block' }
  } catch { return { status: 'stale-block' } }
}

export function p0CacheBoundary(index: BuiltIndexP0): CacheBoundaryV1 { return boundary(index) }
export function p0SourceCacheBoundary(index: BuiltIndexP0): CacheBoundaryV1 { return sourceBoundary(boundary(index)) }

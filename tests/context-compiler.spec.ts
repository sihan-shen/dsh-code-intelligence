import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createContextBlockV1,
  MAX_CONTEXT_BLOCK_BYTES,
  MAX_CONTEXT_SESSION_BYTES,
  parseContextBlockV1,
  parseRepoMapPageV1,
  parseSymbolQueryResultV1,
  sha256Utf8,
} from '@ds-plugins/dsh-context'
import { ContextCacheStore } from '@ds-plugins/dsh-context-cache'
import type { CacheBoundaryV1, ContextCacheStoreApiV1 } from '@ds-plugins/dsh-context-cache'
import { createContextCompiler } from '../src/context-compiler.ts'
import { parseSnapshotConfig } from '../src/config.ts'
import { extractFallbackSymbols } from '../src/fallback.ts'
import { buildSymbolIndex } from '../src/symbol-index.ts'
import { RepositorySnapshotStore } from '../src/snapshot.ts'
import { mountCodeIntelligence } from '../src/plugin.ts'
import { createContextTools } from '../src/tools.ts'
import type { ContextBlockV1, ContextCompiler } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function config(deploymentRoot: string) {
  return parseSnapshotConfig({
    deploymentRoot,
    revision: 'context-compiler-fixture-1',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
  })
}

async function fixture(source = 'export function authenticate(token: string) { return token.length > 0 }\n') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-compiler-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'auth.ts'), source, 'utf8')
  await writeFile(join(root, 'src', 'billing.ts'), 'export class BillingService { charge() {} }\n', 'utf8')
  const store = await RepositorySnapshotStore.create(config(root))
  const adapter = await extractFallbackSymbols(store)
  const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
  const cache = await ContextCacheStore.open({ deploymentRoot: root })
  const compiler = createContextCompiler({ workspaceRoot: root, store, index, cache })
  return { root, store, index, cache, compiler }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(value => { resolve = value })
  return { promise, resolve }
}

type MemoryCache = ContextCacheStoreApiV1 & { readonly blocks: Map<string, ContextBlockV1> }

function memoryCache(): MemoryCache {
  const blocks = new Map<string, ContextBlockV1>()
  const lookups = new Map<string, readonly string[]>()
  const keyOf = (value: unknown): string => JSON.stringify(value)
  return {
    blocks,
    async getBlock(blockId) { return blocks.get(blockId) },
    async putBlock(block) { blocks.set(block.blockId, block) },
    async getToolResult() { return undefined },
    async putToolResult() {},
    async getLookup(key) { return lookups.get(keyOf(key)) },
    async putLookup(key, blockIds) { lookups.set(keyOf(key), [...blockIds]) },
    async invalidateBySourceHashes() {},
    async close() {},
  }
}

function gatedStore(store: RepositorySnapshotStore): {
  readonly store: RepositorySnapshotStore
  readonly firstRead: Promise<void>
  readonly release: () => void
  readonly readCount: () => number
} {
  const started = deferred<void>()
  const release = deferred<void>()
  let reads = 0
  const wrapped = Object.create(store) as RepositorySnapshotStore
  Object.defineProperty(wrapped, 'snapshot', { value: store.snapshot })
  Object.defineProperty(wrapped, 'readSourceMeasurement', {
    value: async (...args: [string, string, number, number]) => {
      reads += 1
      if (reads === 1) started.resolve(undefined)
      await release.promise
      return store.readSourceMeasurement(...args)
    },
  })
  return { store: wrapped, firstRead: started.promise, release: () => release.resolve(undefined), readCount: () => reads }
}

function fileHash(store: RepositorySnapshotStore, path: string): string {
  return store.snapshot.files.find(file => file.path === path)!.contentHash
}

function boundary(store: RepositorySnapshotStore, index: ReturnType<typeof buildSymbolIndex>, overrides: Partial<CacheBoundaryV1> = {}): CacheBoundaryV1 {
  return {
    workspaceFingerprint: store.snapshot.workspaceFingerprint,
    snapshotId: store.snapshot.snapshotId,
    adapterId: index.adapterId,
    adapterVersion: index.adapterVersion,
    compilerPolicyVersion: 'dsh-context-compiler-v1',
    capabilityVersion: 'dsh-context-capability-v1',
    ...overrides,
  }
}

describe('ContextCompiler projection blocks', () => {
  it('compiles parsed bounded Repo Map and Symbol Query blocks with exact source provenance', async () => {
    const { store, cache, compiler } = await fixture()
    const repoMap = parseContextBlockV1(await compiler.repoMap({ snapshotId: store.snapshot.snapshotId, limit: 10 }, signal()))
    const symbol = parseContextBlockV1(await compiler.symbolQuery({ snapshotId: store.snapshot.snapshotId, query: 'authenticate', limit: 10 }, signal()))

    expect(repoMap.kind).toBe('repo-map')
    expect(symbol.kind).toBe('symbol')
    expect(repoMap.snapshotId).toBe(store.snapshot.snapshotId)
    expect(symbol.snapshotId).toBe(store.snapshot.snapshotId)
    expect(repoMap.sources).toEqual([
      { path: 'src/auth.ts', contentHash: fileHash(store, 'src/auth.ts') },
      { path: 'src/billing.ts', contentHash: fileHash(store, 'src/billing.ts') },
    ])
    expect(symbol.sources).toEqual([
      { path: 'src/auth.ts', contentHash: fileHash(store, 'src/auth.ts') },
      { path: 'src/billing.ts', contentHash: fileHash(store, 'src/billing.ts') },
    ])
    expect(parseRepoMapPageV1(JSON.parse(repoMap.text))).toMatchObject({ snapshotId: store.snapshot.snapshotId })
    expect(parseSymbolQueryResultV1(JSON.parse(symbol.text))).toMatchObject({ snapshotId: store.snapshot.snapshotId })
    expect(repoMap.text).not.toContain('export function')
    expect(symbol.text).not.toContain('export function')
    expect(repoMap.byteLength).toBeLessThanOrEqual(MAX_CONTEXT_BLOCK_BYTES)
    expect(symbol.byteLength).toBeLessThanOrEqual(MAX_CONTEXT_BLOCK_BYTES)
    await cache.close()
  })

  it('records one projection miss, then a hit, and does not reuse a stale boundary', async () => {
    const { root, store, index, cache, compiler } = await fixture()
    const request = { snapshotId: store.snapshot.snapshotId, limit: 1 }
    const first = await compiler.repoMap(request, signal())
    const second = await compiler.repoMap(request, signal())
    expect(second).toEqual(first)
    expect(compiler.cacheStats).toEqual({ hits: 1, misses: 1 })

    const staleCompiler = createContextCompiler({
      workspaceRoot: root,
      store,
      index,
      cache,
      capabilityVersion: 'dsh-context-capability-stale',
    })
    await expect(staleCompiler.repoMap(request, signal())).resolves.toEqual(first)
    expect(staleCompiler.cacheStats).toEqual({ hits: 0, misses: 1 })
    await cache.close()
  })

  it('rejects a cached projection whose embedded or outer provenance is forged', async () => {
    const { root, store, index, cache: realCache } = await fixture()
    const cache = memoryCache()
    const compiler = createContextCompiler({ workspaceRoot: root, store, index, cache })
    const request = { snapshotId: store.snapshot.snapshotId, limit: 10 }
    const base = await compiler.repoMap(request, signal())
    const projection = JSON.parse(base.text) as { snapshotId: string; items: Array<{ path: string; sourceHash: string; summary: string }> }
    const forgedHash = sha256Utf8('forged')
    const variants = [
      createContextBlockV1({
        schemaVersion: 1,
        workspaceRoot: root,
        kind: base.kind,
        workspaceFingerprint: base.workspaceFingerprint,
        snapshotId: base.snapshotId,
        adapterId: base.adapterId,
        adapterVersion: base.adapterVersion,
        compilerPolicyVersion: base.compilerPolicyVersion,
        sources: base.sources,
        text: JSON.stringify({ ...projection, snapshotId: sha256Utf8('stale snapshot') }),
        truncated: false,
      }),
      createContextBlockV1({
        schemaVersion: 1,
        workspaceRoot: root,
        kind: base.kind,
        workspaceFingerprint: sha256Utf8('other workspace'),
        snapshotId: base.snapshotId,
        adapterId: base.adapterId,
        adapterVersion: base.adapterVersion,
        compilerPolicyVersion: base.compilerPolicyVersion,
        sources: base.sources,
        text: base.text,
        truncated: false,
      }),
      createContextBlockV1({
        schemaVersion: 1,
        workspaceRoot: root,
        kind: base.kind,
        workspaceFingerprint: base.workspaceFingerprint,
        snapshotId: sha256Utf8('other snapshot'),
        adapterId: base.adapterId,
        adapterVersion: base.adapterVersion,
        compilerPolicyVersion: base.compilerPolicyVersion,
        sources: base.sources,
        text: base.text,
        truncated: false,
      }),
      createContextBlockV1({
        schemaVersion: 1,
        workspaceRoot: root,
        kind: base.kind,
        workspaceFingerprint: base.workspaceFingerprint,
        snapshotId: base.snapshotId,
        adapterId: base.adapterId,
        adapterVersion: base.adapterVersion,
        compilerPolicyVersion: base.compilerPolicyVersion,
        sources: base.sources.map((source, index) => index === 0 ? { ...source, contentHash: forgedHash } : source),
        text: base.text,
        truncated: false,
      }),
      createContextBlockV1({
        schemaVersion: 1,
        workspaceRoot: root,
        kind: base.kind,
        workspaceFingerprint: base.workspaceFingerprint,
        snapshotId: base.snapshotId,
        adapterId: 'forged-adapter',
        adapterVersion: base.adapterVersion,
        compilerPolicyVersion: base.compilerPolicyVersion,
        sources: base.sources,
        text: base.text,
        truncated: false,
      }),
      createContextBlockV1({
        schemaVersion: 1,
        workspaceRoot: root,
        kind: base.kind,
        workspaceFingerprint: base.workspaceFingerprint,
        snapshotId: base.snapshotId,
        adapterId: base.adapterId,
        adapterVersion: base.adapterVersion,
        compilerPolicyVersion: base.compilerPolicyVersion,
        sources: base.sources,
        text: JSON.stringify({
          ...projection,
          items: projection.items.map((item, index) => index === 0 ? { ...item, sourceHash: forgedHash } : item),
        }),
        truncated: false,
      }),
      createContextBlockV1({
        schemaVersion: 1,
        workspaceRoot: root,
        kind: base.kind,
        workspaceFingerprint: base.workspaceFingerprint,
        snapshotId: base.snapshotId,
        adapterId: base.adapterId,
        adapterVersion: base.adapterVersion,
        compilerPolicyVersion: base.compilerPolicyVersion,
        sources: base.sources,
        text: JSON.stringify({
          ...projection,
          items: projection.items.map((item, index) => index === 0 ? { ...item, path: 'src/forged.ts' } : item),
        }),
        truncated: false,
      }),
    ]

    for (const forged of variants) {
      cache.blocks.set(base.blockId, forged)
      await expect(compiler.repoMap(request, signal())).rejects.toThrow(/provenance|snapshot|source|boundary/i)
    }
    await compiler.dispose()
    await realCache.close()
  })
})

describe('ContextCompiler progressive source disclosure', () => {
  it('requires a cached projection block and matching path/hash, then returns bounded provenance', async () => {
    const { store, cache, compiler } = await fixture('const π = "🙂 source"\nexport function authenticate() { return true }\n')
    const base = await compiler.repoMap({ snapshotId: store.snapshot.snapshotId, limit: 10 }, signal())
    const sourceHash = fileHash(store, 'src/auth.ts')
    const startOffset = 0
    const endOffset = 'const π = "🙂 source"\n'.length
    const expanded = parseContextBlockV1(await compiler.expandSource({
      blockId: base.blockId,
      path: 'src/auth.ts',
      sourceHash,
      startOffset,
      endOffset,
    }, signal()))

    expect(expanded.kind).toBe('source-window')
    expect(expanded.sources).toEqual([{ path: 'src/auth.ts', contentHash: sourceHash }])
    expect(expanded.text).toBe('const π = "🙂 source"\n')
    expect(expanded.byteLength).toBe(new TextEncoder().encode(expanded.text).byteLength)
    expect(new TextEncoder().encode(expanded.text).byteLength).toBeLessThanOrEqual(MAX_CONTEXT_BLOCK_BYTES)
    await expect(compiler.expandSource({
      blockId: 'sha256:' + '0'.repeat(64),
      path: 'src/auth.ts',
      sourceHash,
      startOffset,
      endOffset,
    }, signal())).rejects.toThrow(/cached|block|unknown/i)
    await expect(compiler.expandSource({
      blockId: base.blockId,
      path: 'src/auth.ts',
      sourceHash: sha256Utf8('wrong'),
      startOffset,
      endOffset,
    }, signal())).rejects.toThrow(/source|hash|provenance/i)
    await expect(compiler.expandSource({
      blockId: base.blockId,
      path: '../secret',
      sourceHash,
      startOffset,
      endOffset,
    }, signal())).rejects.toThrow(/path|safe|traversal/i)
    await cache.close()
  })

  it('rejects overlapping, oversized, over-budget, and pre-aborted windows before disclosure', async () => {
    const source = 'x'.repeat(MAX_CONTEXT_SESSION_BYTES + 1)
    const { store, cache, compiler } = await fixture(source)
    const base = await compiler.repoMap({ snapshotId: store.snapshot.snapshotId, limit: 10 }, signal())
    const sourceHash = fileHash(store, 'src/auth.ts')
    const controller = new AbortController()
    const first = { blockId: base.blockId, path: 'src/auth.ts', sourceHash, startOffset: 0, endOffset: MAX_CONTEXT_BLOCK_BYTES }
    await compiler.expandSource(first, controller.signal)
    await expect(compiler.expandSource({ ...first, startOffset: MAX_CONTEXT_BLOCK_BYTES - 1, endOffset: MAX_CONTEXT_BLOCK_BYTES + 1 }, controller.signal)).rejects.toThrow(/overlap/i)
    await expect(compiler.expandSource({ ...first, startOffset: MAX_CONTEXT_BLOCK_BYTES, endOffset: MAX_CONTEXT_BLOCK_BYTES * 2 }, controller.signal)).resolves.toBeDefined()
    await compiler.expandSource({ ...first, startOffset: MAX_CONTEXT_BLOCK_BYTES * 2, endOffset: MAX_CONTEXT_BLOCK_BYTES * 3 }, controller.signal)
    await compiler.expandSource({ ...first, startOffset: MAX_CONTEXT_BLOCK_BYTES * 3, endOffset: MAX_CONTEXT_BLOCK_BYTES * 4 }, controller.signal)
    await expect(compiler.expandSource({ ...first, startOffset: MAX_CONTEXT_BLOCK_BYTES * 4, endOffset: MAX_CONTEXT_BLOCK_BYTES * 4 + 1 }, controller.signal)).rejects.toThrow(/session|budget/i)
    await expect(compiler.expandSource({ ...first, startOffset: 0, endOffset: MAX_CONTEXT_BLOCK_BYTES + 1 }, signal())).rejects.toThrow(/oversized|byte|window/i)
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    await expect(compiler.expandSource(first, aborted.signal)).rejects.toThrow(/cancel/i)
    await cache.close()
  })

  it('serializes overlap checks for one trusted key across separate signals', async () => {
    const { root, store, index, cache: realCache } = await fixture('x'.repeat(MAX_CONTEXT_BLOCK_BYTES * 2))
    const cache = memoryCache()
    const controlled = gatedStore(store)
    const compiler = createContextCompiler({ workspaceRoot: root, store: controlled.store, index, cache })
    const base = await compiler.repoMap({ snapshotId: store.snapshot.snapshotId, limit: 10 }, signal())
    const sourceHash = fileHash(store, 'src/auth.ts')
    const first = compiler.expandSource({ blockId: base.blockId, path: 'src/auth.ts', sourceHash, startOffset: 0, endOffset: MAX_CONTEXT_BLOCK_BYTES }, signal(), 'agent-a')
    await controlled.firstRead
    const second = compiler.expandSource({ blockId: base.blockId, path: 'src/auth.ts', sourceHash, startOffset: MAX_CONTEXT_BLOCK_BYTES - 1, endOffset: MAX_CONTEXT_BLOCK_BYTES + 1 }, signal(), 'agent-a')
    await Promise.resolve()
    expect(controlled.readCount()).toBe(1)
    controlled.release()
    await expect(first).resolves.toBeDefined()
    await expect(second).rejects.toThrow(/overlap/i)
    await compiler.dispose()
    await realCache.close()
  })

  it('shares the exact session budget across signals and keeps different keys independent', async () => {
    const { root, store, index, cache: realCache } = await fixture('x'.repeat(MAX_CONTEXT_BLOCK_BYTES * 5 + 1))
    const cache = memoryCache()
    const compiler = createContextCompiler({ workspaceRoot: root, store, index, cache })
    const base = await compiler.repoMap({ snapshotId: store.snapshot.snapshotId, limit: 10 }, signal())
    const sourceHash = fileHash(store, 'src/auth.ts')
    const call = (index: number, sessionKey?: string) => compiler.expandSource({
      blockId: base.blockId,
      path: 'src/auth.ts',
      sourceHash,
      startOffset: index * MAX_CONTEXT_BLOCK_BYTES,
      endOffset: (index + 1) * MAX_CONTEXT_BLOCK_BYTES,
    }, signal(), sessionKey)

    const keyed = await Promise.allSettled([
      ...Array.from({ length: 5 }, (_, index) => call(index, 'agent-a')),
      ...Array.from({ length: 5 }, (_, index) => call(index, 'agent-b')),
    ])
    for (const key of ['agent-a', 'agent-b']) {
      const group = keyed.slice(key === 'agent-a' ? 0 : 5, key === 'agent-a' ? 5 : 10)
      expect(group.filter(result => result.status === 'fulfilled')).toHaveLength(4)
      expect(group.filter(result => result.status === 'rejected' && /session|budget/i.test(String(result.reason)))).toHaveLength(1)
    }

    const direct = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => call(index)))
    expect(direct.filter(result => result.status === 'fulfilled')).toHaveLength(4)
    expect(direct.filter(result => result.status === 'rejected' && /session|budget/i.test(String(result.reason)))).toHaveLength(1)
    await compiler.dispose()
    await realCache.close()
  })

  it('fails closed when the source mutates between the snapshot and verified read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-mutation-'))
    roots.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    const path = join(root, 'src', 'auth.ts')
    await writeFile(path, 'export function before() { return true }\n', 'utf8')
    let mutate = false
    const store = await RepositorySnapshotStore.create(config(root), {
      afterOpenForTest: async absolutePath => {
        if (mutate && absolutePath === path) await writeFile(absolutePath, 'export function after() { return false }\n', 'utf8')
      },
    })
    const adapter = await extractFallbackSymbols(store)
    const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
    const cache = await ContextCacheStore.open({ deploymentRoot: root })
    const compiler = createContextCompiler({ workspaceRoot: root, store, index, cache })
    const base = await compiler.repoMap({ snapshotId: store.snapshot.snapshotId, limit: 10 }, signal())
    mutate = true
    await expect(compiler.expandSource({
      blockId: base.blockId,
      path: 'src/auth.ts',
      sourceHash: fileHash(store, 'src/auth.ts'),
      startOffset: 0,
      endOffset: 10,
    }, signal())).rejects.toThrow(/changed|mismatch|stable|source/i)
    await cache.close()
  })
})

describe('context read-only tools', () => {
  it('exposes only exact bounded context arguments and parsed ContextBlockV1 results', async () => {
    const { store, compiler, cache } = await fixture()
    const tools = createContextTools(compiler)
    expect(tools.map(tool => tool.name)).toEqual(['context_repo_map', 'context_symbol_query', 'context_expand_source'])
    const repoMap = tools[0]!
    await expect(repoMap.execute({ snapshotId: store.snapshot.snapshotId, limit: 1, extra: true }, { signal: signal() } as never)).rejects.toThrow(/unknown|allowed|key/i)
    const result = await repoMap.execute({ snapshotId: store.snapshot.snapshotId, limit: 1 }, { signal: signal() } as never)
    expect(parseContextBlockV1(result)).toEqual(result)
    await cache.close()
  })

  it('derives trusted session keys from agent identity, then root call identity', async () => {
    const block = createContextBlockV1({
      schemaVersion: 1,
      workspaceRoot: '/workspace',
      kind: 'repo-map',
      workspaceFingerprint: sha256Utf8('workspace'),
      snapshotId: sha256Utf8('snapshot'),
      adapterId: 'adapter',
      adapterVersion: '1',
      compilerPolicyVersion: 'policy',
      sources: [],
      text: JSON.stringify({ schemaVersion: 1, snapshotId: sha256Utf8('snapshot'), items: [], totalItems: 0, truncated: false }),
      truncated: false,
    })
    const keys: Array<string | undefined> = []
    const compiler: ContextCompiler = {
      async repoMap(_request, _signal, sessionKey) { keys.push(sessionKey); return block },
      async symbolQuery(_request, _signal, sessionKey) { keys.push(sessionKey); return block },
      async expandSource(_request, _signal, sessionKey) { keys.push(sessionKey); return block },
    }
    const tools = createContextTools(compiler)
    const agent = {}
    const request = { snapshotId: block.snapshotId, limit: 1 }
    await tools[0]!.execute(request, { signal: signal(), agent, rootCallId: 'root-one' } as never)
    await tools[0]!.execute(request, { signal: signal(), agent, rootCallId: 'root-two' } as never)
    await tools[0]!.execute(request, { signal: signal(), agent: {}, rootCallId: 'root-three' } as never)
    await tools[0]!.execute(request, { signal: signal(), rootCallId: 'root-four' } as never)
    await tools[0]!.execute(request, { signal: signal() } as never)
    expect(keys[0]).toBe(keys[1])
    expect(keys[2]).not.toBe(keys[0])
    expect(keys[3]).toBe('root:root-four')
    expect(keys[4]).toBeUndefined()
  })

  it('registers the compiler service and context tools in one disposable lifecycle effect', async () => {
    const { store, index, compiler, cache } = await fixture()
    const values = new Map<string, unknown>()
    const services = new Map<string, unknown>()
    const effects: Array<() => void | Promise<void>> = []
    const ctx = {
      tools: {
        register(tool: { readonly name: string }) {
          values.set(tool.name, tool)
          return () => { values.delete(tool.name) }
        },
      },
      provide(name: string, value: unknown) {
        services.set(name, value)
        return () => { services.delete(name) }
      },
      effect(effect: () => () => void | Promise<void>) {
        const dispose = effect()
        effects.push(dispose)
        return dispose
      },
    }
    mountCodeIntelligence(ctx as never, { snapshot: store.snapshot, index, compiler })
    expect(services.get('contextCompiler')).toBe(compiler)
    expect([...values.keys()]).toEqual([
      'code_repo_map',
      'code_symbol_query',
      'context_repo_map',
      'context_symbol_query',
      'context_expand_source',
    ])
    expect(effects).toHaveLength(1)
    await effects[0]!()
    expect(values).toHaveLength(0)
    expect(services).toHaveLength(0)
    await expect(compiler.repoMap({ snapshotId: store.snapshot.snapshotId, limit: 1 }, signal())).rejects.toThrow(/disposed/i)
    await cache.close()
  })
})

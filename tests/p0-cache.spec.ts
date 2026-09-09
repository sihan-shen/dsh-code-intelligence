import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextCacheStore, type CacheBlockReadV1, type CacheLookupReadV1, type CacheWriteResultV1, type ContextCacheStoreApiV1 } from '@han_05/dsh-context-cache'
import { createContextBlockV1, OUTPUT_POLICY_P0 } from '@han_05/dsh-context'
import { buildIndexP0 } from '../src/p0-build.ts'
import { parseSnapshotConfigP0 } from '../src/p0-snapshot.ts'
import { createVerifiedReaderP0 } from '../src/p0-reader.ts'
import { expandSourceP0, SourceBudgetP0 } from '../src/p0-source.ts'
import { relationQueryP0, repoMapP0 } from '../src/p0-query.ts'
import { cachedP0Query, p0CacheBoundary, readExplicitP0Block } from '../src/p0-cache.ts'
import { createToolsP0 } from '../src/p0-tools.ts'
import type { RuntimeP0, ResolverP0 } from '../src/p0-runtime.ts'
import type { ContextBlockV1 } from '../src/types.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })) ) })

function cacheFixture(options: {
  readonly blockWrite?: CacheWriteResultV1
  readonly lookupWrite?: CacheWriteResultV1
  readonly lookupRead?: () => Promise<CacheLookupReadV1>
  readonly blockRead?: (blockId: string) => Promise<CacheBlockReadV1>
} = {}): ContextCacheStoreApiV1 & { readonly blocks: Map<string, ContextBlockV1>; readonly lookups: Map<string, readonly string[]> } {
  const blocks = new Map<string, ContextBlockV1>()
  const lookups = new Map<string, readonly string[]>()
  const key = (value: unknown) => JSON.stringify(value)
  return {
    blocks,
    lookups,
    async getBlock(blockId) { return blocks.get(blockId) },
    async readBlock(blockId) { return options.blockRead?.(blockId) ?? (blocks.has(blockId) ? { status: 'hit', block: blocks.get(blockId)! } : { status: 'missing', reason: 'record-missing' }) },
    async putBlock(block) { blocks.set(block.blockId, block) },
    async putBlockConfirmed(block) { if (options.blockWrite && options.blockWrite.status !== 'confirmed') return options.blockWrite; blocks.set(block.blockId, block); return options.blockWrite ?? { status: 'confirmed' } },
    async getToolResult() { return undefined }, async putToolResult() {},
    async getLookup(value) { return lookups.get(key(value)) },
    async readLookup(value) { return options.lookupRead?.() ?? (lookups.has(key(value)) ? { status: 'hit', blockIds: lookups.get(key(value))! } : { status: 'miss', reason: 'lookup-miss' }) },
    async putLookup(value, ids) { lookups.set(key(value), [...ids]) },
    async putLookupConfirmed(value, ids) { if (options.lookupWrite && options.lookupWrite.status !== 'confirmed') return options.lookupWrite; lookups.set(key(value), [...ids]); return options.lookupWrite ?? { status: 'confirmed' } },
    async invalidateBySourceHashes() {}, async close() {},
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-p0-cache-')); roots.push(root)
  await mkdir(root, { recursive: true })
  await writeFile(`${root}/main.ts`, "import 'dependency'\nexport class Box { method() {} }\nexport function main() { return true }\n")
  const index = await buildIndexP0(parseSnapshotConfigP0({ deploymentRoot: root, revision: 'cache-test' }))
  const runtime = (cache?: ContextCacheStoreApiV1): RuntimeP0 => ({ index, reader: async () => { throw new Error('not used') }, config: parseSnapshotConfigP0({ deploymentRoot: root, revision: 'cache-test' }), ...(cache ? { cache } : {}) })
  return { root, index, runtime }
}

describe('P0 optional cache acceptance', () => {
  it('keeps queries available when a snapshot source disappears before block construction', async () => {
    const { root, index, runtime } = await fixture()
    const request = { limit: 10 }
    const direct = repoMapP0(index, request)
    await rm(join(root, 'main.ts'))
    await expect(cachedP0Query(runtime(cacheFixture()), root, 'repo-map', request, () => direct)).resolves.toEqual(direct)
  })

  it.each(['snapshotId', 'indexFingerprint'] as const)('recomputes a block with an incorrect embedded %s', async field => {
    const { root, index, runtime } = await fixture()
    const cache = cacheFixture()
    const request = { limit: 10 }
    const direct = repoMapP0(index, request)
    const first = await cachedP0Query(runtime(cache), root, 'repo-map', request, () => direct)
    const original = cache.blocks.get(first.blockId!)!
    const wrong = 'sha256:' + 'f'.repeat(64)
    const projection = { ...direct, [field]: wrong,
      ...(field === 'snapshotId' ? { provenance: direct.provenance.map(p => ({ ...p, snapshotId: wrong })) } : {}) }
    const { blockId: _id, contentHash: _hash, byteLength: _bytes, ...input } = original
    const forged = createContextBlockV1({ ...input, workspaceRoot: root, text: JSON.stringify(projection) })
    cache.blocks.set(forged.blockId, forged)
    for (const key of cache.lookups.keys()) cache.lookups.set(key, [forged.blockId])
    let executions = 0
    const result = await cachedP0Query(runtime(cache), root, 'repo-map', request, () => { executions++; return direct })
    expect(executions).toBe(1)
    expect(result.snapshotId).toBe(index.snapshot.snapshotId)
    expect(result.indexFingerprint).toBe(index.indexFingerprint)
  })

  it.each(['block', 'lookup'] as const)('does not infer confirmation from a legacy %s write', async missing => {
    const { root, index, runtime } = await fixture()
    const cache = cacheFixture()
    if (missing === 'block') delete cache.putBlockConfirmed
    else delete cache.putLookupConfirmed
    cache.putBlock = async () => {}
    cache.putLookup = async () => {}
    const request = { limit: 10 }
    const direct = repoMapP0(index, request)
    await expect(cachedP0Query(runtime(cache), root, 'repo-map', request, () => direct)).resolves.toEqual(direct)
  })

  it('preserves disabled parity and only exposes a block after both writes are confirmed', async () => {
    const { root, index, runtime } = await fixture()
    const request = { snapshotId: index.snapshot.snapshotId, limit: 10 }
    const direct = repoMapP0(index, request)
    let executions = 0
    const cache = cacheFixture()
    const first = await cachedP0Query(runtime(cache), root, 'repo-map', request, () => { executions++; return repoMapP0(index, request) })
    expect({ ...first, blockId: undefined }).toEqual(direct)
    expect(first.blockId).toMatch(/^sha256:/)
    expect(executions).toBe(1)
    const hit = await cachedP0Query(runtime(cache), root, 'repo-map', request, () => { executions++; return repoMapP0(index, request) })
    expect(hit).toEqual(first)
    expect(executions).toBe(1)
    let disabledExecutions = 0
    const disabled = await cachedP0Query(runtime(), root, 'repo-map', request, () => { disabledExecutions++; return repoMapP0(index, request) })
    expect(disabled).toEqual(direct)
    expect(disabledExecutions).toBe(1)
  })

  it('recomputes corrupt records and suppresses blockId when confirmed writes are unavailable', async () => {
    const { root, index, runtime } = await fixture()
    const request = { snapshotId: index.snapshot.snapshotId, limit: 10 }
    const corrupt = cacheFixture()
    let executions = 0
    const first = await cachedP0Query(runtime(corrupt), root, 'repo-map', request, () => { executions++; return repoMapP0(index, request) })
    const id = first.blockId!
    corrupt.blocks.set(id, { ...corrupt.blocks.get(id)!, text: '{broken' } as ContextBlockV1)
    const recomputed = await cachedP0Query(runtime(corrupt), root, 'repo-map', request, () => { executions++; return repoMapP0(index, request) })
    expect(executions).toBe(2)
    expect(recomputed.blockId).toBe(id)
    const unavailable = cacheFixture({ blockWrite: { status: 'unavailable', reason: 'lock-timeout' } })
    const noBlock = await cachedP0Query(runtime(unavailable), root, 'repo-map', request, () => repoMapP0(index, request))
    expect(noBlock).toEqual(repoMapP0(index, request))
    expect(noBlock).not.toHaveProperty('blockId')
  })

  it('does not reuse a lookup across index fingerprints and refresh-style execution stays outside cache', async () => {
    const { root, index, runtime } = await fixture()
    const request = { snapshotId: index.snapshot.snapshotId, limit: 10 }
    const cache = cacheFixture()
    await cachedP0Query(runtime(cache), root, 'repo-map', request, () => repoMapP0(index, request))
    const changed = { ...index, indexFingerprint: 'sha256:' + '1'.repeat(64) }
    let executions = 0
    const result = await cachedP0Query({ ...runtime(cache), index: changed }, root, 'repo-map', request, () => { executions++; return repoMapP0(changed, request) })
    expect(executions).toBe(1)
    expect(result.blockId).toMatch(/^sha256:/)
  })

  it('deduplicates identical source dependencies so persistent lookups remain usable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-p0-cache-duplicates-')); roots.push(root)
    const source = 'export const same = true\n'
    await writeFile(join(root, 'a.ts'), source)
    await writeFile(join(root, 'b.ts'), source)
    const config = parseSnapshotConfigP0({ deploymentRoot: root, revision: 'duplicates' })
    const index = await buildIndexP0(config)
    const cache = await ContextCacheStore.open({ deploymentRoot: root })
    const runtime: RuntimeP0 = { index, reader: async () => { throw new Error('not used') }, config, cache }
    const request = { snapshotId: index.snapshot.snapshotId, limit: 10 }
    let executions = 0
    const execute = () => { executions++; return repoMapP0(index, request) }

    const first = await cachedP0Query(runtime, root, 'repo-map', request, execute)
    const second = await cachedP0Query(runtime, root, 'repo-map', request, execute)

    expect(first.blockId).toMatch(/^sha256:/)
    expect(second).toEqual(first)
    expect(executions).toBe(1)
    await cache.close()
  })

  it('suppresses only the optional blockId when it would exceed the output budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-p0-cache-output-')); roots.push(root)
    for (let index = 0; index < 50; index++) {
      const segment = (value: number, extra = 0) => String.fromCharCode(97 + value % 26).repeat(220 + extra) + String(value).padStart(3, '0')
      const directory = join(root, segment(index, 29), segment(index + 50), segment(index + 100), segment(index + 150), segment(index + 200))
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `f${index}.ts`), `export const v${index} = true\n`)
    }
    const config = parseSnapshotConfigP0({ deploymentRoot: root, revision: 'output-budget' })
    const index = await buildIndexP0(config)
    const runtime: RuntimeP0 = { index, reader: async () => { throw new Error('not used') }, config, cache: cacheFixture() }
    const request = { snapshotId: index.snapshot.snapshotId, limit: 50 }
    let executions = 0
    const execute = () => { executions++; return repoMapP0(index, request) }

    const first = await cachedP0Query(runtime, root, 'repo-map', request, execute)
    const second = await cachedP0Query(runtime, root, 'repo-map', request, execute)

    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(OUTPUT_POLICY_P0.maxOutputBytes)
    expect(first).not.toHaveProperty('blockId')
    expect(second).toEqual(first)
    expect(executions).toBe(1)
  })

  it('accepts relation blocks associated through file and symbol source endpoints', async () => {
    const { root, index, runtime } = await fixture()
    const cache = cacheFixture()
    const file = index.snapshot.files.find(item => item.path === 'main.ts')!
    const fileRequest = { snapshotId: index.snapshot.snapshotId, from: { path: 'main.ts' }, types: ['imports'] }
    const fileResult = await cachedP0Query(runtime(cache), root, 'relation-query', fileRequest, () => relationQueryP0(index, fileRequest))
    expect(fileResult.blockId).toMatch(/^sha256:/)
    await expect(readExplicitP0Block(runtime(cache), fileResult.blockId!, file.path, file.contentHash)).resolves.toMatchObject({ status: 'hit' })

    const box = index.symbols.find(symbol => symbol.name === 'Box')!
    const symbolRequest = { snapshotId: index.snapshot.snapshotId, from: { symbolId: box.symbolId }, types: ['contains'] }
    const symbolResult = await cachedP0Query(runtime(cache), root, 'relation-query', symbolRequest, () => relationQueryP0(index, symbolRequest))
    expect(symbolResult.blockId).toMatch(/^sha256:/)
    await expect(readExplicitP0Block(runtime(cache), symbolResult.blockId!, box.path, box.sourceHash)).resolves.toMatchObject({ status: 'hit' })
  })

  it('maps explicit missing, corrupt, boundary mismatch and unavailable reads to distinct statuses', async () => {
    const { index, runtime } = await fixture()
    const boundary = p0CacheBoundary(index)
    const source = (status: CacheBlockReadV1): ContextCacheStoreApiV1 => cacheFixture({ blockRead: async () => status })
    const missing = await readExplicitP0Block(runtime(source({ status: 'missing', reason: 'record-missing' })), 'sha256:' + '0'.repeat(64), 'main.ts', index.snapshot.files[0]!.contentHash)
    expect(missing.status).toBe('not-found')
    const corrupt = await readExplicitP0Block(runtime(source({ status: 'corrupt', reason: 'record-corrupt' })), 'sha256:' + '0'.repeat(64), 'main.ts', index.snapshot.files[0]!.contentHash)
    expect(corrupt.status).toBe('not-found')
    const stale = await readExplicitP0Block(runtime(source({ status: 'boundary-mismatch', reason: 'boundary-mismatch' })), 'sha256:' + '0'.repeat(64), 'main.ts', index.snapshot.files[0]!.contentHash)
    expect(stale.status).toBe('stale-block')
    const unavailable = await readExplicitP0Block(runtime(source({ status: 'unavailable', reason: 'lock-timeout' })), 'sha256:' + '0'.repeat(64), 'main.ts', index.snapshot.files[0]!.contentHash)
    expect(unavailable.status).toBe('cache-unavailable')
    expect(boundary.snapshotId).toBe(index.snapshot.snapshotId)
  })

  it('accepts a source-only block across an unrelated index fingerprint change', async () => {
    const { root, index, runtime } = await fixture()
    const file = index.snapshot.files[0]!
    const block = createContextBlockV1({ schemaVersion: 1, workspaceRoot: root, kind: 'source-window',
      workspaceFingerprint: index.snapshot.workspaceFingerprint, snapshotId: index.snapshot.snapshotId,
      adapterId: 'fallback', adapterVersion: '1', compilerPolicyVersion: 'dsh-code-intelligence-p0-v1',
      sources: [{ path: file.path, contentHash: file.contentHash }], text: 'verified', truncated: false })
    let reads = 0
    const cache = cacheFixture({ blockRead: async () => {
      reads++
      return reads === 1 ? { status: 'boundary-mismatch', reason: 'boundary-mismatch' } : { status: 'hit', block }
    } })
    const result = await readExplicitP0Block(runtime(cache), block.blockId, file.path, file.contentHash)
    expect(result).toMatchObject({ status: 'hit', block })
    expect(reads).toBe(2)
  })

  it('suppresses an explicit blockId when it would overflow the source output budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-p0-cache-source-budget-')); roots.push(root)
    // Size a comment-only TS file so its wholeFile source JSON sits just below the
    // 65536-byte output ceiling; appending a blockId would then exceed it.
    await writeFile(join(root, 'big.ts'), `//${'x'.repeat(65187)}\n`)
    const config = parseSnapshotConfigP0({ deploymentRoot: root, revision: 'source-budget' })
    const index = await buildIndexP0(config)
    const receipt = index.snapshot.files.find(file => file.path === 'big.ts')!
    const reader = await createVerifiedReaderP0(root)
    const cache = await ContextCacheStore.open({ deploymentRoot: root })
    const runtime: RuntimeP0 = { index, reader, config, cache }

    const base = await expandSourceP0(index, reader, {
      snapshotId: index.snapshot.snapshotId, path: 'big.ts', sourceHash: receipt.contentHash, wholeFile: true,
    })
    const baseBytes = Buffer.byteLength(JSON.stringify(base))
    const blockIdBytes = Buffer.byteLength(JSON.stringify('sha256:' + 'a'.repeat(64)))
    expect(baseBytes).toBeLessThanOrEqual(OUTPUT_POLICY_P0.maxOutputBytes)
    expect(baseBytes + blockIdBytes).toBeGreaterThan(OUTPUT_POLICY_P0.maxOutputBytes)

    // Produce a confirmed query blockId for this exact path/hash.
    const map = await cachedP0Query(runtime, root, 'repo-map', { snapshotId: index.snapshot.snapshotId, path: 'big.ts' }, () => repoMapP0(index, { snapshotId: index.snapshot.snapshotId, path: 'big.ts' }))
    expect(map.blockId).toMatch(/^sha256:/)

    const resolver: ResolverP0 = {
      async resolve() { return { runtime, budget: new SourceBudgetP0(null), signal: new AbortController().signal, done() {} } },
      async release() {}, async dispose() {},
    }
    const tool = createToolsP0(resolver).find(definition => definition.name === 'context_expand_source')!
    // The explicit blockId validates, but must NOT turn the near-budget read into a
    // budget-exceeded failure; it is suppressed instead.
    const value = await tool.execute({
      snapshotId: index.snapshot.snapshotId, path: 'big.ts', sourceHash: receipt.contentHash, blockId: map.blockId!, wholeFile: true,
    }, { signal: new AbortController().signal } as ToolRunContext)
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(OUTPUT_POLICY_P0.maxOutputBytes)
    expect(value).not.toHaveProperty('blockId')
    expect(value).toMatchObject({ path: 'big.ts', sourceHash: receipt.contentHash })
    await cache.close()
  })
})

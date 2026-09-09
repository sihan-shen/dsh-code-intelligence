import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CacheBlockReadV1, CacheLookupReadV1, CacheWriteResultV1, ContextCacheStoreApiV1 } from '@han_05/dsh-context-cache'
import { createContextBlockV1 } from '@han_05/dsh-context'
import { buildIndexP0 } from '../src/p0-build.ts'
import { parseSnapshotConfigP0 } from '../src/p0-snapshot.ts'
import { repoMapP0 } from '../src/p0-query.ts'
import { cachedP0Query, p0CacheBoundary, readExplicitP0Block } from '../src/p0-cache.ts'
import type { RuntimeP0 } from '../src/p0-runtime.ts'
import type { ContextBlockV1 } from '../src/types.ts'

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
  await writeFile(`${root}/main.ts`, 'export function main() { return true }\n')
  const index = await buildIndexP0(parseSnapshotConfigP0({ deploymentRoot: root, revision: 'cache-test' }))
  const runtime = (cache?: ContextCacheStoreApiV1): RuntimeP0 => ({ index, reader: async () => { throw new Error('not used') }, config: parseSnapshotConfigP0({ deploymentRoot: root, revision: 'cache-test' }), ...(cache ? { cache } : {}) })
  return { root, index, runtime }
}

describe('P0 optional cache acceptance', () => {
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
})

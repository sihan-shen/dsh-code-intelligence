import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRepoMapPageV1, parseSymbolQueryResultV1 } from '@han_05/dsh-context'
import { extractFallbackSymbols } from '../src/fallback.ts'
import { buildRepoMap, querySymbols } from '../src/projections.ts'
import { RepositorySnapshotStore } from '../src/snapshot.ts'
import { parseSnapshotConfig } from '../src/config.ts'
import { buildSymbolIndex } from '../src/symbol-index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(extraFiles: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-projection-'))
  roots.push(root)
  const files = {
    'src/auth.ts': 'export function authenticate(token: string) { return token.length > 0 }\n',
    'src/billing.ts': 'export class BillingService { charge() {} }\n',
    'src/utility.ts': 'export function parseToken(value: string) { return value }\n',
    ...extraFiles,
  }
  for (const [path, source] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, source)
  }
  const store = await RepositorySnapshotStore.create(parseSnapshotConfig({
    deploymentRoot: root,
    revision: 'projection-fixture-1',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
  }))
  const adapter = await extractFallbackSymbols(store)
  return { store, index: buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries) }
}

describe('bounded repository projections', () => {
  it('pages the lexical Repo Map deterministically without omissions or duplicates', async () => {
    const { store, index } = await fixture()
    const pages = []
    let cursor: string | undefined
    do {
      const page = buildRepoMap(store.snapshot, index, { limit: 2, ...(cursor ? { cursor } : {}) })
      expect(parseRepoMapPageV1(page)).toEqual(page)
      pages.push(...page.items.map(item => item.path))
      cursor = page.nextCursor
      expect(page.truncated).toBe(cursor !== undefined)
      expect(page.totalItems).toBe(store.snapshot.files.length)
    } while (cursor)
    expect(pages).toEqual([...pages].sort())
    expect(new Set(pages).size).toBe(store.snapshot.files.length)
    expect(pages).toEqual(store.snapshot.files.map(file => file.path))
  })

  it('ranks symbol queries with stable scores and carries snapshot provenance', async () => {
    const { store, index } = await fixture()
    const first = querySymbols(store.snapshot, index, { query: 'authenticate', limit: 5 })
    const second = querySymbols(store.snapshot, index, { query: 'authenticate', limit: 5 })
    expect(first).toEqual(second)
    expect(parseSymbolQueryResultV1(first)).toEqual(first)
    expect(first.snapshotId).toBe(store.snapshot.snapshotId)
    expect(first.matches[0]).toMatchObject({ path: 'src/auth.ts', name: 'authenticate', sourceHash: store.snapshot.files.find(file => file.path === 'src/auth.ts')?.contentHash })
    expect(first.matches[0]?.score).toBeGreaterThanOrEqual(first.matches.at(-1)?.score ?? 0)
    expect(first.matches.every(match => match.sourceHash.startsWith('sha256:'))).toBe(true)
  })

  it('rejects invalid request bounds and stale or tampered cursors', async () => {
    const { store, index } = await fixture()
    const page = buildRepoMap(store.snapshot, index, { limit: 1 })
    expect(() => buildRepoMap(store.snapshot, index, { limit: 0 })).toThrow(/limit/i)
    expect(() => buildRepoMap(store.snapshot, index, { limit: 51 })).toThrow(/limit/i)
    expect(() => querySymbols(store.snapshot, index, { query: 'x'.repeat(257), limit: 1 })).toThrow(/query/i)
    expect(() => buildRepoMap(store.snapshot, index, { limit: 1, cursor: 'x'.repeat(1025) })).toThrow(/cursor/i)
    expect(page.nextCursor).toBeDefined()
    const cursor = page.nextCursor!
    expect(() => buildRepoMap({ ...store.snapshot, snapshotId: 'sha256:' + 'f'.repeat(64) }, index, { limit: 1, cursor })).toThrow(/snapshot|stale/i)
    expect(() => buildRepoMap(store.snapshot, index, { limit: 1, cursor: `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}` })).toThrow(/cursor|digest|invalid/i)
  })
})

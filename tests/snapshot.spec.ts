import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Utf8 } from '@han_05/dsh-context'
import { RepositorySnapshotStore } from '../src/snapshot.ts'
import { parseSnapshotConfig } from '../src/config.ts'
import { createSessionRuntimeResolver } from '../src/session-runtime.ts'

const fixtureRoot = resolve(fileURLToPath(new URL('./fixtures/repository/', import.meta.url)))
const createdRoots: string[] = []

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true }))
  }
})

function config(deploymentRoot: string, overrides: Record<string, unknown> = {}) {
  return parseSnapshotConfig({
    deploymentRoot,
    revision: 'fixture-rev-1',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
    ...overrides,
  })
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-'))
  createdRoots.push(root)
  return root
}

describe('snapshot configuration', () => {
  it('canonicalizes an existing deployment root and rejects unknown or unsafe values', async () => {
    const root = await temporaryRoot()
    const parsed = config(join(root, '.'))
    expect(parsed.deploymentRoot).toBe(root)
    expect(() => config(join(root, 'missing'))).toThrow(/deploymentRoot/i)
    expect(() => parseSnapshotConfig({ ...parsed, unknown: true })).toThrow(/unknown/i)
    expect(() => parseSnapshotConfig({ ...parsed, revision: '' })).toThrow()
    expect(() => parseSnapshotConfig({ ...parsed, nestedCheckoutRoots: ['src', 'src'] })).toThrow(/duplicate/i)
    expect(() => parseSnapshotConfig({ ...parsed, nestedCheckoutRoots: ['../outside'] })).toThrow()
    expect(() => parseSnapshotConfig({ ...parsed, maxFileBytes: 1_048_577 })).toThrow()
    expect(() => parseSnapshotConfig({ ...parsed, maxFiles: 10_001 })).toThrow()
    expect(() => parseSnapshotConfig({ ...parsed, maxTotalBytes: 67_108_865 })).toThrow()
    expect(() => parseSnapshotConfig({ ...parsed, maxDirectories: 20_001 })).toThrow()
    expect(() => parseSnapshotConfig({ ...parsed, maxIgnoreBytes: 262_145 })).toThrow()
  })
})

describe('RepositorySnapshotStore', () => {
  it('does not include a runtime-created context cache when the workspace has no gitignore', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'source.ts'), 'export const source = true\n')
    await expect(lstat(join(root, '.gitignore'))).rejects.toThrow()

    const resolver = createSessionRuntimeResolver(config(root))
    const runtime = await resolver.resolveDefault()

    await expect(lstat(join(root, '.dsh-context-cache'))).resolves.toBeDefined()
    expect(runtime.snapshot.files.map(file => file.path).some(path => path === '.dsh-context-cache' || path.startsWith('.dsh-context-cache/'))).toBe(false)
    await resolver.dispose()
  })

  it('does not allow source expansion to read a runtime cache file', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'source.ts'), 'export const source = true\n')
    const resolver = createSessionRuntimeResolver(config(root))
    const runtime = await resolver.resolveDefault()
    const base = await runtime.compiler.repoMap({ snapshotId: runtime.snapshot.snapshotId, limit: 50 }, new AbortController().signal)
    const cachePath = '.dsh-context-cache/v1/.access-clock'
    const cacheHash = sha256Utf8(await readFile(join(root, cachePath), 'utf8'))

    await expect(runtime.compiler.expandSource({
      blockId: base.blockId,
      path: cachePath,
      sourceHash: cacheHash,
      startOffset: 0,
      endOffset: 0,
    }, new AbortController().signal)).rejects.toThrow(/source|path|cached|snapshot/i)
    await resolver.dispose()
  })

  it('builds deterministic, immutable summaries with language and UTF-8 metadata', async () => {
    const first = await RepositorySnapshotStore.create(config(fixtureRoot))
    const second = await RepositorySnapshotStore.create(config(fixtureRoot))
    expect(first.snapshot).toEqual(second.snapshot)
    expect(first.snapshot.snapshotId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.snapshot.workspaceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.snapshot.files.map(file => file.path)).toEqual(['.gitignore', 'src/auth.ts', 'src/service.js'])
    expect(first.snapshot.files.map(file => file.language)).toEqual(['text', 'typescript', 'javascript'])
    for (const file of first.snapshot.files) {
      const source = await readFile(join(fixtureRoot, file.path), 'utf8')
      expect(file.contentHash).toBe(sha256Utf8(source))
      expect(file.byteLength).toBe(Buffer.byteLength(source, 'utf8'))
      expect(file.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(Object.isFrozen(file)).toBe(true)
    }
    expect(Object.isFrozen(first.snapshot)).toBe(true)
    expect(Object.isFrozen(first.snapshot.files)).toBe(true)
    expect(JSON.stringify(first.snapshot)).not.toContain('export function')
  })

  it('excludes hard-private, ignored, binary, NUL, oversized, nested-checkout, and symlink files', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, '.gitignore'), 'ignored.ts\nsrc/ignored.js\n')
    await writeFile(join(root, 'src', 'keep.ts'), 'x\n')
    await writeFile(join(root, 'ignored.ts'), 'export const ignored = true\n')
    await writeFile(join(root, 'src', 'ignored.js'), 'export const ignored = true\n')
    await mkdir(join(root, '.git'))
    await mkdir(join(root, '.dsh'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, '.env.local'), 'SECRET=1\n')
    await writeFile(join(root, 'private.pem'), 'private\n')
    await writeFile(join(root, 'asset.png'), 'not an image\n')
    await writeFile(join(root, 'nul.ts'), Buffer.from('export const bad = "\0"\n'))
    await writeFile(join(root, 'large.ts'), 'x'.repeat(100))
    await mkdir(join(root, 'nested', '.git'), { recursive: true })
    await writeFile(join(root, 'nested', 'child.ts'), 'export const child = true\n')
    await mkdir(join(root, 'nested-file'), { recursive: true })
    await writeFile(join(root, 'nested-file', '.git'), 'gitdir: ../elsewhere\n')
    await writeFile(join(root, 'nested-file', 'child.ts'), 'export const child = true\n')
    await symlink(join(root, 'src', 'keep.ts'), join(root, 'safe-link.ts'))
    await symlink(join(tmpdir(), 'not-in-root'), join(root, 'escape.ts'))
    const snapshot = await RepositorySnapshotStore.create(config(root, { maxFileBytes: 40 }))
    expect(snapshot.snapshot.files.map(file => file.path)).toEqual(['.gitignore', 'src/keep.ts'])
  })

  it('reads only a verified full file and an exact UTF-16 source window', async () => {
    const store = await RepositorySnapshotStore.create(config(fixtureRoot))
    const file = store.snapshot.files.find(item => item.path === 'src/auth.ts')!
    const source = await store.readVerifiedFile(file.path, file.contentHash)
    expect(source).toContain('authenticate')
    await expect(store.readVerifiedFile('../package.json', file.contentHash)).rejects.toThrow()
    await expect(store.readVerifiedFile(file.path, 'sha256:' + '0'.repeat(64))).rejects.toThrow(/mismatch|hash/i)
    const startOffset = source.indexOf('authenticate')
    const endOffset = startOffset + 'authenticate'.length
    const measurement = await store.readSourceMeasurement(file.path, file.contentHash, startOffset, endOffset)
    expect(measurement).toEqual({
      path: file.path,
      sourceHash: file.contentHash,
      startOffset,
      endOffset,
      text: 'authenticate',
      byteLength: Buffer.byteLength('authenticate', 'utf8'),
    })
    await expect(store.readSourceMeasurement(file.path, file.contentHash, -1, endOffset)).rejects.toThrow()
    await expect(store.readSourceMeasurement(file.path, file.contentHash, endOffset, startOffset)).rejects.toThrow()
  })

  it('fails closed when a file changes between open and the second receipt check', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'source.ts')
    await writeFile(path, 'export const before = true\n')
    let changed = false
    const store = await RepositorySnapshotStore.create(config(root), {
      afterOpenForTest: async (absolutePath) => {
        if (!changed && absolutePath === path) {
          changed = true
          await writeFile(absolutePath, 'export const after = true\n')
        }
      },
    })
    const file = store.snapshot.files[0]
    await expect(store.readVerifiedFile(file.path, file.contentHash)).rejects.toThrow(/changed|mismatch|stable/i)
  })

  it('rejects a changed file even when only the expected hash is supplied', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'source.ts')
    await writeFile(path, 'export const before = true\n')
    const store = await RepositorySnapshotStore.create(config(root))
    const file = store.snapshot.files[0]
    await writeFile(path, 'export const after = true\n')
    await expect(store.readVerifiedFile(file.path, file.contentHash)).rejects.toThrow()
  })
})

describe('snapshot test setup', () => {
  it('does not require repository execution or a Git checkout', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'README.md'), 'fixture\n')
    const stat = await lstat(root)
    expect(stat.isDirectory()).toBe(true)
    expect(dirname(root)).toBe(tmpdir())
    await chmod(join(root, 'README.md'), 0o600)
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextCacheStore } from '@han_05/dsh-context-cache'
import { createContextCompiler } from '../src/context-compiler.ts'
import { extractFallbackSymbols } from '../src/fallback.ts'
import { createSessionRuntimeResolver } from '../src/session-runtime.ts'
import { RepositorySnapshotStore } from '../src/snapshot.ts'
import { buildSymbolIndex } from '../src/symbol-index.ts'

vi.mock('@han_05/dsh-context-cache', () => ({
  ContextCacheStore: { open: vi.fn() },
}))
vi.mock('../src/context-compiler.ts', () => ({ createContextCompiler: vi.fn() }))
vi.mock('../src/fallback.ts', () => ({ extractFallbackSymbols: vi.fn() }))
vi.mock('../src/snapshot.ts', () => ({ RepositorySnapshotStore: { create: vi.fn() } }))
vi.mock('../src/symbol-index.ts', () => ({ buildSymbolIndex: vi.fn() }))

const roots: string[] = []

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

function config(root: string) {
  return {
    workspaceRoot: root,
    deploymentRoot: root,
    revision: 'test',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
  }
}

async function controlledResolver() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-runtime-'))
  roots.push(root)
  const disposeStarted = deferred<void>()
  const allowDispose = deferred<void>()
  const compiler = {
    repoMap: vi.fn(),
    symbolQuery: vi.fn(),
    expandSource: vi.fn(),
    dispose: vi.fn(async () => {
      disposeStarted.resolve(undefined)
      await allowDispose.promise
    }),
  }
  vi.mocked(ContextCacheStore.open).mockResolvedValue({ close: vi.fn() } as never)
  vi.mocked(RepositorySnapshotStore.create).mockResolvedValue({
    snapshot: { snapshotId: 'snapshot' },
  } as never)
  vi.mocked(extractFallbackSymbols).mockResolvedValue({ entries: [] } as never)
  vi.mocked(buildSymbolIndex).mockReturnValue({} as never)
  vi.mocked(createContextCompiler).mockReturnValue(compiler as never)
  const resolver = createSessionRuntimeResolver(config(root), {
    async resolveByPath(path) { return { path } },
  })
  const session = { header: { cwd: root } } as never
  await resolver.resolveSession(session)
  return { resolver, session, compiler, disposeStarted, allowDispose }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('session runtime lifecycle', () => {
  it('closes an opened cache when runtime initialization fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-runtime-init-'))
    roots.push(root)
    const close = vi.fn(async () => {})
    vi.mocked(ContextCacheStore.open).mockResolvedValue({ close } as never)
    vi.mocked(RepositorySnapshotStore.create).mockRejectedValue(new Error('snapshot failed'))
    const resolver = createSessionRuntimeResolver({ ...config(root), cache: { enabled: true } }, { async resolveByPath(path) { return { path } } })
    await expect(resolver.resolveDefault()).rejects.toThrow('snapshot failed')
    expect(close).toHaveBeenCalledTimes(1)
    await resolver.dispose()
  })
  it('drains a fire-and-forget release during resolver disposal', async () => {
    const controlled = await controlledResolver()
    void controlled.resolver.release(controlled.session)
    await controlled.disposeStarted.promise

    let disposed = false
    const disposal = controlled.resolver.dispose().then(() => { disposed = true })
    await new Promise<void>(resolve => { setImmediate(resolve) })

    expect(disposed).toBe(false)
    controlled.allowDispose.resolve(undefined)
    await disposal
    expect(controlled.compiler.dispose).toHaveBeenCalledTimes(1)
  })

  it('closes one runtime once when release races resolver disposal', async () => {
    const controlled = await controlledResolver()
    const disposal = controlled.resolver.dispose()
    const release = controlled.resolver.release(controlled.session)
    await controlled.disposeStarted.promise
    controlled.allowDispose.resolve(undefined)

    await Promise.all([disposal, release])
    expect(controlled.compiler.dispose).toHaveBeenCalledTimes(1)
  })

  it('reports a failed fire-and-forget release when resolver disposal drains it', async () => {
    const controlled = await controlledResolver()
    const failure = new Error('compiler close failed')
    controlled.compiler.dispose.mockImplementationOnce(async () => {
      controlled.disposeStarted.resolve(undefined)
      throw failure
    })
    void controlled.resolver.release(controlled.session)
    await controlled.disposeStarted.promise
    await new Promise<void>(resolve => { setImmediate(resolve) })

    await expect(controlled.resolver.dispose()).rejects.toBe(failure)
  })
})

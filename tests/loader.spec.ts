import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { sha256Utf8 } from '@ds-plugins/dsh-context'
import { apply } from '../src/plugin.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function config(root: string) {
  return {
    deploymentRoot: root,
    revision: 'loader-fixture-1',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
  }
}

type RegisteredTool = {
  readonly name: string
  readonly execute: (args: unknown, exec: {
    readonly signal: AbortSignal
    readonly agent?: { readonly session: { readonly header: { readonly cwd?: string } } }
  }) => Promise<{ readonly snapshotId: string; readonly items?: readonly { readonly path: string }[] }>
}

type WorkspaceRegistry = {
  readonly resolveByPath: (path: string) => Promise<{ readonly path: string } | undefined>
}

function execution(cwd?: string) {
  return {
    signal: new AbortController().signal,
    agent: cwd === undefined ? undefined : { session: { header: { cwd } } },
  }
}

const defaultWorkspaceRegistry: WorkspaceRegistry = {
  async resolveByPath(path) { return { path } },
}

function pluginContext(workspaceRegistry: WorkspaceRegistry | undefined = defaultWorkspaceRegistry) {
  const values = new Map<string, RegisteredTool>()
  const disposers: Array<() => void | Promise<void>> = []
  const ctx = {
    inject(_dependencies: readonly string[], callback: (injected: unknown) => void) {
      callback(Object.assign(Object.create(ctx), workspaceRegistry === undefined ? {} : { workspaceRegistry }))
      return { async dispose() {} }
    },
    tools: {
      register(tool: RegisteredTool) {
        values.set(tool.name, tool)
        return () => { values.delete(tool.name) }
      },
    },
    get(name: string) {
      return name === 'workspaceRegistry' ? workspaceRegistry : undefined
    },
    effect(effect: () => () => void | Promise<void>) {
      const dispose = effect()
      disposers.push(dispose)
      return dispose
    },
  }
  return {
    values,
    disposers,
    ctx,
  }
}

function toolRegistry(values: Map<string, RegisteredTool>) {
  return {
    register(tool: RegisteredTool) {
      values.set(tool.name, tool)
      return () => { values.delete(tool.name) }
    },
  }
}

const provideWorkspaceRegistry = (ctx: Context, registry: WorkspaceRegistry) => {
  ctx.provide('workspaceRegistry', registry as never)
}

async function pinnedModule(packageName: string): Promise<Record<string, any>> {
  return import(`@deepseek-ai/${packageName}`)
}

function memoryBackend() {
  const units = new Map<string, {
    readonly tables: Map<string, Map<string, unknown>>
    global: unknown
  }>()
  return {
    kv: {
      async open(descriptor: { readonly name: string; readonly tables: readonly string[] }) {
        let state = units.get(descriptor.name)
        if (state === undefined) {
          state = { tables: new Map(descriptor.tables.map(table => [table, new Map()])), global: null }
          units.set(descriptor.name, state)
        }
        return {
          async loadAll() {
            return {
              tables: Object.fromEntries([...state!.tables].map(([name, records]) => [name, Object.fromEntries(records)])),
              global: state!.global,
            }
          },
          async putRecord(table: string, key: string, value: unknown) { state!.tables.get(table)!.set(key, value) },
          async deleteRecord(table: string, key: string) { state!.tables.get(table)!.delete(key) },
          async setGlobal(value: unknown) { state!.global = value },
          async close() {},
        }
      },
    },
    async close() {},
  }
}

async function realWorkspaceRegistryContext() {
  const storageModule = await pinnedModule('dsh-storage')
  const domainModule = await pinnedModule('dsh-storage-domain')
  const workspaceModule = await pinnedModule('dsh-workspace')
  const ctx = new Context()
  ctx.provide('typert', { lookups: { register() { return () => undefined } } } as never)
  ctx.provide('systemPrompt', {
    tools() { return () => undefined },
    section() { return () => undefined },
  } as never)
  const sessionStore = await ctx.plugin(SessionStore)
  const toolsFiber = await ctx.plugin(ToolRuntime)
  const storageFiber = await ctx.plugin(storageModule.Storage as never)
  const backend = memoryBackend()
  ctx.storage.backend.register('memory', backend as never)
  ctx.provide('storage.backend.memory', backend as never)
  const domainFiber = await ctx.plugin({
    name: domainModule.name,
    inject: [...domainModule.inject, 'storage.backend.memory'],
    Config: domainModule.Config,
    apply: domainModule.apply,
  } as never, { backend: 'memory' })
  ctx.provide('sessionPersistence', { async list() { return [] } } as never)
  const workspaceFiber = await ctx.plugin(workspaceModule.WorkspaceRegistry as never)
  return {
    ctx,
    registry: ctx.get('workspaceRegistry') as {
      create(path: string, title?: string): Promise<{ readonly path: string }>
      resolveByPath(path: string): Promise<{ readonly path: string } | undefined>
    },
    sessionStore,
    toolsFiber,
    storageFiber,
    domainFiber,
    workspaceFiber,
  }
}

describe('loadable code intelligence bundle', () => {
  it('uses the pinned WorkspaceRegistry for two live SessionStore sessions and releases one on disposal', async () => {
    const first = await mkdtemp(join(tmpdir(), 'dsh-real-registry-first-'))
    const second = await mkdtemp(join(tmpdir(), 'dsh-real-registry-second-'))
    roots.push(first, second)
    await writeFile(join(first, 'first.ts'), 'export const firstWorkspace = true\n')
    await writeFile(join(second, 'second.ts'), 'export const secondWorkspace = true\n')
    const mounted = await realWorkspaceRegistryContext()
    let codeFiber: { dispose(): Promise<void> } | undefined
    let firstDetach: (() => void) | undefined
    let secondDetach: (() => void) | undefined
    try {
      await mounted.registry.create(first, 'first')
      codeFiber = await mounted.ctx.plugin(apply, config('.'))
      const firstSession = mounted.ctx.sessions.prepare(SessionId('real-registry-first'), { meta: { cwd: first } })
      firstDetach = mounted.ctx.sessions.enter(firstSession)
      mounted.ctx.sessions.announce(firstSession)
      const secondSession = mounted.ctx.sessions.prepare(SessionId('real-registry-second'), { meta: { cwd: second } })
      secondDetach = mounted.ctx.sessions.enter(secondSession)
      mounted.ctx.sessions.announce(secondSession)
      const firstResult = await mounted.ctx.tools.execute({
        callId: 'real-registry-first-map',
        name: 'code_repo_map',
        arguments: { limit: 10 },
        signal: new AbortController().signal,
        agent: { session: firstSession },
      } as never)
      const secondResult = await mounted.ctx.tools.execute({
        callId: 'real-registry-second-map',
        name: 'code_repo_map',
        arguments: { limit: 10 },
        signal: new AbortController().signal,
        agent: { session: secondSession },
      } as never)
      expect(firstResult).toMatchObject({
        isError: false,
        value: { items: expect.arrayContaining([expect.objectContaining({ path: 'first.ts' })]) },
      })
      expect(secondResult).toMatchObject({ isError: true })
      expect(secondResult.error.message).toMatch(/workspace.*not registered|unregistered.*workspace/i)

      const compilerService = mounted.ctx.get('contextCompiler') as {
        forSession(session: object): Promise<{ repoMap(request: { snapshotId: string; limit: number }, signal: AbortSignal): Promise<unknown> }>
      }
      const firstCompiler = await compilerService.forSession(firstSession)
      await firstDetach()
      firstDetach = undefined
      await expect(firstCompiler.repoMap(
        { snapshotId: firstResult.value.snapshotId, limit: 10 },
        new AbortController().signal,
      )).rejects.toThrow(/disposed/i)
    } finally {
      firstDetach?.()
      secondDetach?.()
      await codeFiber?.dispose()
      await mounted.workspaceFiber.dispose()
      await mounted.domainFiber.dispose()
      await mounted.storageFiber.dispose()
      await mounted.toolsFiber.dispose()
      await mounted.sessionStore.dispose()
    }
  })

  it('exports its patch as an installable DSH bundle', async () => {
    const packageRoot = new URL('../', import.meta.url)
    const manifest = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(await readFile(new URL(manifest.dsh!.bundle!.patch!, packageRoot), 'utf8')).toBe(
      "- insert:\n    - id: dsh-code-intelligence\n      name: '@ds-plugins/dsh-code-intelligence'\n",
    )
  })

  it('registers read-only tools and removes them through its owned effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-loader-'))
    roots.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'main.ts'), 'export function main() { return true }\n')
    const mounted = pluginContext()
    await apply(mounted.ctx as never, config(root))
    expect([...mounted.values.keys()]).toEqual(['code_repo_map', 'code_symbol_query'])
    for (const dispose of [...mounted.disposers].reverse()) await dispose()
    expect([...mounted.values.keys()]).toEqual([])
  })

  it('rejects malformed configuration when the first call resolves its session runtime', async () => {
    const ctx = new Context()
    const values = new Map<string, RegisteredTool>()
    ctx.provide('tools', toolRegistry(values) as never)
    let fiber: { dispose(): Promise<void> } | undefined
    try {
      fiber = ctx.plugin(apply, { ...config('.'), maxFiles: 0 })
      await fiber
      throw new Error('invalid configuration unexpectedly activated')
    } catch (error) {
      expect((error as Error).message).toMatch(/maxFiles.*between|invalid config/i)
    } finally {
      await fiber?.dispose()
    }
  })

  it('waits for workspaceRegistry before completing initial activation', async () => {
    const ctx = new Context()
    const values = new Map<string, RegisteredTool>()
    ctx.provide('tools', toolRegistry(values) as never)
    const fiber = ctx.plugin(apply, config('.'))
    let settled = false
    const startup = Promise.resolve(fiber).then(() => { settled = true })
    await new Promise<void>(resolveImmediate => { setImmediate(resolveImmediate) })
    expect(settled).toBe(false)
    expect([...values.keys()]).toEqual([])

    const registry = await ctx.plugin(provideWorkspaceRegistry, defaultWorkspaceRegistry)
    try {
      await startup
      expect([...values.keys()]).toEqual([
        'code_repo_map',
        'code_symbol_query',
        'context_repo_map',
        'context_symbol_query',
        'context_expand_source',
      ])
    } finally {
      await fiber.dispose()
      await registry.dispose()
    }
  })

  it('keeps the resolver bound to the registry observed at plugin activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-registry-hmr-'))
    roots.push(root)
    await writeFile(join(root, 'registered.ts'), 'export const registered = true\n')
    const ctx = new Context()
    const values = new Map<string, RegisteredTool>()
    ctx.provide('tools', toolRegistry(values) as never)
    const firstRegistry = await ctx.plugin(provideWorkspaceRegistry, {
      async resolveByPath(path: string) { return { path } },
    })
    const fiber = await ctx.plugin(apply, config('.'))
    try {
      await expect.poll(() => values.has('code_repo_map')).toBe(true)
      const firstTool = values.get('code_repo_map')!
      await expect(firstTool.execute({ limit: 10 }, execution(root))).resolves.toMatchObject({
        items: expect.arrayContaining([expect.objectContaining({ path: 'registered.ts' })]),
      })

      await firstRegistry.dispose()
      const replacement = await ctx.plugin(provideWorkspaceRegistry, {
        async resolveByPath() { return undefined },
      })
      try {
        await expect.poll(() => values.get('code_repo_map') !== firstTool).toBe(true)
        await expect(values.get('code_repo_map')!.execute({ limit: 10 }, execution(root)))
          .rejects.toThrow(/workspace.*not registered|unregistered.*workspace/i)
      } finally {
        await replacement.dispose()
      }
    } finally {
      await fiber.dispose()
    }
  })

  it('isolates snapshots by the calling session project directory', async () => {
    const first = await mkdtemp(join(tmpdir(), 'dsh-session-first-'))
    const second = await mkdtemp(join(tmpdir(), 'dsh-session-second-'))
    roots.push(first, second)
    await mkdir(join(first, 'src'), { recursive: true })
    await mkdir(join(second, 'src'), { recursive: true })
    await writeFile(join(first, 'src', 'first.ts'), 'export const first = true\n')
    await writeFile(join(second, 'src', 'second.ts'), 'export const second = true\n')
    const mounted = pluginContext()
    await apply(mounted.ctx as never, config('.'))
    const repoMap = mounted.values.get('code_repo_map')!

    const firstResult = await repoMap.execute({ limit: 10 }, execution(first))
    const secondResult = await repoMap.execute({ limit: 10 }, execution(second))

    expect(firstResult.snapshotId).not.toBe(secondResult.snapshotId)
    expect(firstResult.items?.map(item => item.path)).toContain('src/first.ts')
    expect(firstResult.items?.map(item => item.path)).not.toContain('src/second.ts')
    expect(secondResult.items?.map(item => item.path)).toContain('src/second.ts')
    expect(secondResult.items?.map(item => item.path)).not.toContain('src/first.ts')
    await mounted.disposers[0]!()
  })

  it('keeps context tools and the compiler service bound to the calling session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-context-'))
    roots.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'context.ts'), 'export const context = true\n')
    const mounted = pluginContext()
    const services = new Map<string, unknown>()
    Object.assign(mounted.ctx, {
      provide(name: string, value: unknown) {
        services.set(name, value)
        return () => { services.delete(name) }
      },
    })
    await apply(mounted.ctx as never, config('.'))

    expect([...mounted.values.keys()]).toEqual([
      'code_repo_map',
      'code_symbol_query',
      'context_repo_map',
      'context_symbol_query',
      'context_expand_source',
    ])
    expect(services.has('contextCompiler')).toBe(true)
    const exec = execution(root)
    const map = await mounted.values.get('code_repo_map')!.execute({ limit: 10 }, exec)
    const block = await mounted.values.get('context_repo_map')!.execute(
      { snapshotId: map.snapshotId, limit: 10 },
      exec,
    ) as unknown as { readonly snapshotId: string; readonly workspaceFingerprint: string }
    expect(block.snapshotId).toBe(map.snapshotId)
    expect(block.workspaceFingerprint).toBe(sha256Utf8(root))
    await mounted.disposers[0]!()
  })

  it('preserves synchronous cache statistics for direct compiler consumers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-default-context-'))
    roots.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'default.ts'), 'export const defaultValue = true\n')
    const mounted = pluginContext()
    let service: {
      readonly cacheStats: { readonly hits: number; readonly misses: number }
      symbolQuery(
        request: { snapshotId: string; query: string; limit: number },
        signal: AbortSignal,
      ): Promise<unknown>
    } | undefined
    Object.assign(mounted.ctx, {
      provide(name: string, value: unknown) {
        if (name === 'contextCompiler') service = value as typeof service
        return () => { service = undefined }
      },
    })
    await apply(mounted.ctx as never, config(root))
    if (service === undefined) throw new Error('contextCompiler was not provided')
    expect(service.cacheStats).toEqual({ hits: 0, misses: 0 })
    const map = await mounted.values.get('code_repo_map')!.execute({ limit: 10 }, execution(root))

    await service.symbolQuery(
      { snapshotId: map.snapshotId, query: 'defaultValue', limit: 10 },
      new AbortController().signal,
    )

    expect(service.cacheStats).toEqual({ hits: 0, misses: 1 })
    await mounted.disposers[0]!()
  })

  it('canonicalizes the session workspace and rejects deployment roots outside it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-session-canonical-'))
    const workspace = join(parent, 'workspace')
    const alias = join(parent, 'workspace-link')
    roots.push(parent)
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'src', 'canonical.ts'), 'export const canonical = true\n')
    await symlink(workspace, alias, 'dir')
    const mounted = pluginContext()
    await apply(mounted.ctx as never, config('.'))
    const result = await mounted.values.get('code_repo_map')!.execute({ limit: 10 }, execution(alias))
    expect(result.items?.map(item => item.path)).toContain('src/canonical.ts')
    await mounted.disposers[0]!()

    const escaped = pluginContext()
    await apply(escaped.ctx as never, config('..'))
    await expect(escaped.values.get('code_repo_map')!.execute({ limit: 10 }, execution(workspace)))
      .rejects.toThrow(/inside.*workspace|outside.*workspace|escape|traversal/i)
    await escaped.disposers[0]!()
  })

  it('fails clearly when the tool call has no valid session workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-invalid-'))
    roots.push(root)
    const file = join(root, 'not-a-directory.ts')
    const missing = join(root, 'missing')
    await writeFile(file, 'export const value = true\n')
    const mounted = pluginContext()
    await apply(mounted.ctx as never, config('.'))
    const repoMap = mounted.values.get('code_repo_map')!

    await expect(repoMap.execute({ limit: 10 }, execution())).rejects.toThrow(/session.*workspace|workspace.*session/i)
    await expect(repoMap.execute({ limit: 10 }, execution(missing))).rejects.toThrow(/workspace.*exist|existing.*workspace|ENOENT/i)
    await expect(repoMap.execute({ limit: 10 }, execution(file))).rejects.toThrow(/workspace.*directory|directory.*workspace/i)
    await mounted.disposers[0]!()
  })

  it('rejects a session directory that the available workspace service does not own', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-unregistered-'))
    roots.push(root)
    await writeFile(join(root, 'unregistered.ts'), 'export const unregistered = true\n')
    const mounted = pluginContext({
      async resolveByPath() { return undefined },
    })
    await apply(mounted.ctx as never, config('.'))

    await expect(mounted.values.get('code_repo_map')!.execute({ limit: 10 }, execution(root)))
      .rejects.toThrow(/workspace.*not registered|unregistered.*workspace/i)
    await mounted.disposers[0]!()
  })

  it('closes the session compiler when Harness disposes its owning Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-disposal-'))
    roots.push(root)
    await writeFile(join(root, 'disposal.ts'), 'export const disposal = true\n')
    const mounted = pluginContext()
    let disposedListener: ((session: object) => void | Promise<void>) | undefined
    let listenerDisposed = false
    let service: {
      forSession(session: object): Promise<{
        repoMap(
          request: { snapshotId: string; limit: number },
          signal: AbortSignal,
        ): Promise<unknown>
      }>
    } | undefined
    Object.assign(mounted.ctx, {
      provide(name: string, value: unknown) {
        if (name === 'contextCompiler') service = value as typeof service
        return () => { service = undefined }
      },
      on(name: string, listener: (session: object) => void | Promise<void>) {
        if (name === 'session/disposed') disposedListener = listener
        return () => { listenerDisposed = true }
      },
    })
    await apply(mounted.ctx as never, config('.'))
    if (service === undefined) throw new Error('contextCompiler was not provided')
    if (disposedListener === undefined) throw new Error('session/disposed listener was not registered')
    const exec = execution(root)
    const map = await mounted.values.get('code_repo_map')!.execute({ limit: 10 }, exec)
    const compiler = await service.forSession(exec.agent!.session)
    await compiler.repoMap({ snapshotId: map.snapshotId, limit: 10 }, exec.signal)

    await disposedListener(exec.agent!.session)

    await expect(compiler.repoMap({ snapshotId: map.snapshotId, limit: 10 }, exec.signal)).rejects.toThrow(/disposed/i)
    await mounted.disposers[0]!()
    expect(listenerDisposed).toBe(true)
  })
})

import type { Context } from '@deepseek-ai/cordis'
import { createCodeIntelligenceTools, createContextTools } from './tools.js'
import type { SessionRuntimeResolver, WorkspaceRegistry } from './session-runtime.js'
import { ConfigP0Schema as Config, createResolverP0, type ConfigP0 } from './p0-runtime.js'
import { createToolsP0 } from './p0-tools.js'
import { registerCodeIntelligenceToolsP0 } from './p0-tool-errors.js'
import type { RepositorySnapshotStore } from './snapshot.js'
import type { InternalSymbolIndexStore } from './symbol-index.js'
import type { ContextCompiler, ContextCompilerStats } from './types.js'

export type CodeIntelligenceRuntimeOptions = {
  readonly snapshot: RepositorySnapshotStore['snapshot']
  readonly index: InternalSymbolIndexStore
  readonly compiler?: ContextCompiler
}

type SessionCodeIntelligenceRuntimeOptions = {
  readonly resolver: SessionRuntimeResolver
}

function createSessionContextCompiler(resolver: SessionRuntimeResolver): ContextCompiler {
  type CompilerWithStats = ContextCompiler & {
    readonly cacheStats: ContextCompilerStats
    readonly stats: ContextCompilerStats
  }
  const emptyStats = Object.freeze({ hits: 0, misses: 0 })
  let fallback: CompilerWithStats | undefined
  async function defaultCompiler(): Promise<CompilerWithStats> {
    fallback ??= (await resolver.resolveDefault()).compiler as CompilerWithStats
    return fallback
  }
  return Object.freeze({
    get cacheStats() {
      return fallback?.cacheStats ?? emptyStats
    },
    get stats() {
      return fallback?.stats ?? emptyStats
    },
    async repoMap(request, signal, sessionKey) {
      return (await defaultCompiler()).repoMap(request, signal, sessionKey)
    },
    async symbolQuery(request, signal, sessionKey) {
      return (await defaultCompiler()).symbolQuery(request, signal, sessionKey)
    },
    async expandSource(request, signal, sessionKey) {
      return (await defaultCompiler()).expandSource(request, signal, sessionKey)
    },
    async forSession(session) {
      return (await resolver.resolveSession(
        session as Parameters<SessionRuntimeResolver['resolveSession']>[0],
      )).compiler
    },
  })
}

export type CodeIntelligenceConfig = Partial<ConfigP0> & Pick<ConfigP0, 'deploymentRoot' | 'revision'>

const WORKSPACE_REGISTRY_STARTUP_TIMEOUT_MS = 5_000

type CodeIntelligenceContext = Pick<Context, 'effect' | 'on'> & {
  readonly tools: { register(tool: unknown): () => void }
  readonly provide?: (name: string, value: unknown) => () => void
}

export function mountCodeIntelligence(ctx: CodeIntelligenceContext, options: CodeIntelligenceRuntimeOptions | SessionCodeIntelligenceRuntimeOptions): void {
  const dynamic = 'resolver' in options
  const runtime = dynamic ? options.resolver.resolve.bind(options.resolver) : { snapshot: options.snapshot, index: options.index }
  const compiler = dynamic ? createSessionContextCompiler(options.resolver) : options.compiler
  ctx.effect(() => {
    const contextEnabled = compiler !== undefined && typeof ctx.provide === 'function'
    const serviceDisposer = contextEnabled ? ctx.provide!('contextCompiler', compiler) : undefined
    const tools = [
      ...createCodeIntelligenceTools(runtime),
      ...(contextEnabled ? createContextTools(compiler) : []),
    ]
    const disposers = tools.map(tool => ctx.tools.register(tool))
    const disposeSessions = dynamic && typeof ctx.on === 'function'
      ? ctx.on('session/disposed', session => {
          void options.resolver.release(session)
        })
      : undefined
    return async () => {
      disposeSessions?.()
      for (const dispose of disposers.reverse()) dispose()
      serviceDisposer?.()
      if (dynamic) await options.resolver.dispose()
      else {
        const disposable = compiler as (ContextCompiler & { dispose?: () => Promise<void> }) | undefined
        await disposable?.dispose?.()
      }
    }
  }, 'dsh-code-intelligence: read-only tools')
}

export const name = 'dsh-code-intelligence'
export const inject = ['tools']
export const provide: string[] = []

export const apply = async (
  ctx: CodeIntelligenceContext & {
    readonly inject?: Context['inject']
  },
  config: CodeIntelligenceConfig,
): Promise<void> => {
  if (typeof ctx.inject !== 'function') throw new TypeError('P0 default plugin requires Cordis and a registered Session workspace; use V1 programmatic APIs explicitly for old consumers.')
  await new Promise<void>((resolve, reject) => {
    let state: 'starting' | 'active' | 'failed' | 'disposed' = 'starting'
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finishStartup = () => {
      if (state !== 'starting') return
      state = 'active'
      if (timeout !== undefined) clearTimeout(timeout)
      resolve()
    }
    const failStartup = (error: unknown) => {
      if (state !== 'starting') return
      state = 'failed'
      if (timeout !== undefined) clearTimeout(timeout)
      reject(error)
    }
    const injection = ctx.inject!(['workspaceRegistry'], injected => {
      if (state === 'failed' || state === 'disposed') return
      try {
        const workspaceContext = injected as unknown as typeof ctx
        const workspaceRegistry = (injected as unknown as { readonly workspaceRegistry: WorkspaceRegistry }).workspaceRegistry
        const resolver = createResolverP0(config, workspaceRegistry)
        registerCodeIntelligenceToolsP0(workspaceContext as Context, createToolsP0(resolver))
        workspaceContext.on('session/disposed', session => resolver.release(session))
        workspaceContext.effect(() => () => resolver.dispose(), 'dsh-code-intelligence: P0 Session holder')
        finishStartup()
      } catch (error) {
        failStartup(error)
        throw error
      }
    })
    let injectionDisposal: Promise<void> | undefined
    const disposeInjection = () => injectionDisposal ??= injection.dispose()
    timeout = setTimeout(() => {
      if (state !== 'starting') return
      failStartup(new TypeError('code intelligence workspaceRegistry startup timeout'))
      void disposeInjection()
    }, WORKSPACE_REGISTRY_STARTUP_TIMEOUT_MS)
    if (state !== 'starting') clearTimeout(timeout)
    ctx.effect(() => async () => {
      if (state === 'starting') {
        state = 'disposed'
        if (timeout !== undefined) clearTimeout(timeout)
        resolve()
      } else {
        state = 'disposed'
      }
      await disposeInjection()
    }, 'dsh-code-intelligence: workspace registry startup')
  })
}

apply.Config = Config
apply.inject = inject
apply.provide = provide

import { realpath, stat } from 'node:fs/promises'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ContextCacheStore } from '@han_05/dsh-context-cache'
import { parseSnapshotConfig } from './config.js'
import { createContextCompiler } from './context-compiler.js'
import { extractFallbackSymbols } from './fallback.js'
import { RepositorySnapshotStore } from './snapshot.js'
import { buildSymbolIndex } from './symbol-index.js'
import type { ContextCompiler, SnapshotConfigV1 } from './types.js'
import type { ToolRuntime } from './tools.js'

export type WorkspaceRegistry = {
  resolveByPath(path: string): Promise<{ readonly path: string } | undefined>
}

export type SessionCodeIntelligenceRuntime = ToolRuntime & {
  readonly compiler: ContextCompiler
}

export type SessionRuntimeResolver = {
  /** Resolve the immutable runtime owned by the tool call's live Session. */
  resolve(exec: Pick<ToolRunContext, 'agent'>): Promise<SessionCodeIntelligenceRuntime>
  /** Resolve the immutable runtime owned by an explicitly supplied live Session. */
  resolveSession(session: Session | undefined): Promise<SessionCodeIntelligenceRuntime>
  /** Resolve the configured absolute root for non-session evaluation consumers. */
  resolveDefault(): Promise<SessionCodeIntelligenceRuntime>
  /** Close and forget one Session runtime. */
  release(session: Session): Promise<void>
  /** Close every retained runtime. */
  dispose(): Promise<void>
}

/** Build one immutable runtime for a fully resolved absolute deployment root. */
export async function createCodeIntelligenceRuntime(
  config: SnapshotConfigV1,
): Promise<SessionCodeIntelligenceRuntime> {
  const parsed = parseSnapshotConfig(config)
  const cacheConfig = config.cache
  const cache = cacheConfig?.enabled === true ? await ContextCacheStore.open({ deploymentRoot: parsed.deploymentRoot, maxEntries: cacheConfig.maxEntries, maxBytes: cacheConfig.maxBytes, lockTimeoutMs: cacheConfig.lockTimeoutMs }) : undefined
  try {
    const store = await RepositorySnapshotStore.create(parsed)
    const adapter = await extractFallbackSymbols(store)
    const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
    const compiler = createContextCompiler({ workspaceRoot: parsed.deploymentRoot, store, index, cache })
    return Object.freeze({ snapshot: store.snapshot, index, compiler })
  } catch (error) {
    await cache?.close()
    throw error
  }
}

async function canonicalWorkspace(cwd: string): Promise<string> {
  let canonical: string
  try {
    canonical = await realpath(cwd)
  } catch (error) {
    throw new Error(`code intelligence session workspace does not exist or cannot be resolved: ${cwd}`, { cause: error })
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`code intelligence session workspace must be a directory: ${cwd}`)
  }
  return canonical
}

/**
 * Build and retain one immutable code-intelligence runtime per live Session.
 * @param config - Snapshot policy whose deployment root is resolved beneath each Session workspace.
 * @param workspaceRegistry - Harness workspace service used to reject unregistered Session directories.
 * @returns A resolver whose runtimes remain immutable until release or disposal.
 */
export function createSessionRuntimeResolver(
  config: SnapshotConfigV1,
  workspaceRegistry: WorkspaceRegistry,
): SessionRuntimeResolver {
  const sessions = new WeakMap<Session, Promise<SessionCodeIntelligenceRuntime>>()
  const retained = new Set<Promise<SessionCodeIntelligenceRuntime>>()
  const closing = new Map<Promise<SessionCodeIntelligenceRuntime>, Promise<void>>()
  const closed = new WeakSet<Promise<SessionCodeIntelligenceRuntime>>()
  let defaultRuntime: Promise<SessionCodeIntelligenceRuntime> | undefined
  let disposed = false
  let disposal: Promise<void> | undefined

  async function createForSession(session: Session): Promise<SessionCodeIntelligenceRuntime> {
    const cwd = session.header.cwd
    if (cwd === undefined) throw new Error('code intelligence requires the current session workspace')
    const canonical = await canonicalWorkspace(cwd)
    const workspace = await workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error(`code intelligence session workspace is not registered: ${cwd}`)
    if (await canonicalWorkspace(workspace.path) !== canonical) {
      throw new Error('code intelligence session workspace does not match the registered workspace')
    }
    return createCodeIntelligenceRuntime({ ...config, workspaceRoot: canonical })
  }

  function retain(session: Session): Promise<SessionCodeIntelligenceRuntime> {
    const existing = sessions.get(session)
    if (existing !== undefined) return existing
    const pending = createForSession(session)
    sessions.set(session, pending)
    retained.add(pending)
    void pending.catch(() => {
      if (sessions.get(session) === pending) sessions.delete(session)
      retained.delete(pending)
    })
    return pending
  }

  function close(pending: Promise<SessionCodeIntelligenceRuntime>): Promise<void> {
    if (closed.has(pending)) return Promise.resolve()
    const active = closing.get(pending)
    if (active !== undefined) return active
    const task = (async () => {
      let runtime: SessionCodeIntelligenceRuntime
      try {
        runtime = await pending
      } catch {
        // Failed construction owns and closes its cache before rejecting.
        return
      }
      const disposable = runtime.compiler as ContextCompiler & { dispose?: () => Promise<void> }
      await disposable.dispose?.()
    })()
    closing.set(pending, task)
    void task.then(
      () => {
        retained.delete(pending)
        closing.delete(pending)
        closed.add(pending)
      },
      () => undefined,
    )
    return task
  }

  return {
    async resolve(exec) {
      if (disposed) throw new Error('code intelligence session resolver is disposed')
      const session = exec.agent?.session
      if (session === undefined) throw new Error('code intelligence requires the current session workspace')
      return retain(session)
    },
    async resolveSession(session) {
      if (disposed) throw new Error('code intelligence session resolver is disposed')
      if (session === undefined) throw new Error('code intelligence requires the current session workspace')
      return retain(session)
    },
    async resolveDefault() {
      if (disposed) throw new Error('code intelligence session resolver is disposed')
      defaultRuntime ??= createCodeIntelligenceRuntime(config)
      retained.add(defaultRuntime)
      return defaultRuntime
    },
    release(session) {
      const pending = sessions.get(session)
      if (pending === undefined) return Promise.resolve()
      sessions.delete(session)
      return close(pending)
    },
    dispose() {
      disposal ??= (async () => {
        disposed = true
        await Promise.all([...retained].map(close))
      })()
      return disposal
    },
  }
}

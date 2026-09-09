import { realpath, stat } from 'node:fs/promises'
import { ContextCacheStore } from '@han_05/dsh-context-cache'
import type { ContextCacheStoreApiV1 } from '@han_05/dsh-context-cache'
import { isAbsolute } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { parseCanonicalRepoPathP0, SNAPSHOT_POLICY_P0, OUTPUT_POLICY_P0, type FailureDetailsP0, type RefreshSnapshotResultP0 } from '@han_05/dsh-context'
import { buildIndexP0, P0BuildError } from './p0-build.js'
import { parseSnapshotConfigP0 } from './p0-snapshot.js'
import { createVerifiedReaderP0, checkBuildControlP0, P0ReadError } from './p0-reader.js'
import { failureP0, refreshResultP0 } from './p0-query.js'
import { SourceBudgetP0 } from './p0-source.js'
import type { BuiltIndexP0, SnapshotConfigP0, VerifiedReaderP0 } from './p0-types.js'
import type { WorkspaceRegistry } from './session-runtime.js'

export type CacheConfigP0 = {
  readonly enabled: boolean
  readonly maxEntries: number
  readonly maxBytes: number
  readonly lockTimeoutMs: number
}
export type ConfigP0 = Omit<SnapshotConfigP0, 'workspaceRoot'> & {
  readonly workspaceRoot?: string
  readonly sessionSourceBytes: number | null
  readonly initializationTimeoutMs: number
  readonly cache: CacheConfigP0
}
/** Loader-stage syntax/limits only: Session workspace resolution happens at first use. */
export function parseConfigP0(raw: unknown): ConfigP0 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Expected configuration object')
  const input = raw as Record<string, unknown>
  const limits = ['maxFileBytes', 'maxFiles', 'maxTotalBytes', 'maxDirectories', 'maxScanEntries', 'maxIgnoreBytes', 'maxIgnorePatterns'] as const
  const keys = ['workspaceRoot', 'deploymentRoot', 'revision', 'nestedCheckoutRoots', 'sessionSourceBytes', 'initializationTimeoutMs', 'cache', ...limits]
  if (Reflect.ownKeys(input).some(k => typeof k !== 'string' || !keys.includes(k))) throw new TypeError('Unknown P0 configuration field')
  for (const k of ['deploymentRoot', 'revision']) if (typeof input[k] !== 'string' || !input[k].trim() || input[k].includes('\0')) throw new TypeError(`Invalid ${k}`)
  const deploymentRoot = input.deploymentRoot as string
  if (!isAbsolute(deploymentRoot) && deploymentRoot !== '.') parseCanonicalRepoPathP0(deploymentRoot)
  if (input.workspaceRoot !== undefined && (typeof input.workspaceRoot !== 'string' || !isAbsolute(input.workspaceRoot) || input.workspaceRoot.includes('\0'))) throw new TypeError('workspaceRoot must be absolute')
  const values = {} as Record<typeof limits[number], number>
  for (const k of limits) {
    const v = input[k] === undefined ? SNAPSHOT_POLICY_P0[k] : input[k]
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > SNAPSHOT_POLICY_P0[k]) throw new TypeError(`Invalid ${k}`)
    values[k] = v
  }
  const roots = input.nestedCheckoutRoots === undefined ? [] : input.nestedCheckoutRoots
  if (!Array.isArray(roots) || roots.length > values.maxDirectories) throw new TypeError('Invalid nestedCheckoutRoots')
  const nestedCheckoutRoots = roots.map(parseCanonicalRepoPathP0)
  if (new Set(nestedCheckoutRoots).size !== nestedCheckoutRoots.length) throw new TypeError('Duplicate nestedCheckoutRoots')
  const sessionSourceBytes = input.sessionSourceBytes === undefined ? OUTPUT_POLICY_P0.defaultSessionSourceBytes : input.sessionSourceBytes
  if (sessionSourceBytes !== null && (typeof sessionSourceBytes !== 'number' || !Number.isSafeInteger(sessionSourceBytes) || sessionSourceBytes < 0)) throw new TypeError('Invalid sessionSourceBytes')
  const initializationTimeoutMs = input.initializationTimeoutMs === undefined ? 60_000 : input.initializationTimeoutMs
  if (typeof initializationTimeoutMs !== 'number' || !Number.isSafeInteger(initializationTimeoutMs) || initializationTimeoutMs < 1 || initializationTimeoutMs > 300_000) throw new TypeError('Invalid initializationTimeoutMs')
  const rawCache = input.cache === undefined ? {} : input.cache
  if (!rawCache || typeof rawCache !== 'object' || Array.isArray(rawCache)) throw new TypeError('Invalid cache')
  const cacheInput = rawCache as Record<string, unknown>
  if (Object.keys(cacheInput).some(key => !['enabled', 'maxEntries', 'maxBytes', 'lockTimeoutMs'].includes(key))) throw new TypeError('Invalid cache')
  const enabled: unknown = cacheInput.enabled === undefined ? false : cacheInput.enabled
  const maxEntries: unknown = cacheInput.maxEntries === undefined ? 10_000 : cacheInput.maxEntries
  const maxBytes: unknown = cacheInput.maxBytes === undefined ? 268_435_456 : cacheInput.maxBytes
  const lockTimeoutMs: unknown = cacheInput.lockTimeoutMs === undefined ? 250 : cacheInput.lockTimeoutMs
  if (typeof enabled !== 'boolean' || typeof maxEntries !== 'number' || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000 || typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 268_435_456 || typeof lockTimeoutMs !== 'number' || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) throw new TypeError('Invalid cache')
  const cache: CacheConfigP0 = { enabled: enabled as boolean, maxEntries: maxEntries as number, maxBytes: maxBytes as number, lockTimeoutMs: lockTimeoutMs as number }
  return Object.freeze({ deploymentRoot, revision: input.revision as string, ...values, nestedCheckoutRoots: Object.freeze(nestedCheckoutRoots), sessionSourceBytes, initializationTimeoutMs, cache: Object.freeze(cache),
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot as string }) })
}
export const ConfigP0Schema = { '~standard': { version: 1 as const, vendor: '@han_05/dsh-code-intelligence', validate(raw: unknown) {
  try { return { value: parseConfigP0(raw) } } catch (error) { return { issues: [{ message: error instanceof Error ? error.message : 'Invalid configuration' }] } }
} } }

export function translateP0(error: unknown, phase: 'initialization' | 'refresh' = 'refresh'): never {
  if (error instanceof P0ReadError || error instanceof P0BuildError) {
    return failureP0(error.code, error.code === 'stale-source'
      ? 'Source changed or disappeared; refresh the Session and reacquire its receipt.'
      : error.code === 'access-denied' ? 'Workspace path access denied.' : 'Could not build a trusted index.',
    { ...error.details, ...(error.code === 'refresh-failed' ? { phase } : {}) } as FailureDetailsP0)
  }
  throw error
}
export type RuntimeP0 = { readonly index: BuiltIndexP0; readonly reader: VerifiedReaderP0; readonly config: SnapshotConfigP0; readonly cache?: ContextCacheStoreApiV1 }
export type RuntimeEventP0 = Readonly<{
  kind: 'build-started' | 'build-retried' | 'build-succeeded' | 'build-failed' | 'refresh-queued' | 'refresh-started' | 'operation-failed' | 'runtime-committed' | 'runtime-retired' | 'runtime-released' | 'session-closing' | 'session-closed'
  operationId?: number; phase?: 'initialization' | 'refresh'; sessionId?: string; queueDepth?: number; durationMs?: number; queueDurationMs?: number; reason?: string
  previousSnapshotId?: string; snapshotId?: string; indexFingerprint?: string; scanCoverage?: BuiltIndexP0['scanCoverage']
  extraction?: Readonly<{ completeFileCount: number; partialFileCount: number; failedFileCount: number; unsupportedFileCount: number }>
}>
/** Optional integration/test seams. Observer/sink failures never alter runtime behavior;
 * beforeCommit is an awaited deterministic test barrier. */
export type ResolverHooksP0 = Readonly<{
  buildIndex?: typeof buildIndexP0
  beforeCommit?: (phase: 'initialization' | 'refresh', candidate: RuntimeP0) => Promise<void>
  onRuntimeRetired?: (runtime: RuntimeP0) => void
  onRuntimeReleased?: (runtime: RuntimeP0) => void
  eventSink?: (event: RuntimeEventP0) => void
}>
type Lifecycle = 'idle' | 'initializing' | 'active' | 'closing' | 'closed'
type Lease = { readonly runtime: RuntimeP0; readonly done: Promise<void>; finish(): void }
type SessionState = {
  readonly controller: AbortController; readonly budget: SourceBudgetP0; readonly calls: Set<Lease>
  status: Lifecycle; runtime?: RuntimeP0; initial?: Promise<RuntimeP0>; initialWaitSignal?: AbortSignal; refreshTail: Promise<void>; closing?: Promise<void>
  readonly retired: Set<RuntimeP0>; readonly sessionId?: string; refreshQueueDepth: number; nextOperationId: number
}
export type SessionHandleP0 = { readonly runtime: RuntimeP0; readonly budget: SourceBudgetP0; readonly signal: AbortSignal; done(): void }
export type ResolverP0 = {
  resolve(session: Session | undefined, signal: AbortSignal): Promise<SessionHandleP0>
  /** Enqueue one full refresh. The returned result is the atomically committed version. */
  refresh?(session: Session | undefined, signal: AbortSignal): Promise<RefreshSnapshotResultP0>
  release(session: Session): Promise<void>
  dispose(): Promise<void>
}
function closed(): HarnessError { return new HarnessError('Code intelligence Session is closed.', 'SESSION_CLOSED') }
function initializationTimeout(): HarnessError { return new HarnessError('Code intelligence initialization timed out.', 'TOOL_TIMEOUT') }
function refreshOverloaded(): HarnessError { return new HarnessError('Too many refreshes are queued for this Session.', 'TOOL_OVERLOADED') }
const MAX_REFRESH_QUEUE_P0 = 16
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** M3 Session owner: active runtimes are immutable; replacement is synchronous at commit,
 * while captured leases keep retired runtimes alive until their callers finish. */
export function createResolverP0(rawConfig: unknown, registry: WorkspaceRegistry, hooks: ResolverHooksP0 = {}): ResolverP0 {
  const config = parseConfigP0(rawConfig)
  const sessions = new WeakMap<Session, SessionState>()
  const retained = new Set<SessionState>()
  const released = new WeakSet<Session>()
  let disposed = false
  const invoke = (callback: (() => void) | undefined): void => { try { callback?.() } catch { /* diagnostics and test observers are isolated */ } }
  const emit = (event: RuntimeEventP0): void => invoke(hooks.eventSink && (() => hooks.eventSink!(Object.freeze(event))))
  const sessionId = (session: Session): string | undefined => {
    const value = (session as unknown as { readonly id?: unknown }).id
    return typeof value === 'string' ? value : undefined
  }
  const failureReason = (error: unknown): string => error instanceof P0ReadError || error instanceof P0BuildError ? error.reason
    : error instanceof HarnessError ? error.code : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? error.name : 'unexpected'
  const extractionSummary = (index: BuiltIndexP0) => ({
    completeFileCount: index.fileExtractionStates.filter(file => file.status === 'complete').length,
    partialFileCount: index.fileExtractionStates.filter(file => file.status === 'partial').length,
    failedFileCount: index.fileExtractionStates.filter(file => file.status === 'failed').length,
    unsupportedFileCount: index.fileExtractionStates.filter(file => file.status === 'unsupported').length,
  })

  async function buildCandidate(session: Session, state: SessionState, operationSignal: AbortSignal, phase: 'initialization' | 'refresh', operationId: number): Promise<RuntimeP0> {
    const controller = new AbortController()
    const signal = AbortSignal.any([state.controller.signal, operationSignal, controller.signal])
    const deadlineMs = Date.now() + config.initializationTimeoutMs
    const startedAt = Date.now()
    const eventBase = { operationId, phase, sessionId: sessionId(session) }
    emit({ kind: 'build-started', ...eventBase })
    const control = { signal, deadlineMs }
    const timer = setTimeout(() => controller.abort(initializationTimeout()), config.initializationTimeoutMs)
    let cache: ContextCacheStoreApiV1 | undefined
    try {
      const cwd = session.header.cwd
      if (!cwd) return failureP0('access-denied', 'A registered Session workspace is required.')
      const workspace = await registry.resolveByPath(cwd)
      if (!workspace) return failureP0('access-denied', 'Session workspace is not registered.')
      let root: string
      try {
        root = await realpath(cwd)
        if (!(await stat(root)).isDirectory() || await realpath(workspace.path) !== root) return failureP0('access-denied', 'Session workspace does not match the registry.')
      } catch { return failureP0('access-denied', 'Session workspace cannot be verified.') }
      checkBuildControlP0(control)
      const { sessionSourceBytes: _budget, initializationTimeoutMs: _timeout, cache: _cache, ...snapshotConfig } = config
      let parsed: SnapshotConfigP0
      try {
        const deploymentRoot = snapshotConfig.deploymentRoot === '.' ? '.' : snapshotConfig.deploymentRoot
        parsed = parseSnapshotConfigP0({ ...snapshotConfig, deploymentRoot, workspaceRoot: root })
      } catch (error) {
        if (error instanceof P0ReadError || error instanceof P0BuildError) throw error
        return failureP0('access-denied', 'Deployment root cannot be verified inside the Session workspace.')
      }
      let index: BuiltIndexP0 | undefined
      let lastReadFailure: P0BuildError | undefined
      const build = hooks.buildIndex ?? buildIndexP0
      // A read race invalidates the whole candidate. At most one fresh full retry is allowed.
      for (let attempt = 0; attempt < 2; attempt++) {
        checkBuildControlP0(control)
        try {
          index = await build(parsed, { control })
          break
        } catch (error) {
          checkBuildControlP0(control)
          if (!(error instanceof P0BuildError) || !['changed-during-read', 'read-failed'].includes(error.reason) || attempt !== 0) throw error
          lastReadFailure = error
          emit({ kind: 'build-retried', ...eventBase, reason: error.reason })
        }
      }
      if (!index) throw lastReadFailure ?? new P0BuildError('read-failed')
      const reader = await createVerifiedReaderP0(parsed.deploymentRoot)
      if (config.cache.enabled) {
        try {
          cache = await ContextCacheStore.open({ deploymentRoot: parsed.deploymentRoot, maxEntries: config.cache.maxEntries, maxBytes: config.cache.maxBytes, lockTimeoutMs: config.cache.lockTimeoutMs })
        } catch {
          // Cache availability is an optimization boundary, never a runtime prerequisite.
          cache = undefined
        }
      }
      checkBuildControlP0(control)
      if (state.status === 'closing' || state.status === 'closed' || disposed) throw closed()
      const runtime = Object.freeze({ index, reader, config: parsed, ...(cache === undefined ? {} : { cache }) })
      emit({ kind: 'build-succeeded', ...eventBase, durationMs: Date.now() - startedAt, snapshotId: index.snapshot.snapshotId, indexFingerprint: index.indexFingerprint,
        extraction: extractionSummary(index), scanCoverage: index.scanCoverage })
      return runtime
    } catch (error) {
      // Cache is an optimization owned by the candidate. Any failure after it
      // opens (including cancellation at the commit checkpoint) must close it
      // before the rejected candidate can be retried or discarded.
      await cache?.close().catch(() => {})
      let translated: unknown = error
      try {
        signal.throwIfAborted()
        if (Date.now() >= deadlineMs) throw initializationTimeout()
        translateP0(error, phase)
      } catch (value) { translated = value }
      emit({ kind: 'build-failed', ...eventBase, durationMs: Date.now() - startedAt, reason: failureReason(translated) })
      throw translated
    } finally { clearTimeout(timer) }
  }

  async function closeRuntime(runtime: RuntimeP0): Promise<void> {
    await runtime.cache?.close()
  }

  function commit(session: Session, state: SessionState, candidate: RuntimeP0, signal: AbortSignal, operationId: number, phase: 'initialization' | 'refresh'): void {
    signal.throwIfAborted()
    if (state.status === 'closing' || state.status === 'closed' || disposed) throw closed()
    const old = state.runtime
    state.runtime = candidate
    state.status = 'active'
    emit({ kind: 'runtime-committed', operationId, phase, sessionId: sessionId(session), previousSnapshotId: old?.index.snapshot.snapshotId,
      snapshotId: candidate.index.snapshot.snapshotId, indexFingerprint: candidate.index.indexFingerprint })
    if (old) {
      state.retired.add(old)
      invoke(hooks.onRuntimeRetired && (() => hooks.onRuntimeRetired!(old)))
      emit({ kind: 'runtime-retired', operationId, phase, sessionId: sessionId(session), snapshotId: old.index.snapshot.snapshotId, indexFingerprint: old.index.indexFingerprint })
      // No lease means the retired immutable object can be dropped immediately.
      if (![...state.calls].some(call => call.runtime === old)) {
        state.retired.delete(old)
        invoke(hooks.onRuntimeReleased && (() => hooks.onRuntimeReleased!(old)))
        void closeRuntime(old)
        emit({ kind: 'runtime-released', operationId, phase, sessionId: sessionId(session), snapshotId: old.index.snapshot.snapshotId, indexFingerprint: old.index.indexFingerprint })
      }
    }
  }
  function releaseRetired(session: Session, state: SessionState, runtime: RuntimeP0): void {
    if (state.retired.has(runtime) && ![...state.calls].some(call => call.runtime === runtime)) {
      state.retired.delete(runtime)
      invoke(hooks.onRuntimeReleased && (() => hooks.onRuntimeReleased!(runtime)))
      void closeRuntime(runtime)
      emit({ kind: 'runtime-released', sessionId: sessionId(session), snapshotId: runtime.index.snapshot.snapshotId, indexFingerprint: runtime.index.indexFingerprint })
    }
  }
  function startInitial(session: Session, state: SessionState, operationSignal: AbortSignal, phase: 'initialization' | 'refresh', queuedOperationId?: number): Promise<RuntimeP0> {
    if (state.initial) return state.initial
    state.status = 'initializing'
    const waitController = new AbortController()
    const waitTimer = setTimeout(() => waitController.abort(initializationTimeout()), config.initializationTimeoutMs)
    state.initialWaitSignal = waitController.signal
    const operationId = queuedOperationId ?? state.nextOperationId++
    const task = buildCandidate(session, state, AbortSignal.any([operationSignal, waitController.signal]), phase, operationId).then(async candidate => {
      try {
        // beforeCommit is owned by the candidate: a throw here must release it too.
        await hooks.beforeCommit?.(phase, candidate)
        commit(session, state, candidate, AbortSignal.any([operationSignal, state.initialWaitSignal!]), operationId, phase)
      } catch (error) {
        await closeRuntime(candidate)
        throw error
      }
      return candidate
    }).catch(error => {
      if (state.status === 'initializing') state.status = 'idle'
      throw error
    })
    state.initial = task
    void task.finally(() => {
      clearTimeout(waitTimer)
      if (state.initial === task) { state.initial = undefined; state.initialWaitSignal = undefined }
    }).catch(() => {})
    return task
  }
  function enqueueRefresh(session: Session, state: SessionState, signal: AbortSignal): Promise<RefreshSnapshotResultP0> {
    if (state.refreshQueueDepth >= MAX_REFRESH_QUEUE_P0) throw refreshOverloaded()
    const wasEmpty = state.refreshQueueDepth++ === 0
    const operationId = state.nextOperationId++
    const queuedAt = Date.now()
    emit({ kind: 'refresh-queued', operationId, phase: 'refresh', sessionId: sessionId(session), queueDepth: state.refreshQueueDepth })
    const taskSignal = AbortSignal.any([signal, state.controller.signal])
    const previous = state.refreshTail
    const run = async () => {
      emit({ kind: 'refresh-started', operationId, phase: 'refresh', sessionId: sessionId(session), queueDurationMs: Date.now() - queuedAt, queueDepth: state.refreshQueueDepth })
      taskSignal.throwIfAborted()
      if (state.status === 'closing' || state.status === 'closed' || disposed) throw closed()
      // A refresh arriving during initialization waits for that operation, but does not
      // reuse its candidate. Its own collection starts only after initialization settles.
      if (state.initial) { try { await state.initial } catch { /* this refresh is its own retry */ } }
      taskSignal.throwIfAborted()
      const before = state.runtime
      // A queued refresh can become the first builder after initialization fails.
      // Register that build synchronously so queries join it instead of racing it.
      const candidate = before
        ? await buildCandidate(session, state, taskSignal, 'refresh', operationId)
        : await startInitial(session, state, taskSignal, 'refresh', operationId)
      if (before) {
        try {
          await hooks.beforeCommit?.('refresh', candidate)
          commit(session, state, candidate, taskSignal, operationId, 'refresh')
        } catch (error) {
          await closeRuntime(candidate)
          throw error
        }
      }
      return refreshResultP0(candidate.index, before?.index.snapshot.snapshotId)
    }
    // Start an idle queue head synchronously: it owns initialization before any
    // later query can arrive. Every refresh, including first build, counts toward
    // the same bound and follows the same tail.
    const task = (wasEmpty ? run() : previous.then(run)).catch(error => {
      emit({ kind: 'operation-failed', operationId, phase: 'refresh', sessionId: sessionId(session), reason: failureReason(error) })
      throw error
    }).finally(() => { state.refreshQueueDepth-- })
    state.refreshTail = task.then(() => {}, () => {})
    return task
  }
  async function closeState(state: SessionState): Promise<void> {
    if (state.closing) return state.closing
    state.status = 'closing'
    // Publish the cleanup promise before synchronous abort listeners can reenter.
    state.closing = Promise.resolve().then(async () => {
      try { await state.initial } catch { /* candidate construction owns its cleanup */ }
      await state.refreshTail
      await Promise.all([...state.calls].map(call => call.done))
      const active = state.runtime
      state.runtime = undefined
      state.retired.clear()
      if (active) await closeRuntime(active)
      state.status = 'closed'
      retained.delete(state)
      emit({ kind: 'session-closed', sessionId: state.sessionId })
    })
    emit({ kind: 'session-closing', sessionId: state.sessionId })
    state.controller.abort(closed())
    return state.closing
  }
  const resolver: ResolverP0 = {
    async resolve(session, signal) {
      signal.throwIfAborted()
      if (disposed || (session && released.has(session))) throw closed()
      if (!session) return failureP0('access-denied', 'A live registered Session workspace is required.')
      let state = sessions.get(session)
      if (!state) {
        state = { controller: new AbortController(), budget: new SourceBudgetP0(config.sessionSourceBytes), calls: new Set(), retired: new Set(), sessionId: sessionId(session), status: 'idle', refreshTail: Promise.resolve(), refreshQueueDepth: 0, nextOperationId: 1 }
        sessions.set(session, state); retained.add(state)
      }
      if (state.status === 'closing' || state.status === 'closed') throw closed()
      const callSignal = AbortSignal.any([signal, state.controller.signal])
      let runtime = state.runtime
      if (!runtime) {
        const initial = startInitial(session, state, state.controller.signal, 'initialization')
        const initializationWaitSignal = AbortSignal.any([callSignal, state.initialWaitSignal!])
        runtime = await waitFor(initial, initializationWaitSignal)
        initializationWaitSignal.throwIfAborted()
      }
      callSignal.throwIfAborted()
      if (state.status !== 'active' || disposed) throw closed()
      let finish!: () => void
      const done = new Promise<void>(resolve => { finish = resolve })
      const lease: Lease = { runtime, done, finish }
      state.calls.add(lease)
      return { runtime, budget: state.budget, signal: callSignal, done() { if (state!.calls.delete(lease)) { finish(); releaseRetired(session, state!, runtime) } } }
    },
    async refresh(session, signal) {
      signal.throwIfAborted()
      if (disposed || (session && released.has(session))) throw closed()
      if (!session) return failureP0('access-denied', 'A live registered Session workspace is required.')
      let state = sessions.get(session)
      if (!state) {
        state = { controller: new AbortController(), budget: new SourceBudgetP0(config.sessionSourceBytes), calls: new Set(), retired: new Set(), sessionId: sessionId(session), status: 'idle', refreshTail: Promise.resolve(), refreshQueueDepth: 0, nextOperationId: 1 }
        sessions.set(session, state); retained.add(state)
      }
      if (state.status === 'closing' || state.status === 'closed') throw closed()
      // If initialization is already underway, queue a fresh collection after it;
      // never return the candidate that was sampled before this refresh arrived.
      const task = enqueueRefresh(session, state, signal)
      return waitFor(task, AbortSignal.any([signal, state.controller.signal]))
    },
    async release(session) {
      released.add(session)
      const state = sessions.get(session)
      if (state) { await closeState(state); sessions.delete(session) }
    },
    async dispose() { disposed = true; await Promise.all([...retained].map(closeState)) },
  }
  return resolver
}

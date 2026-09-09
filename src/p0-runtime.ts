import { realpath, stat } from 'node:fs/promises'
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

export type ConfigP0 = Omit<SnapshotConfigP0, 'workspaceRoot'> & {
  readonly workspaceRoot?: string
  readonly sessionSourceBytes: number | null
  readonly initializationTimeoutMs: number
}
/** Loader-stage syntax/limits only: Session workspace resolution happens at first use. */
export function parseConfigP0(raw: unknown): ConfigP0 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Expected configuration object')
  const input = raw as Record<string, unknown>
  const limits = ['maxFileBytes', 'maxFiles', 'maxTotalBytes', 'maxDirectories', 'maxScanEntries', 'maxIgnoreBytes', 'maxIgnorePatterns'] as const
  const keys = ['workspaceRoot', 'deploymentRoot', 'revision', 'nestedCheckoutRoots', 'sessionSourceBytes', 'initializationTimeoutMs', ...limits]
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
  return Object.freeze({ deploymentRoot, revision: input.revision as string, ...values, nestedCheckoutRoots: Object.freeze(nestedCheckoutRoots), sessionSourceBytes, initializationTimeoutMs,
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
export type RuntimeP0 = { readonly index: BuiltIndexP0; readonly reader: VerifiedReaderP0; readonly config: SnapshotConfigP0 }
type Lifecycle = 'idle' | 'initializing' | 'active' | 'closing' | 'closed'
type Lease = { readonly runtime: RuntimeP0; readonly done: Promise<void>; finish(): void }
type SessionState = {
  readonly controller: AbortController; readonly budget: SourceBudgetP0; readonly calls: Set<Lease>
  status: Lifecycle; runtime?: RuntimeP0; initial?: Promise<RuntimeP0>; initialWaitSignal?: AbortSignal; refreshTail: Promise<void>; closing?: Promise<void>
  readonly retired: Set<RuntimeP0>; refreshQueueDepth: number
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
export function createResolverP0(rawConfig: unknown, registry: WorkspaceRegistry): ResolverP0 {
  const config = parseConfigP0(rawConfig)
  const sessions = new WeakMap<Session, SessionState>()
  const retained = new Set<SessionState>()
  const released = new WeakSet<Session>()
  let disposed = false

  async function buildCandidate(session: Session, state: SessionState, operationSignal: AbortSignal, phase: 'initialization' | 'refresh'): Promise<RuntimeP0> {
    const controller = new AbortController()
    const signal = AbortSignal.any([state.controller.signal, operationSignal, controller.signal])
    const deadlineMs = Date.now() + config.initializationTimeoutMs
    const control = { signal, deadlineMs }
    const timer = setTimeout(() => controller.abort(initializationTimeout()), config.initializationTimeoutMs)
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
      const { sessionSourceBytes: _budget, initializationTimeoutMs: _timeout, ...snapshotConfig } = config
      let parsed: SnapshotConfigP0
      try { parsed = parseSnapshotConfigP0({ ...snapshotConfig, workspaceRoot: root }) } catch { return failureP0('access-denied', 'Deployment root cannot be verified inside the Session workspace.') }
      let index: BuiltIndexP0 | undefined
      let lastReadFailure: P0BuildError | undefined
      // A read race invalidates the whole candidate. At most one fresh full retry is allowed.
      for (let attempt = 0; attempt < 2; attempt++) {
        checkBuildControlP0(control)
        try {
          index = await buildIndexP0(parsed, { control })
          break
        } catch (error) {
          checkBuildControlP0(control)
          if (!(error instanceof P0BuildError) || !['changed-during-read', 'read-failed'].includes(error.reason) || attempt !== 0) throw error
          lastReadFailure = error
        }
      }
      if (!index) throw lastReadFailure ?? new P0BuildError('read-failed')
      const reader = await createVerifiedReaderP0(parsed.deploymentRoot)
      checkBuildControlP0(control)
      if (state.status === 'closing' || state.status === 'closed' || disposed) throw closed()
      return Object.freeze({ index, reader, config: parsed })
    } catch (error) {
      signal.throwIfAborted()
      if (Date.now() >= deadlineMs) throw initializationTimeout()
      return translateP0(error, phase)
    } finally { clearTimeout(timer) }
  }

  function commit(state: SessionState, candidate: RuntimeP0, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (state.status === 'closing' || state.status === 'closed' || disposed) throw closed()
    const old = state.runtime
    state.runtime = candidate
    state.status = 'active'
    if (old) {
      state.retired.add(old)
      // No lease means the retired immutable object can be dropped immediately.
      if (![...state.calls].some(call => call.runtime === old)) state.retired.delete(old)
    }
  }
  function releaseRetired(state: SessionState, runtime: RuntimeP0): void {
    if (![...state.calls].some(call => call.runtime === runtime)) state.retired.delete(runtime)
  }
  function startInitial(session: Session, state: SessionState, operationSignal: AbortSignal, phase: 'initialization' | 'refresh'): Promise<RuntimeP0> {
    if (state.initial) return state.initial
    state.status = 'initializing'
    const waitController = new AbortController()
    const waitTimer = setTimeout(() => waitController.abort(initializationTimeout()), config.initializationTimeoutMs)
    state.initialWaitSignal = waitController.signal
    const task = buildCandidate(session, state, AbortSignal.any([operationSignal, waitController.signal]), phase).then(candidate => {
      commit(state, candidate, AbortSignal.any([operationSignal, state.initialWaitSignal!]))
      return candidate
    }, error => {
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
    state.refreshQueueDepth++
    const previous = state.refreshTail
    const task = previous.then(async () => {
      signal.throwIfAborted()
      if (state.status === 'closing' || state.status === 'closed' || disposed) throw closed()
      // A refresh arriving during initialization waits for that operation, but does not
      // reuse its candidate. Its own collection starts only after initialization settles.
      if (state.initial) { try { await state.initial } catch { /* this refresh is its own retry */ } }
      signal.throwIfAborted()
      const before = state.runtime
      const candidate = await buildCandidate(session, state, signal, 'refresh')
      commit(state, candidate, signal)
      return refreshResultP0(candidate.index, before?.index.snapshot.snapshotId)
    }).finally(() => { state.refreshQueueDepth-- })
    state.refreshTail = task.then(() => {}, () => {})
    return task
  }
  async function closeState(state: SessionState): Promise<void> {
    if (state.closing) return state.closing
    state.status = 'closing'
    state.controller.abort(closed())
    state.closing = (async () => {
      try { await state.initial } catch { /* candidate construction owns its cleanup */ }
      await state.refreshTail
      await Promise.all([...state.calls].map(call => call.done))
      state.runtime = undefined
      state.retired.clear()
      state.status = 'closed'
      retained.delete(state)
    })()
    return state.closing
  }
  const resolver: ResolverP0 = {
    async resolve(session, signal) {
      signal.throwIfAborted()
      if (disposed || (session && released.has(session))) throw closed()
      if (!session) return failureP0('access-denied', 'A live registered Session workspace is required.')
      let state = sessions.get(session)
      if (!state) {
        state = { controller: new AbortController(), budget: new SourceBudgetP0(config.sessionSourceBytes), calls: new Set(), retired: new Set(), status: 'idle', refreshTail: Promise.resolve(), refreshQueueDepth: 0 }
        sessions.set(session, state); retained.add(state)
      }
      if (state.status === 'closing' || state.status === 'closed') throw closed()
      const initial = state.runtime ? Promise.resolve(state.runtime) : startInitial(session, state, state.controller.signal, 'initialization')
      const combined = AbortSignal.any([signal, state.controller.signal, ...(state.initialWaitSignal ? [state.initialWaitSignal] : [])])
      const runtime = await waitFor(initial, combined)
      combined.throwIfAborted()
      if (state.status !== 'active' || disposed) throw closed()
      let finish!: () => void
      const done = new Promise<void>(resolve => { finish = resolve })
      const lease: Lease = { runtime, done, finish }
      state.calls.add(lease)
      return { runtime, budget: state.budget, signal: combined, done() { if (state!.calls.delete(lease)) { finish(); releaseRetired(state!, runtime) } } }
    },
    async refresh(session, signal) {
      signal.throwIfAborted()
      if (disposed || (session && released.has(session))) throw closed()
      if (!session) return failureP0('access-denied', 'A live registered Session workspace is required.')
      let state = sessions.get(session)
      if (!state) {
        state = { controller: new AbortController(), budget: new SourceBudgetP0(config.sessionSourceBytes), calls: new Set(), retired: new Set(), status: 'idle', refreshTail: Promise.resolve(), refreshQueueDepth: 0 }
        sessions.set(session, state); retained.add(state)
      }
      if (state.status === 'closing' || state.status === 'closed') throw closed()
      // An idle refresh owns the first build and publishes it as initialization.
      if (!state.runtime && !state.initial) {
        const initial = startInitial(session, state, signal, 'refresh')
        const candidate = await waitFor(initial, AbortSignal.any([signal, state.controller.signal, ...(state.initialWaitSignal ? [state.initialWaitSignal] : [])]))
        return refreshResultP0(candidate.index, undefined)
      }
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

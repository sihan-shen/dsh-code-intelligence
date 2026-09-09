import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { parseCanonicalRepoPathP0, SNAPSHOT_POLICY_P0, OUTPUT_POLICY_P0, type FailureDetailsP0 } from '@han_05/dsh-context'
import { buildIndexP0, P0BuildError } from './p0-build.js'
import { parseSnapshotConfigP0 } from './p0-snapshot.js'
import { createVerifiedReaderP0, checkBuildControlP0, P0ReadError } from './p0-reader.js'
import { failureP0 } from './p0-query.js'
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

export function translateP0(error: unknown, initialization = false): never {
  if (error instanceof P0ReadError || error instanceof P0BuildError) {
    return failureP0(error.code, error.code === 'stale-source'
      ? 'Source changed or disappeared; M2 requires a new Session to rebuild (refresh is not implemented).'
      : error.code === 'access-denied' ? 'Workspace path access denied.' : 'Could not build a trusted index.',
    { ...error.details, ...(initialization && error.code === 'refresh-failed' ? { phase: 'initialization' } : {}) } as FailureDetailsP0)
  }
  throw error
}
export type RuntimeP0 = { readonly index: BuiltIndexP0; readonly reader: VerifiedReaderP0; readonly config: SnapshotConfigP0 }
type SessionState = {
  readonly controller: AbortController; readonly budget: SourceBudgetP0
  pending?: Promise<RuntimeP0>; runtime?: RuntimeP0; closed: boolean; closing?: Promise<void>
  readonly calls: Set<Promise<void>>
}
export type SessionHandleP0 = { readonly runtime: RuntimeP0; readonly budget: SourceBudgetP0; readonly signal: AbortSignal; done(): void }
export type ResolverP0 = {
  resolve(session: Session | undefined, signal: AbortSignal): Promise<SessionHandleP0>
  release(session: Session): Promise<void>
  dispose(): Promise<void>
}
function closed(): HarnessError { return new HarnessError('Code intelligence Session is closed.', 'SESSION_CLOSED') }
function initializationTimeout(): HarnessError { return new HarnessError('Code intelligence initialization timed out.', 'TOOL_TIMEOUT') }
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
/** Minimal M2 holder: one immutable runtime, no refresh queue, replacement or retired leases.
 * Readers own their descriptors; release aborts calls/builds, waits for their cleanup,
 * and clears the retained index and budget. There are no replaceable/retired runtimes.
 */
export function createResolverP0(rawConfig: unknown, registry: WorkspaceRegistry): ResolverP0 {
  const config = parseConfigP0(rawConfig)
  const sessions = new WeakMap<Session, SessionState>()
  const retained = new Set<SessionState>()
  const released = new WeakSet<Session>()
  let disposed = false
  async function build(session: Session, state: SessionState): Promise<RuntimeP0> {
    const control = { signal: state.controller.signal, deadlineMs: Date.now() + config.initializationTimeoutMs }
    const timer = setTimeout(() => state.controller.abort(initializationTimeout()), config.initializationTimeoutMs)
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
      const index = await buildIndexP0(parsed, { control })
      const reader = await createVerifiedReaderP0(parsed.deploymentRoot)
      checkBuildControlP0(control)
      if (state.closed || disposed) throw closed()
      return Object.freeze({ index, reader, config: parsed })
    } catch (error) {
      // Cancellation wins over business classification. Synchronous work can
      // cross the deadline before the timer gets an event-loop turn; both paths
      // must use the host's timeout channel, not a raw DOMException.
      state.controller.signal.throwIfAborted()
      if (Date.now() >= control.deadlineMs) throw initializationTimeout()
      return translateP0(error, true)
    } finally { clearTimeout(timer) }
  }
  function closeState(state: SessionState): Promise<void> {
    state.closed = true
    // Publish the cleanup promise before abort listeners can re-enter release.
    state.closing ??= Promise.resolve().then(async () => {
      try { await state.pending } catch { /* construction owns its cleanup */ }
      await Promise.all([...state.calls])
      state.pending = undefined
      state.runtime = undefined
      retained.delete(state)
    })
    state.controller.abort(closed())
    return state.closing
  }
  return {
    async resolve(session, signal) {
      signal.throwIfAborted()
      if (disposed || (session && released.has(session))) throw closed()
      if (!session) return failureP0('access-denied', 'A live registered Session workspace is required.')
      let state = sessions.get(session)
      if (!state) {
        state = { controller: new AbortController(), budget: new SourceBudgetP0(config.sessionSourceBytes), closed: false, calls: new Set() }
        sessions.set(session, state); retained.add(state)
      }
      const captured = state
      if (!captured.pending) {
        captured.pending = build(session, captured).then(runtime => { captured.runtime = runtime; return runtime })
        void captured.pending.catch(() => {
          if (!captured.closed && sessions.get(session) === captured) { sessions.delete(session); retained.delete(captured) }
        })
      }
      const combined = AbortSignal.any([signal, captured.controller.signal])
      const runtime = await waitFor(captured.pending, combined)
      combined.throwIfAborted()
      if (captured.closed || disposed) throw closed()
      let finish!: () => void
      const completion = new Promise<void>(resolve => { finish = resolve })
      captured.calls.add(completion)
      return { runtime, budget: captured.budget, signal: combined, done() { captured.calls.delete(completion); finish() } }
    },
    async release(session) {
      released.add(session)
      const state = sessions.get(session)
      if (state) {
        await closeState(state)
        sessions.delete(session)
      }
    },
    async dispose() { disposed = true; await Promise.all([...retained].map(closeState)) },
  }
}

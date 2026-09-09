import type { InternalSymbolEntryV1, RepositorySnapshotV1, RepoFileSummaryV1 } from '@han_05/dsh-context'
import type { ContextBlockV1 } from '@han_05/dsh-context'
import type { ContextCacheStoreApiV1 } from '@han_05/dsh-context-cache'
import type { InternalSymbolIndexStore } from './symbol-index.js'
import type { RepositorySnapshotStore } from './snapshot.js'

export type CacheConfigV1 = {
  readonly enabled?: boolean
  readonly maxEntries?: number
  readonly maxBytes?: number
  readonly lockTimeoutMs?: number
}

export type SnapshotConfigV1 = {
  readonly workspaceRoot?: string
  readonly deploymentRoot: string
  readonly revision: string
  readonly maxFileBytes: number
  readonly maxFiles: number
  readonly maxTotalBytes: number
  readonly maxDirectories: number
  readonly maxIgnoreBytes: number
  readonly nestedCheckoutRoots: readonly string[]
  readonly cache?: CacheConfigV1
}

export type LspDeploymentEnvironmentKey = 'LANG' | 'LC_ALL' | 'TMPDIR' | 'TEMP' | 'TMP'

export type LspDeploymentConfigV1 = {
  readonly executable: string
  readonly fixedArgs: readonly string[]
  readonly environment: Readonly<Partial<Record<LspDeploymentEnvironmentKey, string>>>
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxMessageBytes: number
  readonly maxStderrBytes: number
  readonly graceMs: number
}

export type HostNetworkIsolation =
  | { readonly networkIsolation: 'enforced'; readonly capabilityId: symbol }
  | { readonly networkIsolation: 'unavailable' }

export type SourceMeasurementV1 = {
  readonly path: string
  readonly sourceHash: string
  readonly startOffset: number
  readonly endOffset: number
  readonly text: string
  readonly byteLength: number
}

export type SnapshotTestHooks = {
  readonly afterOpenForTest?: (absolutePath: string) => void | Promise<void>
}

export type AdapterUnavailableCode = 'network-isolation-unavailable' | 'spawn-failed' | 'timed-out' | 'protocol-invalid' | 'capability-missing'

export type AdapterUnavailableV1 = {
  readonly adapterId: 'typescript-lsp'
  readonly adapterVersion: string
  readonly code: AdapterUnavailableCode
}

export type InternalSymbolRelationV1 = {
  readonly kind: 'imports' | 'exports' | 'contains' | 'calls'
  readonly targetName: string
  readonly targetPath?: string
}

export type SymbolAdapterResultV1 = {
  readonly adapterId: 'typescript-ast-fallback' | 'typescript-lsp'
  readonly adapterVersion: string
  readonly entries: readonly InternalSymbolEntryV1[]
  readonly relations: Readonly<Record<string, readonly InternalSymbolRelationV1[]>>
}

export type { InternalSymbolEntryV1, RepoFileSummaryV1, RepositorySnapshotV1 }

export type ContextCompiler = {
  repoMap(request: { snapshotId: string; limit: number; cursor?: string }, signal: AbortSignal, sessionKey?: string): Promise<ContextBlockV1>
  symbolQuery(request: { snapshotId: string; query: string; limit: number; cursor?: string }, signal: AbortSignal, sessionKey?: string): Promise<ContextBlockV1>
  expandSource(request: { blockId: string; path: string; sourceHash: string; startOffset: number; endOffset: number }, signal: AbortSignal, sessionKey?: string): Promise<ContextBlockV1>
  /** Select the compiler owned by the current Harness Session when supported. */
  forSession?(session: object | undefined): Promise<ContextCompiler>
}

export type ContextCompilerStats = {
  readonly hits: number
  readonly misses: number
}

export type ContextCompilerOptions = {
  readonly workspaceRoot: string
  readonly store: RepositorySnapshotStore
  readonly index: InternalSymbolIndexStore
  readonly cache?: ContextCacheStoreApiV1
  readonly compilerPolicyVersion?: string
  readonly capabilityVersion?: string
  readonly indexFingerprint?: string
}

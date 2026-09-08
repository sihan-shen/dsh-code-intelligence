import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { parseContextBlockV1, parseRepoMapPageV1, parseSymbolQueryResultV1, type ContextBlockV1, type RepoMapPageV1, type SymbolQueryResultV1 } from '@han_05/dsh-context'
import { buildRepoMap, querySymbols, type RepoMapOptionsV1, type SymbolQueryV1 } from './projections.js'
import type { InternalSymbolIndexStore } from './symbol-index.js'
import type { RepositorySnapshotStore } from './snapshot.js'
import type { ContextCompiler } from './types.js'

type ToolExecution = Pick<ToolRunContext, 'signal' | 'agent' | 'rootCallId'>
export type ToolRuntime = { readonly snapshot: RepositorySnapshotStore['snapshot']; readonly index: InternalSymbolIndexStore }
export type ToolRuntimeResolver = (exec: ToolExecution) => ToolRuntime | Promise<ToolRuntime>
type ToolRuntimeSource = ToolRuntime | ToolRuntimeResolver

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('code intelligence arguments must be an object')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unknown code intelligence argument: ${key}`)
}

function input(value: unknown, query: boolean): RepoMapOptionsV1 | SymbolQueryV1 {
  const raw = object(value)
  exactKeys(raw, query ? ['query', 'limit', 'cursor'] : ['limit', 'cursor'])
  if (typeof raw.limit !== 'number' || !Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > 50) throw new RangeError('limit must be between 1 and 50')
  if (raw.cursor !== undefined && (typeof raw.cursor !== 'string' || new TextEncoder().encode(raw.cursor).byteLength > 1_024)) throw new RangeError('cursor exceeds 1024 UTF-8 bytes')
  if (query) {
    if (typeof raw.query !== 'string' || new TextEncoder().encode(raw.query).byteLength > 256) throw new RangeError('query exceeds 256 UTF-8 bytes')
    return { query: raw.query, limit: raw.limit, ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }) }
  }
  return { limit: raw.limit, ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }) }
}

function render(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

const parameters = (query: boolean) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    ...(query ? { query: { type: 'string' } } : {}),
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    cursor: { type: 'string' },
  },
  required: query ? ['query', 'limit'] : ['limit'],
})

function runtimeFor(source: ToolRuntimeSource, exec: ToolExecution): ToolRuntime | Promise<ToolRuntime> {
  return typeof source === 'function' ? source(exec) : source
}

export function createCodeIntelligenceTools(source: ToolRuntimeSource): readonly ToolDefinition[] {
  const repoMap = {
    name: 'code_repo_map',
    description: 'Return a bounded repository map page for the current immutable snapshot.',
    parameters: parameters(false),
    output: { schema: { type: 'object' }, render },
    async execute(rawArgs: unknown, exec: ToolExecution): Promise<RepoMapPageV1> {
      if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      const options = input(rawArgs, false) as RepoMapOptionsV1
      const runtime = await runtimeFor(source, exec)
      return parseRepoMapPageV1(buildRepoMap(runtime.snapshot, runtime.index, options))
    },
  } as ToolDefinition
  const symbolQuery = {
    name: 'code_symbol_query',
    description: 'Search bounded symbols in the current immutable repository snapshot.',
    parameters: parameters(true),
    output: { schema: { type: 'object' }, render },
    async execute(rawArgs: unknown, exec: ToolExecution): Promise<SymbolQueryResultV1> {
      if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      const options = input(rawArgs, true) as SymbolQueryV1
      const runtime = await runtimeFor(source, exec)
      return parseSymbolQueryResultV1(querySymbols(runtime.snapshot, runtime.index, options))
    },
  } as ToolDefinition
  return Object.freeze([repoMap, symbolQuery])
}

const contextParameters = (kind: 'repo-map' | 'symbol' | 'source-window') => ({
  type: 'object',
  additionalProperties: false,
  properties: kind === 'repo-map'
    ? { snapshotId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string' } }
    : kind === 'symbol'
      ? { snapshotId: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string' } }
      : {
          blockId: { type: 'string' },
          path: { type: 'string' },
          sourceHash: { type: 'string' },
          startOffset: { type: 'integer', minimum: 0 },
          endOffset: { type: 'integer', minimum: 0 },
        },
  required: kind === 'repo-map'
    ? ['snapshotId', 'limit']
    : kind === 'symbol'
      ? ['snapshotId', 'query', 'limit']
      : ['blockId', 'path', 'sourceHash', 'startOffset', 'endOffset'],
})

function contextOutput(): { readonly schema: { readonly type: 'object' }; readonly render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> } {
  return {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

export function createContextTools(compiler: ContextCompiler): readonly ToolDefinition[] {
  const agentKeys = new WeakMap<object, string>()
  let nextAgentKey = 0

  function sessionKey(exec: ToolExecution): string | undefined {
    const agent = exec.agent
    if (agent !== undefined && agent !== null) {
      const existing = agentKeys.get(agent)
      if (existing !== undefined) return existing
      const key = `agent:${nextAgentKey++}`
      agentKeys.set(agent, key)
      return key
    }
    return exec.rootCallId === undefined ? undefined : `root:${exec.rootCallId}`
  }

  async function compilerFor(exec: ToolExecution): Promise<ContextCompiler> {
    return compiler.forSession === undefined
      ? compiler
      : compiler.forSession(exec.agent?.session)
  }

  const repoMap = {
    name: 'context_repo_map',
    description: 'Compile a bounded repository map Context Block for the current immutable snapshot.',
    parameters: contextParameters('repo-map'),
    output: contextOutput(),
    async execute(rawArgs: unknown, exec: ToolExecution): Promise<ContextBlockV1> {
      if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      const activeCompiler = await compilerFor(exec)
      return parseContextBlockV1(await activeCompiler.repoMap(rawArgs as { snapshotId: string; limit: number; cursor?: string }, exec.signal, sessionKey(exec)))
    },
  } as ToolDefinition
  const symbolQuery = {
    name: 'context_symbol_query',
    description: 'Compile bounded symbol matches into a Context Block for the current immutable snapshot.',
    parameters: contextParameters('symbol'),
    output: contextOutput(),
    async execute(rawArgs: unknown, exec: ToolExecution): Promise<ContextBlockV1> {
      if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      const activeCompiler = await compilerFor(exec)
      return parseContextBlockV1(await activeCompiler.symbolQuery(rawArgs as { snapshotId: string; query: string; limit: number; cursor?: string }, exec.signal, sessionKey(exec)))
    },
  } as ToolDefinition
  const expandSource = {
    name: 'context_expand_source',
    description: 'Expand one bounded, provenance-checked source window from a cached Context Block.',
    parameters: contextParameters('source-window'),
    output: contextOutput(),
    async execute(rawArgs: unknown, exec: ToolExecution): Promise<ContextBlockV1> {
      if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      const activeCompiler = await compilerFor(exec)
      return parseContextBlockV1(await activeCompiler.expandSource(rawArgs as { blockId: string; path: string; sourceHash: string; startOffset: number; endOffset: number }, exec.signal, sessionKey(exec)))
    },
  } as ToolDefinition
  return Object.freeze([repoMap, symbolQuery, expandSource])
}

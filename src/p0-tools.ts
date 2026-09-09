import { defineTool, type ParameterSchemaSpec, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SYMBOL_KINDS_P0, RELATION_TYPES_P0, OUTPUT_POLICY_P0 as O, parseRepoMapRequestP0, parseSymbolQueryRequestP0, parseRelationQueryRequestP0, parseExpandSourceRequestP0, parseRefreshSnapshotRequestP0 } from '@han_05/dsh-context'
import { repoMapP0, symbolQueryP0, relationQueryP0, requestP0, outputBytesP0, outputBudgetP0 } from './p0-query.js'
import { expandSourceP0 } from './p0-source.js'
import { translateP0, type ResolverP0 } from './p0-runtime.js'

const snapshot = { type: 'string' as const, description: 'snapshotId returned by context_repo_map; required except for repo map discovery.' }
const page = {
  limit: { type: 'integer' as const, description: '1–50, default 20. Forbidden for path/symbolId direct lookup.' },
  cursor: { type: 'string' as const, description: 'At most 1024 UTF-8 bytes; keep query and limit unchanged for continuation.' },
}
const scope = 'M3: explicit full refresh with immutable runtime leases and no cache. Refresh does not modify workspace source. Native transport required; PTC structured failures unsupported. '
const coverage = 'AST coverage: TS/JS named declarations (including non-exported/nested), variable/destructured bindings and named class/interface/enum members; no parameter/type-parameter or synthetic anonymous symbols. Complete means this coverage only, not language semantics. '
const definitions: readonly { name: string; description: string; parameters: ParameterSchemaSpec; parse: (raw: unknown) => unknown }[] = [
  { name: 'context_refresh_snapshot', description: scope + 'Queue a bounded full rebuild for this Session. The candidate commits atomically only after verification; failed or canceled refresh keeps the prior runtime. Queries already in flight may finish on their captured snapshot; new queries use the committed snapshot. Refresh does not reset the Session source budget.', parameters: {}, parse: parseRefreshSnapshotRequestP0 },
  { name: 'context_repo_map', description: scope + 'Discover current snapshot/version and bounded path-sorted receipts, including JSON/README. Optional canonical path is a direct lookup, exclusive with limit/cursor. No blockId is produced. ' + coverage,
    parameters: { snapshotId: snapshot, path: { type: 'string', description: 'Exact canonical repository-relative POSIX file path; no traversal, absolute path or backslash.' }, ...page }, parse: parseRepoMapRequestP0 },
  { name: 'context_symbol_query', description: scope + coverage + 'Use name (nonblank, ≤256 UTF-8 bytes) with exact (default), prefix or explicit fuzzy. Exact/prefix match raw name or lexical qualified label, case-sensitive; pathPrefix is a directory, not a file/string prefix. Fuzzy ranking is deterministic policy, not semantic confidence. symbolId direct lookup excludes all collection fields; handles belong to this index. Host grep/read remain valid alternatives.',
    parameters: { snapshotId: { ...snapshot, required: true }, name: { type: 'string' }, mode: { type: 'string', enum: ['exact', 'prefix', 'fuzzy'] }, kind: { type: 'string', enum: SYMBOL_KINDS_P0 }, pathPrefix: { type: 'string', description: 'Empty/omitted means repository; optional trailing slash canonicalized.' }, symbolId: { type: 'string' }, ...page }, parse: parseSymbolQueryRequestP0 },
  { name: 'context_relation_query', description: scope + 'Positive forward summary edges only: from.symbolId yields syntactic contains; from.path yields static top-level imports/exports and heuristic file-level calls names. Not resolved dependencies, callers/callees, or a call graph. No dynamic import/require/import-equals/export=/CommonJS edges, new/tagged/element-access calls or local module imports/exports. Type-only edges do not imply runtime dependencies. types defaults to all four, [] matches none; valid filters with no edges succeed and retain extraction status.',
    parameters: { snapshotId: { ...snapshot, required: true }, from: { type: 'object', additionalProperties: false, required: true, properties: { symbolId: { type: 'string' }, path: { type: 'string' } }, description: 'Exactly one of symbolId or canonical receipt path.' }, types: { type: 'array', items: { type: 'string', enum: RELATION_TYPES_P0 } }, ...page }, parse: parseRelationQueryRequestP0 },
  { name: 'context_expand_source', description: scope + 'Read verified source directly using snapshotId/path/sourceHash from a receipt; no prior projection authorization. Choose exactly one explicit offsetRange (UTF-16 half-open, empty allowed), lineRange (1-based inclusive including terminator), or wholeFile:true. paddingLines 0–20 per side (default 0) only for ranges. No split surrogate pairs or silent range clipping except padding at file boundaries. Overlap/retries allowed and charged. Final JSON ≤65536 bytes; Session agents share 262144-byte default budget. Over-budget returns no partial source. Explicit blockId fails cache-unavailable until optional M4 cache support.',
    parameters: { snapshotId: { ...snapshot, required: true }, path: { type: 'string', required: true }, sourceHash: { type: 'string', required: true }, blockId: { type: 'string' },
      offsetRange: { type: 'object', additionalProperties: false, properties: { startOffset: { type: 'integer', required: true }, endOffset: { type: 'integer', required: true } } },
      lineRange: { type: 'object', additionalProperties: false, properties: { startLine: { type: 'integer', required: true }, endLine: { type: 'integer', required: true } } }, wholeFile: { type: 'boolean', const: true }, paddingLines: { type: 'integer' } }, parse: parseExpandSourceRequestP0 },
]
export function createToolsP0(resolver: ResolverP0): readonly ToolDefinition[] {
  return Object.freeze(definitions.map(definition => defineTool({
    name: definition.name, description: definition.description, parameters: definition.parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(raw, exec) {
      // Validate before initializing a workspace. Shared parser owns all defaults/combinations.
      requestP0(definition.parse, raw)
      if (definition.name === 'context_refresh_snapshot') {
        if (!resolver.refresh) throw new Error('refresh resolver is unavailable')
        const value = await resolver.refresh(exec.agent?.session, exec.signal)
        if (outputBytesP0(value) > O.maxOutputBytes) return outputBudgetP0(outputBytesP0(value))
        return value as unknown as Record<string, never>
      }
      const { runtime, budget, signal, done } = await resolver.resolve(exec.agent?.session, exec.signal)
      try {
        signal.throwIfAborted()
        const value = definition.name === 'context_repo_map' ? repoMapP0(runtime.index, raw)
          : definition.name === 'context_symbol_query' ? symbolQueryP0(runtime.index, raw)
          : definition.name === 'context_relation_query' ? relationQueryP0(runtime.index, raw)
          : await expandSourceP0(runtime.index, runtime.reader, raw, { signal }, runtime.config.nestedCheckoutRoots)
        // Exactly the JSON rendered by this adapter, not text length or host framing.
        const bytes = outputBytesP0(value)
        if (bytes > O.maxOutputBytes) return outputBudgetP0(bytes)
        signal.throwIfAborted()
        if (definition.name === 'context_expand_source') budget.debit(bytes)
        return value as unknown as Record<string, never>
      } catch (error) {
        signal.throwIfAborted()
        return translateP0(error)
      } finally { done() }
    },
  })))
}

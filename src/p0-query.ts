import {
  canonicalJson, sha256Utf8, INPUT_POLICY_P0 as I, OUTPUT_POLICY_P0 as O,
  parseRepoMapRequestP0, parseSymbolQueryRequestP0, parseRelationQueryRequestP0,
  parseRepoMapPageP0, parseSymbolQueryResultP0, parseRelationQueryResultP0,
  type CodeIntelligenceFailureCodeP0, type FailureDetailsP0, type ExtractionMetadataP0,
  type FileExtractionStateP0, type IndexResponseHeaderP0, type SymbolMatchP0,
  type RepoMapPageP0, type SymbolQueryResultP0, type RelationQueryResultP0, type RefreshSnapshotResultP0,
} from '@han_05/dsh-context'
import { indexProvenanceP0 } from './p0-build.js'
import { CodeIntelligenceErrorP0 } from './p0-tool-errors.js'
import type { BuiltIndexP0 } from './p0-types.js'

export const compareP0 = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
export const outputBytesP0 = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
export function failureP0(code: CodeIntelligenceFailureCodeP0, message: string, details?: FailureDetailsP0): never {
  throw new CodeIntelligenceErrorP0({ code, message, ...(details ? { details } : {}) })
}
/** Catch only the explicitly invoked shared input parser, not arbitrary implementation errors. */
export function requestP0<T>(parser: (raw: unknown) => T, raw: unknown): T {
  try { return parser(raw) } catch { return failureP0('invalid-query', 'Invalid code-intelligence query arguments.') }
}
export function outputBudgetP0(requestedOutputBytes: number): never {
  return failureP0('budget-exceeded', 'Response exceeds the output budget; request a smaller explicit range or page.', {
    limit: 'maxOutputBytes', requestedOutputBytes, maxOutputBytes: O.maxOutputBytes,
  })
}
export function snapshotP0(index: BuiltIndexP0, snapshotId?: string): void {
  if (snapshotId !== undefined && snapshotId !== index.snapshot.snapshotId) failureP0('stale-snapshot', 'Snapshot is not current; rediscover it with context_repo_map.', { currentSnapshotId: index.snapshot.snapshotId })
}
export function symbolByIdP0(index: BuiltIndexP0, id: string) {
  const symbol = index.symbols.find(s => s.symbolId === id)
  if (!symbol) return failureP0('stale-symbol-id', 'Symbol handle is not a member of the captured index; query its name again.')
  return symbol
}
export function receiptP0(index: BuiltIndexP0, path: string) {
  const receipt = index.snapshot.files.find(f => f.path === path)
  if (!receipt) return failureP0('not-found', 'Path is not in the captured snapshot.')
  return receipt
}

export function refreshResultP0(index: BuiltIndexP0, previousSnapshotId?: string): RefreshSnapshotResultP0 {
  const states = index.fileExtractionStates
  const value = { ...headerP0(index, states), changed: previousSnapshotId === undefined || previousSnapshotId !== index.snapshot.snapshotId, scanCoverage: index.scanCoverage }
  if (outputBytesP0(value) > O.maxOutputBytes) return failureP0('budget-exceeded', 'Response exceeds the output budget.', { limit: 'maxOutputBytes', requestedOutputBytes: outputBytesP0(value), maxOutputBytes: O.maxOutputBytes })
  return value
}

export function extractionP0(states: readonly FileExtractionStateP0[]): ExtractionMetadataP0 {
  const completeFileCount = states.filter(f => f.status === 'complete').length
  const partialFileCount = states.filter(f => f.status === 'partial').length
  const failedFileCount = states.filter(f => f.status === 'failed').length
  const eligibleFileCount = completeFileCount + partialFileCount + failedFileCount
  const problems = states.filter(f => f.eligible && f.status !== 'complete').sort((a, b) => compareP0(a.path, b.path))
  return {
    summary: {
      status: eligibleFileCount ? (partialFileCount + failedFileCount ? 'partial' : 'complete') : states.length ? 'unsupported' : 'complete',
      scopeFileCount: states.length, eligibleFileCount, unsupportedFileCount: states.length - eligibleFileCount,
      completeFileCount, partialFileCount, failedFileCount,
    },
    problemFiles: problems.slice(0, O.maxProblemFiles), detailsTruncated: problems.length > O.maxProblemFiles,
  }
}

function headerP0(index: BuiltIndexP0, states: readonly FileExtractionStateP0[]): IndexResponseHeaderP0 {
  const provenance = [indexProvenanceP0(index.snapshot.snapshotId, index.providerConfigIdentity)]
  let extraction = extractionP0(states)
  // Optional details are removed first; never trim fact values or source states.
  while (outputBytesP0({ provenance, extraction }) > O.maxMetadataBytes && extraction.problemFiles.length) {
    extraction = { ...extraction, problemFiles: extraction.problemFiles.slice(0, -1), detailsTruncated: true }
  }
  if (outputBytesP0({ provenance, extraction }) > O.maxMetadataBytes) return failureP0('provider-failed', 'Required index metadata exceeds the shared policy.', { reason: 'contract-invalid' })
  return { schemaVersion: 'p0', snapshotId: index.snapshot.snapshotId, indexFingerprint: index.indexFingerprint, provenance, extraction }
}

type Kind = 'repo-map' | 'symbol-query' | 'relation-query'
type Cursor = { schemaVersion: 'p0'; kind: Kind; snapshotId: string; indexFingerprint: string; queryHash: string; offset: number; limit: number; policyVersion: string }
const hash = (v: unknown) => sha256Utf8(canonicalJson(v))
const b64 = (s: string) => Buffer.from(s).toString('base64url')
function unb64(s: string): string {
  const value = Buffer.from(s, 'base64url').toString('utf8')
  if (!/^[\w-]+$/.test(s) || b64(value) !== s) throw new Error('encoding')
  return value
}
export function encodeCursorP0(payload: Cursor): string {
  const json = canonicalJson(payload)
  const token = `${b64(json)}.${b64(sha256Utf8(json))}`
  if (Buffer.byteLength(token) > I.maxCursorBytes) throw new Error('Internal cursor exceeds shared policy')
  return token
}
export function decodeCursorP0(token: string): Cursor {
  try {
    if (Buffer.byteLength(token) > I.maxCursorBytes) throw new Error('length')
    const parts = token.split('.')
    if (parts.length !== 2) throw new Error('parts')
    const json = unb64(parts[0])
    if (unb64(parts[1]) !== sha256Utf8(json)) throw new Error('digest')
    const p = JSON.parse(json)
    const keys = ['schemaVersion', 'kind', 'snapshotId', 'indexFingerprint', 'queryHash', 'offset', 'limit', 'policyVersion']
    if (!p || typeof p !== 'object' || Array.isArray(p) || canonicalJson(p) !== json || Object.keys(p).length !== keys.length || keys.some(k => !Object.hasOwn(p, k))) throw new Error('shape')
    if (p.schemaVersion !== 'p0' || !['repo-map', 'symbol-query', 'relation-query'].includes(p.kind)
      || ![p.snapshotId, p.indexFingerprint, p.queryHash].every(v => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v))
      || !Number.isSafeInteger(p.offset) || p.offset < 0 || !Number.isSafeInteger(p.limit) || p.limit < 1 || p.limit > I.maxLimit
      || typeof p.policyVersion !== 'string' || !p.policyVersion || Buffer.byteLength(p.policyVersion) > O.maxIdentityBytes) throw new Error('payload')
    return p
  } catch { return failureP0('invalid-cursor', 'Cursor is malformed; restart from the first page.') }
}

function pageP0<T, R>(index: BuiltIndexP0, kind: Kind, query: { cursor?: string; limit?: number }, candidates: readonly T[], states: readonly FileExtractionStateP0[], field: string, parse: (v: unknown) => R, sourcePath?: (item: T) => string): R {
  const { cursor, ...normalized } = query
  const limit = query.limit ?? 1
  const binding = { schemaVersion: 'p0' as const, kind, snapshotId: index.snapshot.snapshotId, indexFingerprint: index.indexFingerprint,
    queryHash: hash({ kind, query: normalized, snapshotId: index.snapshot.snapshotId, indexFingerprint: index.indexFingerprint, provider: index.providerConfigIdentity, inputPolicy: I.policyVersion, outputPolicy: O.policyVersion }),
    limit, policyVersion: I.policyVersion }
  let offset = 0
  if (cursor !== undefined) {
    const decoded = decodeCursorP0(cursor)
    const { offset: decodedOffset, ...identity } = decoded
    if (canonicalJson(identity) !== canonicalJson(binding) || decodedOffset > candidates.length) return failureP0('stale-cursor', 'Cursor does not match this query/index; restart from the first page.')
    offset = decodedOffset
  }
  const header = headerP0(index, states)
  const requested = Math.min(limit, candidates.length - offset)
  for (let count = requested; count >= (requested ? 1 : 0); count--) {
    const items = candidates.slice(offset, offset + count)
    const paths = new Set(sourcePath ? items.map(sourcePath) : [])
    const resultFiles = states.filter(s => paths.has(s.path) && s.status !== 'complete')
    const end = offset + count
    const truncated = end < candidates.length
    const value = { ...header, extraction: { ...header.extraction, ...(resultFiles.length ? { resultFiles } : {}) }, [field]: items,
      truncated, ...(truncated ? { nextCursor: encodeCursorP0({ ...binding, offset: end }) } : {}) }
    const bytes = outputBytesP0(value)
    if (bytes <= O.maxOutputBytes) {
      try { return parse(value) } catch { return failureP0('provider-failed', 'Query output violates the shared contract.', { reason: 'contract-invalid' }) }
    }
    if (count <= 1) return outputBudgetP0(bytes)
  }
  throw new Error('Unreachable page state')
}

export function repoMapP0(index: BuiltIndexP0, raw: unknown): RepoMapPageP0 {
  const request = requestP0(parseRepoMapRequestP0, raw)
  snapshotP0(index, request.snapshotId)
  const files = request.path === undefined ? index.snapshot.files : [receiptP0(index, request.path)]
  const scope = request.path === undefined ? index.fileExtractionStates : index.fileExtractionStates.filter(f => f.path === request.path)
  const items = [...files].sort((a, b) => compareP0(a.path, b.path)).map(f => ({ path: f.path, sourceHash: f.contentHash, byteLength: f.byteLength, language: f.language }))
  const normalized = { ...request, snapshotId: index.snapshot.snapshotId }
  return pageP0(index, 'repo-map', normalized, items, scope, 'items', parseRepoMapPageP0)
}
export function termsP0(value: string): string[] {
  return value.replace(/([a-z\d])([A-Z])/g, '$1 $2').split(/[^\p{L}\p{N}]+/u).map(t => t.toLowerCase()).filter(Boolean)
}
export function symbolQueryP0(index: BuiltIndexP0, raw: unknown): SymbolQueryResultP0 {
  const request = requestP0(parseSymbolQueryRequestP0, raw)
  snapshotP0(index, request.snapshotId)
  if (request.symbolId !== undefined) {
    const symbol = symbolByIdP0(index, request.symbolId)
    return pageP0(index, 'symbol-query', request, [symbol], index.fileExtractionStates.filter(f => f.path === symbol.path), 'matches', parseSymbolQueryResultP0, s => s.path)
  }
  const inScope = (path: string) => !request.pathPrefix || path.startsWith(`${request.pathPrefix}/`)
  const states = index.fileExtractionStates.filter(f => inScope(f.path))
  const candidates = index.symbols.filter(s => inScope(s.path) && (request.kind === undefined || s.kind === request.kind))
  const queryTerms = termsP0(request.name)
  const byId = new Map(index.symbols.map(s => [s.symbolId, s]))
  const children = new Map<string, Set<string>>()
  if (request.mode === 'fuzzy') for (const r of index.relationships) if (r.type === 'contains') {
    const set = children.get(r.source.symbolId) ?? new Set<string>()
    for (const t of termsP0(byId.get(r.target.symbolId)!.name)) set.add(t)
    children.set(r.source.symbolId, set)
  }
  const matches: SymbolMatchP0[] = []
  for (const s of candidates) {
    if (request.mode !== 'fuzzy') {
      const labels = [s.name, ...(s.lexicalQualifiedName === undefined ? [] : [s.lexicalQualifiedName])]
      if (labels.some(label => request.mode === 'exact' ? label === request.name : label.startsWith(request.name))) matches.push({ ...s, match: request.mode })
    } else {
      const lower = request.name.trim().toLowerCase(), name = s.name.toLowerCase()
      let score = (name === lower ? 1000 : 0) + (name.startsWith(lower) ? 500 : 0)
      const names = new Set(termsP0(s.name)), paths = new Set(termsP0(s.path)), relations = children.get(s.symbolId)
      for (const t of queryTerms) score += (names.has(t) ? 100 : 0) + (paths.has(t) ? 40 : 0) + (relations?.has(t) ? 20 : 0)
      if (score > 0) matches.push({ ...s, match: 'fuzzy', score })
    }
  }
  matches.sort((a, b) => (request.mode === 'fuzzy' ? b.score! - a.score! : 0) || compareP0(a.path, b.path) || a.startOffset - b.startOffset || compareP0(a.symbolId, b.symbolId))
  return pageP0(index, 'symbol-query', request, matches, states, 'matches', parseSymbolQueryResultP0, s => s.path)
}
export function relationQueryP0(index: BuiltIndexP0, raw: unknown): RelationQueryResultP0 {
  const request = requestP0(parseRelationQueryRequestP0, raw)
  snapshotP0(index, request.snapshotId)
  const path = request.from.symbolId !== undefined ? symbolByIdP0(index, request.from.symbolId).path : receiptP0(index, request.from.path).path
  const filtered = index.relationships.filter(r => request.types.includes(r.type) && (request.from.symbolId !== undefined
    ? r.source.kind === 'symbol' && r.source.symbolId === request.from.symbolId
    : r.source.kind === 'file' && r.source.path === request.from.path))
  const unique = [...new Map(filtered.map(r => [canonicalJson([r.type, r.source, r.target]), r])).values()]
  unique.sort((a, b) => compareP0(a.type, b.type) || compareP0(canonicalJson(a.source), canonicalJson(b.source)) || compareP0(canonicalJson(a.target), canonicalJson(b.target)))
  return pageP0(index, 'relation-query', request, unique, index.fileExtractionStates.filter(f => f.path === path), 'relationships', parseRelationQueryResultP0, () => path)
}

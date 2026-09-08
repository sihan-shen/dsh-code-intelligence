import {
  canonicalJson, sha256Utf8, EXTRACTION_POLICY_P0, SNAPSHOT_POLICY_P0,
  parseFileExtractionStateP0, parseProviderIdentityP0, parseProvenanceP0, parseRelationshipP0,
  parseRepositorySnapshotP0, parseScanCoverageP0, parseSymbolP0,
  type ExtractionReasonP0, type FileExtractionStateP0, type ProviderIdentityP0,
  type ProvenanceP0, type RelationshipP0, type SymbolP0,
} from '@han_05/dsh-context'
import { assertOffsetRangeP0, positionAtOffsetP0 } from './p0-line-map.js'
import { checkBuildControlP0, P0ReadError } from './p0-reader.js'
import { collectSnapshotP0, type SnapshotHooksP0 } from './p0-snapshot.js'
import { createTypeScriptAstExtractorP0 } from './p0-extractor.js'
import type {
  BuildControlP0, BuiltIndexP0, CanonicalLineMapP0, CollectedFileP0,
  CollectedSnapshotP0, FileExtractionFactsP0, FileExtractorP0, LocalSymbolFactP0, SnapshotConfigP0,
} from './p0-types.js'

export type BuildFailureReasonP0 = 'contract-invalid' | 'identity-collision' | 'index-invariant' | 'provider-unavailable' | 'changed-during-read' | 'read-failed'
/** Build business failure only. Cancellation, authorization and unknown I/O keep their channels. */
export class P0BuildError extends Error {
  readonly code = 'refresh-failed' as const
  readonly details: Readonly<{ reason: BuildFailureReasonP0 }>
  constructor(readonly reason: BuildFailureReasonP0) {
    super(`Cannot build P0 index: ${reason}`)
    this.name = 'P0BuildError'
    this.details = Object.freeze({ reason })
  }
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const hash = (value: unknown): string => sha256Utf8(canonicalJson(value))
const fail = (reason: BuildFailureReasonP0 = 'contract-invalid'): never => { throw new P0BuildError(reason) }
function checked<T>(parser: (value: unknown) => T, value: unknown): T {
  try { return parser(value) } catch { return fail() }
}
function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !keys.includes(key))) fail()
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Reconstruct the single-provider provenance table entry without storing a redundant table. */
export function indexProvenanceP0(snapshotId: string, identity: ProviderIdentityP0): ProvenanceP0 {
  const provider = checked(parseProviderIdentityP0, identity)
  return freeze(checked(parseProvenanceP0, { ...provider, snapshotId, provenanceId: hash({ snapshotId, ...provider }) }))
}

function validateMap(map: CanonicalLineMapP0): void {
  record(map, ['textLength', 'lineStarts', 'surrogatePairStarts'])
  if (!Number.isSafeInteger(map.textLength) || map.textLength < 0 || !Array.isArray(map.lineStarts)
    || !Array.isArray(map.surrogatePairStarts) || map.lineStarts[0] !== 0) fail()
  for (const values of [map.lineStarts, map.surrogatePairStarts]) {
    let previous = -1
    for (const offset of values) {
      if (!Number.isSafeInteger(offset) || offset <= previous || offset < 0 || offset > map.textLength) fail()
      previous = offset
    }
  }
  for (let i = 0; i < map.surrogatePairStarts.length; i++) {
    const offset = map.surrogatePairStarts[i]
    if (offset + 1 >= map.textLength || (i > 0 && offset <= map.surrogatePairStarts[i - 1] + 1)) fail()
  }
  try { for (const offset of map.lineStarts) positionAtOffsetP0(map, offset) } catch { fail() }
}

function finalizeFile(file: CollectedFileP0, snapshotId: string, provenanceId: string, control?: BuildControlP0): {
  symbols: SymbolP0[]; relationships: RelationshipP0[]; state: FileExtractionStateP0
} {
  const { receipt, lineMap, facts } = file
  record(facts, ['path', 'sourceHash', 'eligible', 'status', 'reasons', 'diagnosticsCount', 'diagnosticSummary', 'symbols', 'relationships'])
  if (facts.path !== receipt.path || facts.sourceHash !== receipt.contentHash || !Array.isArray(facts.symbols) || !Array.isArray(facts.relationships)) fail()
  const { symbols: localSymbols, relationships: localRelations, ...rawState } = facts
  let state = checked(parseFileExtractionStateP0, { ...rawState, reasons: Array.isArray(rawState.reasons) ? [...new Set(rawState.reasons)].sort(compare) : rawState.reasons })
  if (localSymbols.length > EXTRACTION_POLICY_P0.maxSymbols || localRelations.length > EXTRACTION_POLICY_P0.maxRelations) fail()
  if (state.status === 'unsupported' || state.status === 'failed') {
    if (localSymbols.length || localRelations.length) fail()
    return { symbols: [], relationships: [], state }
  }
  validateMap(lineMap)
  const reasons = new Set<ExtractionReasonP0>(state.reasons)
  const invalid = (): void => { reasons.add('invalid-fact') }
  const locals = new Map<number, LocalSymbolFactP0>()
  const retained = new Set<number>()
  for (const symbol of localSymbols) {
    checkBuildControlP0(control)
    record(symbol, ['localId', 'parentLocalId', 'name', 'kind', 'providerKind', 'startOffset', 'endOffset'])
    if (!Number.isSafeInteger(symbol.localId) || symbol.localId < 0 || (symbol.parentLocalId !== undefined && (!Number.isSafeInteger(symbol.parentLocalId) || symbol.parentLocalId < 0))) fail()
    if (locals.has(symbol.localId)) fail('identity-collision')
    locals.set(symbol.localId, symbol)
    // Non-location schema corruption is not an isolatable position error.
    if (typeof symbol.name !== 'string') fail()
    checked(parseSymbolP0, {
      symbolId: snapshotId, path: receipt.path, sourceHash: receipt.contentHash,
      name: Buffer.byteLength(symbol.name) > EXTRACTION_POLICY_P0.maxNameBytes ? '' : symbol.name,
      kind: symbol.kind, ...(symbol.providerKind === undefined ? {} : { providerKind: symbol.providerKind }),
      startOffset: 0, endOffset: 0, start: { line: 1, column: 0 }, end: { line: 1, column: 0 }, provenanceId,
    })
    if (Buffer.byteLength(symbol.name) > EXTRACTION_POLICY_P0.maxNameBytes) { reasons.add('capacity-limit'); continue }
    try { assertOffsetRangeP0(lineMap, symbol.startOffset, symbol.endOffset) } catch { invalid(); continue }
    retained.add(symbol.localId)
  }
  // Validate the original parent graph BEFORE isolation: cycles cannot be hidden by dropping a node.
  const done = new Set<number>()
  for (const local of locals.values()) {
    const visiting = new Set<number>()
    let current: LocalSymbolFactP0 | undefined = local
    while (current && !done.has(current.localId)) {
      if (visiting.has(current.localId)) fail('index-invariant')
      visiting.add(current.localId)
      if (current.parentLocalId !== undefined && !locals.has(current.parentLocalId)) { retained.delete(current.localId); invalid() }
      current = current.parentLocalId === undefined ? undefined : locals.get(current.parentLocalId)
    }
    for (const id of visiting) done.add(id)
  }
  const parentOf = (local: LocalSymbolFactP0): number | undefined => {
    let id = local.parentLocalId
    while (id !== undefined && !retained.has(id)) id = locals.get(id)?.parentLocalId
    return id
  }
  const finalized = new Map<number, SymbolP0>()
  const qualified = new Map<number, string>()
  const depths = new Map<number, number>()
  for (const id of retained) {
    checkBuildControlP0(control)
    const chain: number[] = []
    let current: number | undefined = id
    while (current !== undefined && !finalized.has(current)) { chain.push(current); current = parentOf(locals.get(current)!) }
    if (chain.length > EXTRACTION_POLICY_P0.maxDepth) fail()
    for (const child of chain.reverse()) {
      const local = locals.get(child)!
      const parent = parentOf(local)
      const depth = parent === undefined ? 1 : depths.get(parent)! + 1
      if (depth > EXTRACTION_POLICY_P0.maxDepth) fail()
      depths.set(child, depth)
      const container = parent === undefined ? undefined : qualified.get(parent)!
      const label = container === undefined ? local.name : `${container}.${local.name}`
      qualified.set(child, label)
      const start = positionAtOffsetP0(lineMap, local.startOffset)
      const end = positionAtOffsetP0(lineMap, local.endOffset)
      finalized.set(child, checked(parseSymbolP0, {
        // V1 formula: container is the full lexical ancestor label, NOT a name lookup or ID.
        symbolId: hash([snapshotId, receipt.path, local.kind, local.name, start, end, container ?? null]),
        path: receipt.path, sourceHash: receipt.contentHash, name: local.name, kind: local.kind,
        ...(local.providerKind === undefined ? {} : { providerKind: local.providerKind }),
        ...(Buffer.byteLength(label) <= EXTRACTION_POLICY_P0.maxQualifiedNameBytes ? { lexicalQualifiedName: label } : {}),
        ...(parent === undefined ? {} : { containerId: finalized.get(parent)!.symbolId }),
        startOffset: local.startOffset, endOffset: local.endOffset, start, end, provenanceId,
      }))
    }
  }
  const relationships: RelationshipP0[] = []
  for (const relation of localRelations) {
    checkBuildControlP0(control)
    record(relation, ['type', 'source', 'target', 'resolution'])
    if (!['contains', 'imports', 'exports', 'calls'].includes(relation.type)
      || relation.resolution !== (relation.type === 'calls' ? 'heuristic' : 'syntactic')) fail()
    // Endpoint faults have an unambiguous file owner and may be isolated.
    let source: unknown
    let target: unknown
    try {
      const endpoint = (value: typeof relation.source): unknown => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError()
        if (value.kind === 'file' && Object.keys(value).length === 1) return { kind: 'file', path: receipt.path, sourceHash: receipt.contentHash }
        if (value.kind === 'symbol' && Object.keys(value).every(key => ['kind', 'localId'].includes(key))) {
          const symbol = finalized.get(value.localId)
          if (!symbol) throw new TypeError()
          return { kind: 'symbol', symbolId: symbol.symbolId }
        }
        if (value.kind === 'unresolved') return { ...value }
        throw new TypeError()
      }
      if (relation.type === 'contains' && relation.source?.kind === 'symbol' && relation.target?.kind === 'symbol'
        && !retained.has(relation.source.localId) && retained.has(relation.target.localId)) {
        const child = locals.get(relation.target.localId)!
        // Reconnect only the provider's actual parent reference after local omission.
        if (child.parentLocalId !== relation.source.localId) throw new TypeError()
        const parent = parentOf(child)
        invalid()
        if (parent === undefined) continue
        source = endpoint({ kind: 'symbol', localId: parent })
      } else source = endpoint(relation.source)
      target = endpoint(relation.target)
      relationships.push(parseRelationshipP0({ ...relation, source, target, snapshotId, provenanceId }))
    } catch {
      const targetValue = relation.target
      if (targetValue?.kind === 'unresolved' && [targetValue.name, targetValue.specifier].some(value => typeof value === 'string' && Buffer.byteLength(value) > EXTRACTION_POLICY_P0.maxNameBytes)) reasons.add('capacity-limit')
      else invalid()
    }
  }
  if (reasons.size) state = checked(parseFileExtractionStateP0, { ...state, status: 'partial', reasons: [...reasons].sort(compare) })
  return { symbols: [...finalized.values()], relationships, state }
}

/** Phase two: no filesystem, text, AST, query implementation or mutable map escapes. */
export function finalizeIndexP0(collected: CollectedSnapshotP0, identity: ProviderIdentityP0, control?: BuildControlP0): BuiltIndexP0 {
  checkBuildControlP0(control)
  record(collected, ['workspaceFingerprint', 'revision', 'files', 'scanCoverage'])
  if (!Array.isArray(collected.files)) fail()
  const files = [...collected.files]
  for (const file of files) record(file, ['receipt', 'lineMap', 'facts'])
  // Validate receipts before sorting/accessing their fields.
  const provisional = checked(parseRepositorySnapshotP0, {
    schemaVersion: 'p0', snapshotId: hash(null), workspaceFingerprint: collected.workspaceFingerprint,
    revision: collected.revision, files: files.map(file => file.receipt),
  })
  const receipts = [...provisional.files].sort((a, b) => compare(a.path, b.path))
  if (new Set(receipts.map(file => file.path)).size !== receipts.length) fail('index-invariant')
  const snapshot = checked(parseRepositorySnapshotP0, {
    ...provisional, files: receipts,
    snapshotId: hash({ schemaVersion: 'p0', workspaceFingerprint: provisional.workspaceFingerprint, revision: provisional.revision, files: receipts, policyVersion: SNAPSHOT_POLICY_P0.policyVersion }),
  })
  const provenance = indexProvenanceP0(snapshot.snapshotId, identity)
  const { snapshotId: _snapshot, provenanceId: _provenance, ...providerConfigIdentity } = provenance
  const scanCoverage = checked(parseScanCoverageP0, collected.scanCoverage)
  if (scanCoverage.receiptFiles !== receipts.length || scanCoverage.receiptBytes !== receipts.reduce((sum, file) => sum + file.byteLength, 0)) fail('index-invariant')
  const symbols: SymbolP0[] = []
  const relationships: RelationshipP0[] = []
  const fileExtractionStates: FileExtractionStateP0[] = []
  for (const file of files) {
    checkBuildControlP0(control)
    const result = finalizeFile(file, snapshot.snapshotId, provenance.provenanceId, control)
    symbols.push(...result.symbols)
    relationships.push(...result.relationships)
    fileExtractionStates.push(result.state)
  }
  checkBuildControlP0(control)
  const byId = new Map<string, SymbolP0>()
  for (const symbol of symbols) {
    checkBuildControlP0(control)
    if (byId.has(symbol.symbolId)) fail('identity-collision')
    byId.set(symbol.symbolId, symbol)
  }
  const contains = new Set<string>()
  for (const relation of relationships) {
    checkBuildControlP0(control)
    if (relation.type !== 'contains') continue
    const parent = byId.get(relation.source.symbolId)
    const child = byId.get(relation.target.symbolId)
    if (!parent || !child || parent.path !== child.path || parent.sourceHash !== child.sourceHash || child.containerId !== parent.symbolId
      || parent.startOffset > child.startOffset || parent.endOffset < child.endOffset) fail('index-invariant')
    contains.add(relation.target.symbolId)
  }
  const states = new Map(fileExtractionStates.map(state => [state.path, state]))
  for (const symbol of symbols) {
    checkBuildControlP0(control)
    if (!symbol.containerId) continue
    const parent = byId.get(symbol.containerId)
    if (!parent || parent.path !== symbol.path || parent.startOffset > symbol.startOffset || parent.endOffset < symbol.endOffset) fail('index-invariant')
    const state = states.get(symbol.path)!
    // Explicitly incomplete extraction may omit a contains edge, never invent one to fill a gap.
    if (!contains.has(symbol.symbolId) && !state.reasons.some(reason => reason === 'capacity-limit' || reason === 'invalid-fact')) fail('index-invariant')
  }
  symbols.sort((a, b) => compare(a.path, b.path) || a.startOffset - b.startOffset || compare(a.symbolId, b.symbolId))
  const relationKey = (edge: RelationshipP0): string => canonicalJson([edge.type, edge.source, edge.target])
  const uniqueRelations = [...new Map(relationships.map(edge => [relationKey(edge), edge])).values()]
  uniqueRelations.sort((a, b) => compare(a.type, b.type) || compare(canonicalJson(a.source), canonicalJson(b.source)) || compare(canonicalJson(a.target), canonicalJson(b.target)))
  fileExtractionStates.sort((a, b) => compare(a.path, b.path) || compare(a.sourceHash, b.sourceHash))
  checkBuildControlP0(control)
  const indexFingerprint = hash({
    schema: 'dsh-index-fingerprint-v1', providerConfigIdentity,
    normalizedFacts: { snapshot, symbols, relationships: uniqueRelations, scanCoverage }, fileExtractionStates,
  })
  const result = freeze({ snapshot, indexFingerprint, providerConfigIdentity, symbols, relationships: uniqueRelations, fileExtractionStates, scanCoverage })
  checkBuildControlP0(control)
  return result
}

export type BuildIndexOptionsP0 = {
  readonly extractor?: FileExtractorP0
  readonly control?: BuildControlP0
  readonly hooks?: SnapshotHooksP0
}

function preserveControlOrRead(error: unknown, control?: BuildControlP0): void {
  checkBuildControlP0(control)
  if (error instanceof P0ReadError || error instanceof P0BuildError
    || (error instanceof Error && (['AbortError', 'TimeoutError'].includes(error.name)
      || /^E[A-Z]+$/.test((error as NodeJS.ErrnoException).code ?? '')))) throw error
}

/** One attempt only; M3 owns retries, leases and publication. Reader/scanner own cleanup. */
export async function buildIndexP0(config: SnapshotConfigP0, options: BuildIndexOptionsP0 = {}): Promise<BuiltIndexP0> {
  const { control, hooks } = options
  const extractor = options.extractor ?? createTypeScriptAstExtractorP0()
  checkBuildControlP0(control)
  const identity = freeze(checked(parseProviderIdentityP0, extractor.identity))
  const guarded: FileExtractorP0 = {
    identity,
    supports: file => extractor.supports(file),
    async extract(file, extractionControl): Promise<FileExtractionFactsP0> {
      checkBuildControlP0(extractionControl)
      let eligible: boolean
      try { eligible = extractor.supports(file.receipt) } catch (error) {
        preserveControlOrRead(error, extractionControl)
        return fail('provider-unavailable')
      }
      if (typeof eligible !== 'boolean') fail()
      const base = { path: file.receipt.path, sourceHash: file.receipt.contentHash, eligible, diagnosticsCount: 0, symbols: [], relationships: [] }
      if (!eligible) return { ...base, status: 'unsupported', reasons: [] }
      let facts: FileExtractionFactsP0
      try { facts = await extractor.extract(file, extractionControl) } catch (error) {
        preserveControlOrRead(error, extractionControl)
        // The verified receipt remains trustworthy; raw exception text is never persisted.
        return { ...base, status: 'failed', reasons: ['extraction-failed'] }
      }
      checkBuildControlP0(extractionControl)
      if (!facts || facts.eligible !== eligible) fail()
      return facts
    },
  }
  try {
    const collected = await collectSnapshotP0(config, guarded, control, hooks)
    checkBuildControlP0(control)
    return finalizeIndexP0(collected, identity, control)
  } catch (error) {
    checkBuildControlP0(control)
    if (error instanceof P0ReadError && error.code === 'stale-source') {
      throw new P0BuildError(error.reason === 'changed-during-read' || error.reason === 'current-file-missing' || error.reason === 'content-hash-mismatch' ? 'changed-during-read' : 'read-failed')
    }
    throw error
  }
}

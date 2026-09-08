import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalJson, sha256Utf8, SNAPSHOT_POLICY_P0, EXTRACTION_POLICY_P0, parseCodeIntelligenceFailureP0,
  parseSymbolP0, parseRelationshipP0, parseSymbolQueryRequestP0, parseRelationQueryRequestP0,
  type ProviderIdentityP0,
} from '@han_05/dsh-context'
import { buildIndexP0, finalizeIndexP0, indexProvenanceP0, P0BuildError } from '../src/p0-build.js'
import { parseSnapshotConfigP0 } from '../src/p0-snapshot.js'
import { P0ReadError } from '../src/p0-reader.js'
import { createTypeScriptAstExtractorP0 } from '../src/p0-extractor.js'
import { createCanonicalLineMapP0 } from '../src/p0-line-map.js'
import type { CollectedFileP0, CollectedSnapshotP0, FileExtractionFactsP0, FileExtractorP0, LocalSymbolFactP0 } from '../src/p0-types.js'

const identity: ProviderIdentityP0 = { providerId: 'fixture', providerVersion: '1', extractionConfigVersion: '1', typescriptVersion: '5.9.3' }
const digest = (value: unknown) => sha256Utf8(canonicalJson(value))
const text = 'class A { method() { const value = 1 } }\r\n// 😀\u2028'
const local = (localId: number, name: string, startOffset: number, endOffset: number, parentLocalId?: number): LocalSymbolFactP0 => ({ localId, name, kind: 'variable', startOffset, endOffset, ...(parentLocalId === undefined ? {} : { parentLocalId }) })
function file(path = 'a.ts', overrides: Partial<FileExtractionFactsP0> = {}): CollectedFileP0 {
  const receipt = { path, contentHash: sha256Utf8(text), byteLength: Buffer.byteLength(text), language: 'typescript' }
  return { receipt, lineMap: createCanonicalLineMapP0(text), facts: {
    path, sourceHash: receipt.contentHash, eligible: true, status: 'complete', reasons: [], diagnosticsCount: 0,
    symbols: [local(10, 'A', 0, 39), local(20, 'method', 10, 37, 10), local(30, 'value', 21, 36, 20)],
    relationships: [
      { type: 'contains', source: { kind: 'symbol', localId: 10 }, target: { kind: 'symbol', localId: 20 }, resolution: 'syntactic' },
      { type: 'contains', source: { kind: 'symbol', localId: 20 }, target: { kind: 'symbol', localId: 30 }, resolution: 'syntactic' },
      { type: 'calls', source: { kind: 'file' }, target: { kind: 'unresolved', name: 'run' }, resolution: 'heuristic' },
    ], ...overrides,
  } }
}
function collection(files: readonly CollectedFileP0[] = [file()]): CollectedSnapshotP0 {
  return { workspaceFingerprint: sha256Utf8('/fixture'), revision: 'r1', files, scanCoverage: {
    openedDirectories: 1, observedEntries: files.length, candidateFiles: files.length, receiptFiles: files.length,
    receiptBytes: files.reduce((sum, f) => sum + f.receipt.byteLength, 0),
    skipped: { 'excluded-by-policy': 0, 'unsupported-format': 0, 'file-too-large': 0 },
  } }
}
const build = (files?: readonly CollectedFileP0[]) => finalizeIndexP0(collection(files), identity)
function allFrozen(value: unknown): void {
  if (!value || typeof value !== 'object') return
  expect(Object.isFrozen(value)).toBe(true)
  expect(value instanceof Map).toBe(false)
  for (const child of Object.values(value)) allFrozen(child)
}
const roots: string[] = []
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'p0-build-'))
  roots.push(root)
  await Promise.all([writeFile(join(root, 'a.ts'), text), writeFile(join(root, 'b.json'), '{}')])
  return parseSnapshotConfigP0({ deploymentRoot: root, revision: 'test' })
}
const fixtureExtractor: FileExtractorP0 = {
  identity, supports: receipt => receipt.path.endsWith('.ts'),
  extract: source => file(source.receipt.path, { sourceHash: source.receipt.contentHash }).facts,
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('P0 immutable two-phase finalizer', () => {
  it('binds receipts, canonical coordinates, parent-based P0 IDs and provenance; publishes only deeply frozen DTOs', () => {
    const input = collection()
    const result = finalizeIndexP0(input, identity)
    expect(result.snapshot.snapshotId).toBe(digest({ schemaVersion: 'p0', workspaceFingerprint: input.workspaceFingerprint, revision: input.revision, files: result.snapshot.files, policyVersion: SNAPSHOT_POLICY_P0.policyVersion }))
    const parent = result.symbols.find(s => s.name === 'method')!
    const child = result.symbols.find(s => s.name === 'value')!
    expect(child.lexicalQualifiedName).toBe('A.method.value')
    expect(child.containerId).toBe(parent.symbolId)
    for (const symbol of result.symbols) {
      expect(symbol.symbolId).toBe(digest(['dsh-symbol-p0-v2', result.snapshot.snapshotId, symbol.path,
        symbol.kind, symbol.name, symbol.startOffset, symbol.endOffset, symbol.containerId ?? null]))
    }
    const oldIds = result.symbols.map(symbol => digest([result.snapshot.snapshotId, symbol.path,
      symbol.kind, symbol.name, symbol.start, symbol.end,
      symbol.name === 'A' ? null : symbol.name === 'method' ? 'A' : 'A.method']))
    expect(result.symbols.every(symbol => !oldIds.includes(symbol.symbolId))).toBe(true)
    expect(child.provenanceId).toBe(indexProvenanceP0(result.snapshot.snapshotId, identity).provenanceId)
    expect(result.relationships).toContainEqual({ snapshotId: result.snapshot.snapshotId, provenanceId: child.provenanceId, type: 'contains', source: { kind: 'symbol', symbolId: parent.symbolId }, target: { kind: 'symbol', symbolId: child.symbolId }, resolution: 'syntactic' })
    for (const symbol of result.symbols) { expect(parseSymbolP0(symbol)).toEqual(symbol); expect(symbol).not.toHaveProperty('score') }
    for (const edge of result.relationships) expect(parseRelationshipP0(edge)).toEqual(edge)
    allFrozen(result)
    expect(Object.isFrozen(input.files[0].receipt)).toBe(false)
    expect(() => { (result.symbols[0].start as { line: number }).line = 99 }).toThrow()
  })

  it('is invariant to file/fact order, local ref numbering, reason order and duplicate summary edges', () => {
    const a = file('a.ts', { status: 'partial', reasons: ['invalid-fact', 'capacity-limit'] })
    const b = file('b.ts')
    const permuted = { ...a, facts: { ...a.facts, reasons: ['capacity-limit', 'invalid-fact', 'capacity-limit'] as const,
      symbols: [...a.facts.symbols].reverse().map(s => ({ ...s, localId: s.localId + 100, ...(s.parentLocalId === undefined ? {} : { parentLocalId: s.parentLocalId + 100 }) })),
      relationships: [...a.facts.relationships, a.facts.relationships[2]].reverse().map(r => ({ ...r,
        source: r.source.kind === 'symbol' ? { ...r.source, localId: r.source.localId + 100 } : r.source,
        target: r.target.kind === 'symbol' ? { ...r.target, localId: r.target.localId + 100 } : r.target,
      })),
    } }
    expect(build([b, permuted])).toEqual(build([a, b]))
  })

  it('binds snapshot identity to revision/receipts and index identity to provider/config/TS version', () => {
    const input = collection()
    const initial = finalizeIndexP0(input, identity)
    for (const key of ['providerVersion', 'extractionConfigVersion', 'typescriptVersion'] as const) {
      const changed = finalizeIndexP0(input, { ...identity, [key]: 'next' })
      expect(changed.snapshot).toEqual(initial.snapshot)
      expect(changed.symbols.map(s => s.symbolId)).toEqual(initial.symbols.map(s => s.symbolId))
      expect(changed.indexFingerprint).not.toBe(initial.indexFingerprint)
      expect(changed.symbols[0].provenanceId).not.toBe(initial.symbols[0].provenanceId)
    }
    const revised = finalizeIndexP0({ ...input, revision: 'r2' }, identity)
    expect(revised.snapshot.snapshotId).not.toBe(initial.snapshot.snapshotId)
    expect(revised.symbols[0].symbolId).not.toBe(initial.symbols[0].symbolId)
    const newHash = sha256Utf8('edited')
    const changed = file()
    const edited = build([{ ...changed, receipt: { ...changed.receipt, contentHash: newHash }, facts: { ...changed.facts, sourceHash: newHash } }])
    expect(edited.snapshot.snapshotId).not.toBe(initial.snapshot.snapshotId)
  })

  it('fingerprints same-receipt complete/partial/failed/unsupported membership, diagnostics and coverage changes', () => {
    const states: Partial<FileExtractionFactsP0>[] = [
      {}, { status: 'partial', reasons: ['capacity-limit'] },
      { status: 'partial', reasons: ['syntax-diagnostics'], diagnosticsCount: 1 },
      { status: 'partial', reasons: ['syntax-diagnostics'], diagnosticsCount: 2 },
      { status: 'partial', reasons: ['syntax-diagnostics'], diagnosticsCount: 2, diagnosticSummary: 'syntax errors' },
      { status: 'failed', reasons: ['extraction-failed'] }, { status: 'unsupported', eligible: false },
    ]
    const results = states.map(state => build([file('a.ts', { symbols: [], relationships: [], ...state })]))
    expect(new Set(results.map(r => r.snapshot.snapshotId)).size).toBe(1)
    expect(new Set(results.map(r => r.indexFingerprint)).size).toBe(states.length)
    const input = collection()
    expect(finalizeIndexP0({ ...input, scanCoverage: { ...input.scanCoverage, observedEntries: 2 } }, identity).indexFingerprint).not.toBe(build().indexFingerprint)
  })

  it('versions even empty indexes independently of receipt and provider identity', () => {
    const result = build([])
    const oldFingerprint = digest({ schema: 'dsh-index-fingerprint-v1', providerConfigIdentity: identity,
      normalizedFacts: { snapshot: result.snapshot, symbols: [], relationships: [], scanCoverage: result.scanCoverage }, fileExtractionStates: [],
    })
    expect(result.indexFingerprint).not.toBe(oldFingerprint)
    expect(result.indexFingerprint).toBe(digest({ schema: 'dsh-index-fingerprint-v2',
      indexPolicy: { policyVersion: 'dsh-index-p0-v2', symbolIdVersion: 'dsh-symbol-p0-v2' }, providerConfigIdentity: identity,
      normalizedFacts: { snapshot: result.snapshot, symbols: [], relationships: [], scanCoverage: result.scanCoverage }, fileExtractionStates: [],
    }))
    expect(result.providerConfigIdentity).toEqual(identity) // AST coverage did not change.
  })

  it('isolates invalid positions/surrogate endpoints and dangling relation endpoints without losing receipts', () => {
    const original = file()
    const input = file('a.ts', { symbols: [...original.facts.symbols, local(40, 'bad', text.indexOf('😀') + 1, text.length)],
      relationships: [...original.facts.relationships, { type: 'contains', source: { kind: 'symbol', localId: 10 }, target: { kind: 'symbol', localId: 404 }, resolution: 'syntactic' }],
    })
    const result = build([input])
    expect(result.symbols).toHaveLength(3)
    expect(result.relationships).toHaveLength(3)
    expect(result.fileExtractionStates[0]).toMatchObject({ status: 'partial', reasons: ['invalid-fact'] })
    expect(result.snapshot.files).toHaveLength(1)
  })

  it('reparents valid descendants after omitting an invalid ancestor using the original refs', () => {
    const input = file()
    const result = build([{ ...input, facts: { ...input.facts, symbols: input.facts.symbols.map(s => s.localId === 20 ? { ...s, endOffset: text.length + 1 } : s) } }])
    const child = result.symbols.find(s => s.name === 'value')!
    const parent = result.symbols.find(s => s.name === 'A')!
    expect(child.containerId).toBe(parent.symbolId)
    expect(child.lexicalQualifiedName).toBe('A.value')
    expect(result.relationships).toContainEqual({ type: 'contains', snapshotId: result.snapshot.snapshotId, provenanceId: child.provenanceId, source: { kind: 'symbol', symbolId: parent.symbolId }, target: { kind: 'symbol', symbolId: child.symbolId }, resolution: 'syntactic' })
    expect(result.fileExtractionStates[0].status).toBe('partial')
  })

  it('omits whole overlong names and optional qualified labels rather than truncating facts', () => {
    const result = build([file('a.ts', { symbols: [local(1, 'a'.repeat(4096), 0, 39), local(2, 'child', 1, 2, 1), local(3, '界'.repeat(1366), 3, 4)],
      relationships: [{ type: 'contains', source: { kind: 'symbol', localId: 1 }, target: { kind: 'symbol', localId: 2 }, resolution: 'syntactic' }],
    })])
    expect(result.symbols).toHaveLength(2)
    expect(result.symbols[1].name).toBe('child')
    expect(result.symbols[1]).not.toHaveProperty('lexicalQualifiedName')
    expect(result.fileExtractionStates[0]).toMatchObject({ status: 'partial', reasons: ['capacity-limit'] })
  })

  it.each(['a'.repeat(4094), '界'.repeat(1364) + 'ab'])('bounds qualified labels by UTF-8 bytes without restarting an omitted ancestor chain', name => {
    const input = file('a.ts', {
      symbols: [local(1, name, 0, 39), local(2, '', 1, 38, 1), local(3, '', 2, 37, 2), local(4, '', 3, 36, 3), local(5, 'leaf', 4, 35, 4)],
      relationships: [2, 3, 4, 5].map(id => ({ type: 'contains', source: { kind: 'symbol', localId: id - 1 }, target: { kind: 'symbol', localId: id }, resolution: 'syntactic' })),
    })
    const result = build([input])
    expect(result.fileExtractionStates[0].status).toBe('complete')
    expect(result.symbols.slice(0, 3).map(symbol => symbol.lexicalQualifiedName)).toEqual([name, `${name}.`, `${name}..`])
    expect(result.symbols.slice(3).every(symbol => symbol.lexicalQualifiedName === undefined)).toBe(true)
    expect(result.symbols.every(symbol => symbol.lexicalQualifiedName === undefined || Buffer.byteLength(symbol.lexicalQualifiedName) <= 4096)).toBe(true)
    for (const symbol of result.symbols) expect(symbol.symbolId).toBe(digest(['dsh-symbol-p0-v2', result.snapshot.snapshotId,
      symbol.path, symbol.kind, symbol.name, symbol.startOffset, symbol.endOffset, symbol.containerId ?? null]))
  })

  it('binds descendants to the actual parent identity, not an ambiguous lexical label', () => {
    const input = file('a.ts', {
      symbols: [local(1, 'A', 0, 39), local(2, 'B', 1, 38, 1), local(3, 'A.B', 0, 39), local(4, 'x', 3, 4, 2), local(5, 'x', 3, 4, 3)],
      relationships: [[1, 2], [2, 4], [3, 5]].map(([parent, child]) => ({ type: 'contains', source: { kind: 'symbol', localId: parent }, target: { kind: 'symbol', localId: child }, resolution: 'syntactic' })),
    })
    const result = build([input])
    const children = result.symbols.filter(symbol => symbol.name === 'x')
    expect(children.map(symbol => symbol.lexicalQualifiedName)).toEqual(['A.B.x', 'A.B.x'])
    expect(new Set(children.map(symbol => symbol.symbolId)).size).toBe(2)
    expect(new Set(children.map(symbol => symbol.containerId)).size).toBe(2)
  })

  it('propagates parent identity changes without changing receipts or lexical query labels', () => {
    const input = file()
    const before = build([input])
    const changed = build([{ ...input, facts: { ...input.facts,
      symbols: input.facts.symbols.map(symbol => symbol.localId === 10 ? { ...symbol, kind: 'class' as const } : symbol),
    } }])
    expect(changed.snapshot).toEqual(before.snapshot)
    expect(changed.symbols.map(symbol => symbol.lexicalQualifiedName)).toEqual(before.symbols.map(symbol => symbol.lexicalQualifiedName))
    expect(changed.symbols.every(symbol => !before.symbols.some(old => old.symbolId === symbol.symbolId))).toBe(true)
    expect(changed.fileExtractionStates).toEqual(before.fileExtractionStates)
    expect(changed.indexFingerprint).not.toBe(before.indexFingerprint)
  })

  it('keeps maximum-depth long-name facts complete without storing expanded ancestry', () => {
    const count = EXTRACTION_POLICY_P0.maxDepth
    const input = file('a.ts', {
      symbols: Array.from({ length: count }, (_, i) => local(i, 'n'.repeat(4096), 0, 39, i ? i - 1 : undefined)),
      relationships: Array.from({ length: count - 1 }, (_, i) => ({ type: 'contains', source: { kind: 'symbol', localId: i }, target: { kind: 'symbol', localId: i + 1 }, resolution: 'syntactic' })),
    })
    const result = build([input])
    expect(result.fileExtractionStates[0].status).toBe('complete')
    expect(result.symbols).toHaveLength(count)
    expect(result.relationships).toHaveLength(count - 1)
    expect(result.symbols.filter(symbol => symbol.lexicalQualifiedName !== undefined)).toHaveLength(1)
    expect(new Set(result.symbols.map(symbol => symbol.symbolId)).size).toBe(count)
  })

  it('rejects identity collisions, malformed top-level output and global parent/contains inconsistencies', () => {
    const source = file()
    const corruptions = [
      file('a.ts', { symbols: [...source.facts.symbols, { ...source.facts.symbols[0], localId: 11 }] }),
      file('a.ts', { symbols: [...source.facts.symbols, source.facts.symbols[0]] }),
      file('a.ts', { symbols: [local(1, 'cycle', 0, 39, 2), local(2, 'cycle', 0, 39, 1)], relationships: [] }),
      file('a.ts', { sourceHash: sha256Utf8('wrong') }),
      file('a.ts', { symbols: null as never }),
      file('a.ts', { relationships: [] }),
      file('a.ts', { relationships: [{ type: 'contains', source: { kind: 'symbol', localId: 10 }, target: { kind: 'symbol', localId: 30 }, resolution: 'syntactic' }] }),
    ]
    for (const corrupt of corruptions) {
      try { build([corrupt]); expect.fail('invalid candidate published') } catch (error) {
        expect(error).toBeInstanceOf(P0BuildError)
        const e = error as P0BuildError
        expect(parseCodeIntelligenceFailureP0({ code: e.code, message: e.message, details: e.details }).code).toBe('refresh-failed')
      }
    }
  })

  it('preserves control flow before and during finalization', () => {
    const abort = new AbortController()
    const reason = new Error('cancelled')
    abort.abort(reason)
    expect(() => finalizeIndexP0(collection(), identity, { signal: abort.signal })).toThrow(reason)
    expect(() => finalizeIndexP0(collection(), identity, { deadlineMs: 0 })).toThrow(expect.objectContaining({ name: 'TimeoutError' }))
    const during = new AbortController()
    const provider = { ...identity, get providerVersion() { during.abort(reason); return '1' } }
    expect(() => finalizeIndexP0(collection(), provider, { signal: during.signal })).toThrow(reason)
  })

  it('builds the real repository fixture with default F3/F4, including TS/JS provenance and export/call facts', async () => {
    const config = parseSnapshotConfigP0({ deploymentRoot: fileURLToPath(new URL('./fixtures/repository', import.meta.url)), revision: 'fixture' })
    const result = await buildIndexP0(config)
    expect(result.symbols.map(s => [s.path, s.name, s.kind, s.start])).toEqual([
      ['src/auth.ts', 'authenticate', 'function', { line: 1, column: 0 }],
      ['src/service.js', 'serve', 'function', { line: 1, column: 0 }],
    ])
    expect(result.providerConfigIdentity.typescriptVersion).toBe(ts.version)
    expect(result.relationships.map(r => [r.type, r.target])).toEqual([
      ['calls', { kind: 'unresolved', name: 'authenticate' }],
      ['exports', { kind: 'unresolved', name: 'authenticate' }],
      ['exports', { kind: 'unresolved', name: 'serve' }],
    ])
    expect(result.fileExtractionStates.filter(s => s.eligible).every(s => s.status === 'complete')).toBe(true)
    expect(result.fileExtractionStates.find(s => s.path === '.gitignore')).toMatchObject({ eligible: false, status: 'unsupported' })
    expect(await buildIndexP0(config)).toEqual(result)
  })

  it('finalizes the sampled ignore version unchanged and applies edits only on the next build', async () => {
    const initial = await workspace()
    const config = parseSnapshotConfigP0({ ...initial, maxFileBytes: 60 })
    const ignore = join(config.deploymentRoot, '.gitignore')
    await writeFile(ignore, 'b.json\n# initial\n')
    const baseline = await buildIndexP0(config)
    let reads = 0
    const sampled = await buildIndexP0(config, { hooks: { readerHooks: {
      afterClose: async path => {
        if (path === ignore && ++reads === 1) await writeFile(path, 'a.ts\n' + '#'.repeat(80))
      },
    } } })
    expect(reads).toBe(1)
    expect(sampled).toEqual(baseline) // Includes snapshotId, indexFingerprint, facts and coverage.
    expect(sampled.snapshot.files.map(file => file.path)).toEqual(['.gitignore', 'a.ts'])
    expect(sampled.symbols).toHaveLength(3)
    const next = await buildIndexP0(config)
    expect(next.snapshot.files.map(file => file.path)).toEqual(['b.json'])
    expect(next.symbols).toEqual([])
    expect(next.snapshot.snapshotId).not.toBe(sampled.snapshot.snapshotId)
    expect(next.indexFingerprint).not.toBe(sampled.indexFingerprint)
  })

  it('connects real nested declarations by local refs, not repeated names, including variable-bound expressions', async () => {
    const config = await workspace()
    await writeFile(join(config.deploymentRoot, 'a.ts'), [
      'namespace Outer { export class A { method() { const value = 1 } }',
      'export class B { method() { const value = 2 } }',
      'const factory = () => { function nested() { const value = 3 } }; }',
    ].join('\u2028'))
    const reads: string[] = []
    const result = await buildIndexP0(config, { hooks: { readerHooks: { afterRead(path) { reads.push(path) } } } })
    expect(reads.filter(path => path.endsWith('/a.ts'))).toHaveLength(1)
    expect(result.fileExtractionStates[0].status).toBe('complete')
    expect(result.symbols.filter(s => s.name === 'value').map(s => s.lexicalQualifiedName)).toEqual([
      'Outer.A.method.value', 'Outer.B.method.value', 'Outer.factory.nested.value',
    ])
    for (const symbol of result.symbols.filter(s => s.containerId)) {
      const edge = result.relationships.find(r => r.type === 'contains' && r.target.symbolId === symbol.symbolId)
      expect(edge?.source).toEqual({ kind: 'symbol', symbolId: symbol.containerId })
    }
  })

  it('accepts real capacity-limited contains omission as partial without fabricating edges', async () => {
    const config = await workspace()
    const result = await buildIndexP0(config, { extractor: createTypeScriptAstExtractorP0({ maxRelations: 1 }) })
    expect(result.symbols).toHaveLength(3)
    expect(result.relationships).toHaveLength(1)
    expect(result.fileExtractionStates[0]).toMatchObject({ eligible: true, status: 'partial', reasons: ['capacity-limit'] })
    expect(result.symbols.filter(s => s.containerId)).toHaveLength(2)
  })

  it('collects receipts and facts from one read and keeps static unsupported membership', async () => {
    const config = await workspace()
    const reads: string[] = []
    const extracts: string[] = []
    const result = await buildIndexP0(config, {
      extractor: { ...fixtureExtractor, extract(source) {
        extracts.push(source.receipt.path)
        expect(source.receipt.contentHash).toBe(sha256Utf8(source.text))
        return fixtureExtractor.extract(source)
      } },
      hooks: { readerHooks: { afterRead(path) { reads.push(path) } } },
    })
    expect(reads.map(path => path.split('/').at(-1)).sort()).toEqual(['a.ts', 'b.json'])
    expect(extracts).toEqual(['a.ts'])
    expect(result.fileExtractionStates.map(s => [s.path, s.eligible, s.status])).toEqual([['a.ts', true, 'complete'], ['b.json', false, 'unsupported']])
    expect(result.snapshot.files).toHaveLength(2)
  })

  it('isolates only per-file extraction exceptions, not read/provider/control failures', async () => {
    const config = await workspace()
    const first = await buildIndexP0(config, { extractor: { ...fixtureExtractor, extract() { throw new Error('/secret/random detail 1') } } })
    const second = await buildIndexP0(config, { extractor: { ...fixtureExtractor, extract() { throw new Error('/different detail 2') } } })
    expect(first).toEqual(second)
    expect(first.symbols).toEqual([])
    expect(first.fileExtractionStates[0]).toMatchObject({ eligible: true, status: 'failed', reasons: ['extraction-failed'] })
    expect(JSON.stringify(first)).not.toContain('secret')
    await expect(buildIndexP0(config, { extractor: { ...fixtureExtractor, supports() { throw new Error('provider unavailable') } } })).rejects.toMatchObject({ code: 'refresh-failed', reason: 'provider-unavailable' })
    await expect(buildIndexP0(config, { extractor: fixtureExtractor, hooks: { reader: async () => { throw new P0ReadError('stale-source', 'current-file-missing') } } })).rejects.toMatchObject({ code: 'refresh-failed', reason: 'changed-during-read' })
    const io = Object.assign(new Error('unexpected I/O'), { code: 'EIO' })
    await expect(buildIndexP0(config, { extractor: fixtureExtractor, hooks: { reader: async () => { throw io } } })).rejects.toBe(io)
    await expect(buildIndexP0(config, { extractor: { ...fixtureExtractor, extract() { throw io } } })).rejects.toBe(io)
    await expect(buildIndexP0(config, { extractor: { ...fixtureExtractor, extract() { return null as never } } })).rejects.toMatchObject({ reason: 'contract-invalid' })
    const abort = new AbortController()
    const reason = new Error('cancel extraction')
    await expect(buildIndexP0(config, { control: { signal: abort.signal }, extractor: { ...fixtureExtractor, extract() { abort.abort(reason); throw reason } } })).rejects.toBe(reason)
  })

  it('uses shared query parser defaults/bounds without executing query implementations', () => {
    const snapshotId = build().snapshot.snapshotId
    expect(parseSymbolQueryRequestP0({ snapshotId, name: 'value' })).toMatchObject({ mode: 'exact', limit: 20, pathPrefix: '' })
    expect(() => parseSymbolQueryRequestP0({ snapshotId, name: '界'.repeat(86) })).toThrow(TypeError)
    expect(() => parseSymbolQueryRequestP0({ snapshotId, symbolId: snapshotId, limit: 1 })).toThrow(TypeError)
    expect(() => parseRelationQueryRequestP0({ snapshotId, from: { path: 'a.ts' }, limit: 51 })).toThrow(TypeError)
    expect(parseRelationQueryRequestP0({ snapshotId, from: { path: 'a.ts' }, types: [] }).types).toEqual([])
  })
})

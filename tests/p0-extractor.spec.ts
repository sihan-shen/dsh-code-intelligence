import { describe, expect, it } from 'vitest'
import { sha256Utf8, type RepoFileSummaryP0 } from '@han_05/dsh-context'
import { createTypeScriptAstExtractorP0, TypeScriptAstExtractorP0 } from '../src/p0-extractor.ts'
import type { FileExtractionFactsP0, VerifiedFileP0 } from '../src/p0-types.ts'

function verified(path: string, text: string): VerifiedFileP0 {
  const receipt: RepoFileSummaryP0 = Object.freeze({
    path,
    contentHash: sha256Utf8(text),
    byteLength: new TextEncoder().encode(text).byteLength,
    language: /\.[cm]?tsx?$/u.test(path) ? 'typescript' : 'javascript',
  })
  return Object.freeze({
    receipt,
    text,
    lineMap: Object.freeze({ textLength: text.length, lineStarts: Object.freeze([0]), surrogatePairStarts: Object.freeze([]) }),
  })
}

function symbols(result: FileExtractionFactsP0, name: string) {
  return result.symbols.filter(symbol => symbol.name === name)
}

function relations(result: FileExtractionFactsP0, type: string) {
  return result.relationships.filter(relation => relation.type === type)
}

function parentName(result: FileExtractionFactsP0, name: string): string | undefined {
  const symbol = result.symbols.find(candidate => candidate.name === name)
  return result.symbols.find(candidate => candidate.localId === symbol?.parentLocalId)?.name
}

describe('TypeScriptAstExtractorP0 declarations', () => {
  it('collects non-exported, nested, destructured, overload and member declarations with local parent refs', () => {
    const source = [
      'const plain = 1, { key: renamed, nested: { leaf }, ...rest } = input, [first, , third] = list',
      'function outer() {',
      '  const holder = () => { class ArrowInner {} }',
      '  const expression = function namedExpression() { interface InsideExpression { value: string } }',
      '  const classHolder = class NamedExpressionClass { method(): void; method() {} }',
      '  function overloaded(value: string): string',
      '  function overloaded(value: number): string { return String(value) }',
      '}',
      'interface Shape { readonly field: string; run(value: string): void; get size(): number }',
      'class Container { #secret = 1; static ["literal"]() {}; [1]: string; [""]() {}; [dynamic](): void {} }',
      'enum Mode { One, "two" = 2, ["three"] = 3 }',
      'namespace Space { export const local = 1; export function work() {} }',
      'export default class { anonymousMember() {} }',
    ].join('\n')
    const extractor = createTypeScriptAstExtractorP0()
    const result = extractor.extract(verified('src/main.ts', source)) as FileExtractionFactsP0

    expect(result.status).toBe('complete')
    expect(result.symbols.map(symbol => symbol.name)).toEqual(expect.arrayContaining([
      'plain', 'renamed', 'leaf', 'rest', 'first', 'third', 'outer', 'holder', 'ArrowInner',
      'expression', 'InsideExpression', 'classHolder', 'method', 'overloaded', 'Shape', 'field',
      'run', 'size', 'Container', '#secret', 'literal', '1', '', 'Mode', 'One', 'two', 'three',
      'Space', 'local', 'work', 'anonymousMember',
    ]))
    expect(result.symbols.some(symbol => symbol.name === 'key' || symbol.name === 'nested' || symbol.name === 'namedExpression' || symbol.name === 'NamedExpressionClass' || symbol.name === 'dynamic')).toBe(false)
    expect(symbols(result, 'overloaded')).toHaveLength(2)
    expect(symbols(result, 'method')).toHaveLength(2)
    expect(parentName(result, 'ArrowInner')).toBe('holder')
    expect(parentName(result, 'InsideExpression')).toBe('expression')
    expect(parentName(result, 'anonymousMember')).toBeUndefined()
    expect(parentName(result, 'leaf')).toBeUndefined()

    for (const symbol of result.symbols) {
      expect(source.slice(symbol.startOffset, symbol.endOffset).length).toBeGreaterThan(0)
      if (symbol.parentLocalId !== undefined) expect(result.symbols.some(parent => parent.localId === symbol.parentLocalId)).toBe(true)
    }
    expect(relations(result, 'contains')).toHaveLength(result.symbols.filter(symbol => symbol.parentLocalId !== undefined).length)
  })

  it('uses the nearest retained ancestor after an overlong container is omitted', () => {
    const tooLong = 'x'.repeat(4097)
    const source = `namespace Root { namespace ${tooLong} { class Kept {} } }`
    const result = createTypeScriptAstExtractorP0().extract(verified('main.ts', source)) as FileExtractionFactsP0
    expect(result.status).toBe('partial')
    expect(result.reasons).toContain('capacity-limit')
    expect(result.symbols.some(symbol => symbol.name === tooLong)).toBe(false)
    expect(parentName(result, 'Kept')).toBe('Root')
  })
})

describe('TypeScriptAstExtractorP0 relationships', () => {
  it('extracts only file-level static module summaries and supported call candidates', () => {
    const source = [
      'import type { T } from "types"',
      'import "side"',
      'import { x } from "types"',
      'export const visible = 1, { item: alias } = input',
      'export default function namedDefault() {}',
      'export { x as publicX }',
      'export type { T as PublicT } from "types"',
      'export * from "star"',
      'export * as ns from "space"',
      'namespace Local { export const notFileExport = 1 }',
      'identifier(); receiver.method?.(); receiver?.method(); this.#privateCall();',
      'require("direct"); import("dynamic"); new Constructed(); tag`value`; receiver[computed]();',
      'export = visible',
      'exports.common = visible; module.exports.other = visible',
    ].join('\n')
    const result = createTypeScriptAstExtractorP0().extract(verified('src/relations.ts', source)) as FileExtractionFactsP0
    const imports = relations(result, 'imports').map(relation => relation.target)
    const exports = relations(result, 'exports').map(relation => relation.target)
    const calls = relations(result, 'calls').map(relation => relation.target)

    expect(imports).toEqual([
      { kind: 'unresolved', specifier: 'types' },
      { kind: 'unresolved', specifier: 'side' },
    ])
    expect(exports).toEqual(expect.arrayContaining([
      { kind: 'unresolved', name: 'visible' },
      { kind: 'unresolved', name: 'alias' },
      { kind: 'unresolved', name: 'default' },
      { kind: 'unresolved', name: 'publicX' },
      { kind: 'unresolved', name: 'PublicT', specifier: 'types' },
      { kind: 'unresolved', specifier: 'star' },
      { kind: 'unresolved', name: 'ns', specifier: 'space' },
    ]))
    expect(exports).not.toContainEqual({ kind: 'unresolved', name: 'notFileExport' })
    expect(exports).not.toContainEqual({ kind: 'unresolved', name: 'namedDefault' })
    expect(exports).not.toContainEqual({ kind: 'unresolved', name: '*' })
    expect(exports).not.toContainEqual({ kind: 'unresolved', name: 'common' })
    expect(exports).not.toContainEqual({ kind: 'unresolved', name: 'other' })
    expect(calls).toEqual(expect.arrayContaining([
      { kind: 'unresolved', name: 'identifier' },
      { kind: 'unresolved', name: 'method' },
      { kind: 'unresolved', name: '#privateCall' },
    ]))
    expect(calls.filter(target => target.kind === 'unresolved' && target.name === 'method')).toHaveLength(1)
    for (const excluded of ['require', 'import', 'Constructed', 'tag', 'computed']) {
      expect(calls).not.toContainEqual({ kind: 'unresolved', name: excluded })
    }
    expect(result.relationships.every(relation => !('evidence' in relation))).toBe(true)
  })

  it('preserves empty literal endpoint values and omits overlong relation facts', () => {
    const huge = 'z'.repeat(4097)
    const source = `import ""; export { value as "" } from ""; ${huge}()`
    const result = createTypeScriptAstExtractorP0().extract(verified('main.ts', source)) as FileExtractionFactsP0
    expect(result.relationships).toContainEqual({
      type: 'imports', source: { kind: 'file' }, target: { kind: 'unresolved', specifier: '' }, resolution: 'syntactic',
    })
    expect(result.relationships).toContainEqual({
      type: 'exports', source: { kind: 'file' }, target: { kind: 'unresolved', name: '', specifier: '' }, resolution: 'syntactic',
    })
    expect(result.relationships.some(relation => relation.target.kind === 'unresolved' && relation.target.name === huge)).toBe(false)
    expect(result.status).toBe('partial')
    expect(result.reasons).toContain('capacity-limit')
  })
})

describe('TypeScriptAstExtractorP0 status and bounds', () => {
  it('reports unsupported without parsing and syntax diagnostics as bounded partial state', () => {
    const extractor = new TypeScriptAstExtractorP0()
    const unsupported = extractor.extract(verified('README.md', 'function visible() {}'))
    expect(unsupported).toEqual(expect.objectContaining({ eligible: false, status: 'unsupported', diagnosticsCount: 0, symbols: [], relationships: [] }))

    const source = 'function before() {}\nconst broken = ;\nfunction after() {}\n'
    const malformed = extractor.extract(verified('broken.ts', source))
    expect(malformed.eligible).toBe(true)
    expect(malformed.status).toBe('partial')
    expect(malformed.reasons).toEqual(['syntax-diagnostics'])
    expect(malformed.diagnosticsCount).toBeGreaterThan(0)
    expect(malformed.symbols.map(symbol => symbol.name)).toEqual(expect.arrayContaining(['before', 'broken', 'after']))
    expect(malformed).not.toHaveProperty('diagnosticSummary')
  })

  it('turns an isolated extraction exception into a bounded failed result', () => {
    const base = verified('failed.ts', 'function unavailable() {}')
    const poisoned = {
      receipt: base.receipt,
      lineMap: base.lineMap,
      get text(): string { throw new Error('/private/workspace/raw provider detail') },
    } as VerifiedFileP0
    const result = createTypeScriptAstExtractorP0().extract(poisoned)
    expect(result).toEqual(expect.objectContaining({
      eligible: true,
      status: 'failed',
      reasons: ['extraction-failed'],
      diagnosticsCount: 0,
      symbols: [],
      relationships: [],
    }))
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('enforces finite node, depth, symbol and relation caps deterministically', () => {
    const source = 'namespace A { namespace B { const one = 1; const two = 2; function f(){ one(); two(); three() } } }'
    const file = verified('caps.ts', source)
    const limits = { maxNodes: 30, maxDepth: 8, maxSymbols: 3, maxRelations: 2 }
    const extractor = createTypeScriptAstExtractorP0(limits)
    const first = extractor.extract(file)
    const second = extractor.extract(file)
    expect(first).toEqual(second)
    expect(first.status).toBe('partial')
    expect(first.reasons).toContain('capacity-limit')
    expect(first.symbols.length).toBeLessThanOrEqual(3)
    expect(first.relationships.length).toBeLessThanOrEqual(2)
    expect(extractor.identity.extractionConfigVersion).toContain('s=3;r=2')

    const shallow = createTypeScriptAstExtractorP0({ maxDepth: 1 }).extract(file)
    expect(shallow.status).toBe('partial')
    expect(shallow.reasons).toContain('capacity-limit')
    const nodeLimited = createTypeScriptAstExtractorP0({ maxNodes: 1 }).extract(file)
    expect(nodeLimited.status).toBe('partial')
    expect(nodeLimited.symbols).toEqual([])
    expect(() => createTypeScriptAstExtractorP0({ maxSymbols: 0 })).toThrow(TypeError)
  })

  it('propagates cancellation and deadline failures', () => {
    const file = verified('main.ts', 'function work() {}')
    const extractor = createTypeScriptAstExtractorP0()
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    expect(() => extractor.extract(file, { signal: controller.signal })).toThrow(/cancelled|abort/i)
    expect(() => extractor.extract(file, { deadlineMs: Date.now() - 1 })).toThrow(/deadline/i)
  })

  it('returns deterministic ordinary DTOs with no AST or snapshot identity fields', () => {
    const source = 'function local() { class Child {} }\nlocal();\n'
    const file = verified('src/stable.js', source)
    const extractor = createTypeScriptAstExtractorP0()
    const first = extractor.extract(file)
    const second = extractor.extract(file)
    expect(first).toEqual(second)
    expect(JSON.stringify(first)).not.toContain('snapshotId')
    expect(first.symbols.map(symbol => symbol.localId)).toEqual([1, 2])
    expect(first.symbols.every(symbol => Object.isFrozen(symbol))).toBe(true)
    expect(first.relationships.every(relation => Object.isFrozen(relation))).toBe(true)
  })
})

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, sha256Utf8, OUTPUT_POLICY_P0 as O, parseRepoMapPageP0, type SymbolP0 } from '@han_05/dsh-context'
import { buildIndexP0, indexProvenanceP0 } from '../src/p0-build.ts'
import { parseSnapshotConfigP0 } from '../src/p0-snapshot.ts'
import { repoMapP0, symbolQueryP0, relationQueryP0, decodeCursorP0, encodeCursorP0 } from '../src/p0-query.ts'
import { createTypeScriptAstExtractorP0 } from '../src/p0-extractor.ts'
import { CodeIntelligenceErrorP0 } from '../src/p0-tool-errors.ts'
import type { BuiltIndexP0 } from '../src/p0-types.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const H = (s: string) => sha256Utf8(s)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'm2-query-')); roots.push(root)
  await mkdir(join(root, 'src')); await mkdir(join(root, 'src-other'))
  const files = {
    'config.json': '{"enabled":true}\n', 'README.md': '# hello\n',
    'src/a.ts': `import { x } from 'm'; import 'm'; export { x as renamed } from 'm';
export * from 'z'; export * as ns from 'n'; export default function named() {}
export namespace Box { export class Thing { run() { ping(); ping(); obj?.pong(); } } }
const hidden = 1; const HTTPServer = () => 1; function fooBar() {} function foo() {} function foo() {}
`,
    'src/b.ts': 'function foo() {}\nconst bar = 1;\n',
    'src/broken.ts': 'export function broken( {\n',
    'src-other/c.ts': 'const foo = 1;\n',
  }
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text)
  const config = parseSnapshotConfigP0({ deploymentRoot: root, revision: 'm2-query' })
  const index = await buildIndexP0(config)
  return { root, index, snapshotId: index.snapshot.snapshotId, config }
}
function code(run: () => unknown, expected: string) {
  try { run(); throw new Error('Expected business failure') } catch (e) { expect(e).toBeInstanceOf(CodeIntelligenceErrorP0); expect((e as CodeIntelligenceErrorP0).code).toBe(expected) }
}

describe('M2 Q1/Q2 real query core', () => {
  it('discovers versions and JSON receipts without touching current filesystem, including unsupported scope', async () => {
    const { root, index } = await fixture()
    await rm(join(root, 'config.json'))
    const page = repoMapP0(index, { path: 'config.json' })
    expect(page).toMatchObject({ schemaVersion: 'p0', snapshotId: index.snapshot.snapshotId, indexFingerprint: index.indexFingerprint, truncated: false,
      items: [{ path: 'config.json', sourceHash: H('{"enabled":true}\n') }], extraction: { summary: { status: 'unsupported', scopeFileCount: 1, eligibleFileCount: 0, unsupportedFileCount: 1 } } })
    expect(page).not.toHaveProperty('blockId'); expect(page).not.toHaveProperty('nextCursor')
    code(() => repoMapP0(index, { path: 'missing.json' }), 'not-found')
    code(() => repoMapP0(index, { path: 'config.json', limit: 1 }), 'invalid-query')
    code(() => repoMapP0(index, { snapshotId: H('old') }), 'stale-snapshot')
    expect(repoMapP0(index, {}).items.map(i => i.path)).toEqual([...index.snapshot.files.map(f => f.path)].sort())
  })
  it('queries supported non-exported, exact/qualified/prefix, overloads, kind and directory scope', async () => {
    const { index, snapshotId } = await fixture()
    expect(symbolQueryP0(index, { snapshotId, name: 'hidden' }).matches).toHaveLength(1)
    const qualified = symbolQueryP0(index, { snapshotId, name: 'Box.Thing.run' })
    expect(qualified.matches.map(s => s.name)).toEqual(['run'])
    const direct = symbolQueryP0(index, { snapshotId, symbolId: qualified.matches[0].symbolId })
    expect(direct.matches[0].match).toBeUndefined()
    expect(direct.extraction.summary.scopeFileCount).toBe(1)
    expect(symbolQueryP0(index, { snapshotId, name: 'Box', mode: 'prefix' }).matches.map(s => s.name)).toEqual(['Box', 'Thing', 'run'])
    const exact = symbolQueryP0(index, { snapshotId, name: 'foo', kind: 'function', pathPrefix: 'src/' })
    expect(exact.matches.map(s => s.path)).toEqual(['src/a.ts', 'src/a.ts', 'src/b.ts'])
    expect(exact.matches.every(s => s.match === 'exact')).toBe(true)
    expect(symbolQueryP0(index, { snapshotId, name: 'FOO' }).matches).toEqual([])
    expect(symbolQueryP0(index, { snapshotId, name: 'src/a.ts' }).matches).toEqual([])
    expect(symbolQueryP0(index, { snapshotId, name: 'foo', pathPrefix: 'src/a.ts' }).extraction.summary).toMatchObject({ status: 'complete', scopeFileCount: 0 })
    code(() => symbolQueryP0(index, { snapshotId, symbolId: H('old-parent-expanded-id') }), 'stale-symbol-id')
    code(() => symbolQueryP0(index, { snapshotId, symbolId: direct.matches[0].symbolId, limit: 1 }), 'invalid-query')
  })
  it('rejects actual pre-v2 IDs and removed same-receipt index members for both symbol and relation lookup', async () => {
    const { index, config, snapshotId } = await fixture()
    const box = symbolQueryP0(index, { snapshotId, name: 'Box' }).matches[0]
    const oldId = H(canonicalJson([snapshotId, box.path, box.kind, box.name, box.start, box.end, null]))
    code(() => symbolQueryP0(index, { snapshotId, symbolId: oldId }), 'stale-symbol-id')
    code(() => relationQueryP0(index, { snapshotId, from: { symbolId: oldId } }), 'stale-symbol-id')
    const ast = createTypeScriptAstExtractorP0()
    const rebuilt = await buildIndexP0(config, { extractor: { identity: ast.identity, supports: f => ast.supports(f), extract: (f, c) => {
      if (f.receipt.path === box.path) throw new Error('isolated extraction failure')
      return ast.extract(f, c)
    } } })
    expect(rebuilt.snapshot.snapshotId).toBe(snapshotId)
    expect(rebuilt.indexFingerprint).not.toBe(index.indexFingerprint)
    code(() => symbolQueryP0(rebuilt, { snapshotId, symbolId: box.symbolId }), 'stale-symbol-id')
    code(() => relationQueryP0(rebuilt, { snapshotId, from: { symbolId: box.symbolId } }), 'stale-symbol-id')
  })
  it('retains query-wide partial/failed coverage even with no hits; unsupported does not lower TS completeness', async () => {
    const { index, snapshotId, config } = await fixture()
    const ast = createTypeScriptAstExtractorP0()
    const withFailure = await buildIndexP0(config, { extractor: { identity: ast.identity, supports: f => ast.supports(f), extract: (f, c) => { if (f.receipt.path === 'src/b.ts') throw new Error('private'); return ast.extract(f, c) } } })
    expect(withFailure.snapshot.snapshotId).toBe(snapshotId)
    expect(withFailure.indexFingerprint).not.toBe(index.indexFingerprint)
    const oldCursor = symbolQueryP0(index, { snapshotId, name: 'foo', limit: 1 }).nextCursor!
    code(() => symbolQueryP0(withFailure, { snapshotId, name: 'foo', limit: 1, cursor: oldCursor }), 'stale-cursor')
    const empty = symbolQueryP0(withFailure, { snapshotId, name: 'noSuchSymbol', pathPrefix: 'src', kind: 'enum' })
    expect(empty.matches).toEqual([])
    expect(empty.extraction.summary).toMatchObject({ status: 'partial', scopeFileCount: 3, eligibleFileCount: 3, failedFileCount: 1, partialFileCount: 1 })
    const clean = symbolQueryP0(index, { snapshotId, name: 'foo', pathPrefix: 'src-other' })
    expect(clean.extraction.summary.status).toBe('complete')
    expect(clean.extraction.resultFiles).toBeUndefined()
    const partial = symbolQueryP0(index, { snapshotId, name: 'broken' })
    expect(partial.matches).toHaveLength(1)
    expect(partial.extraction.resultFiles?.map(f => f.path)).toEqual(['src/broken.ts'])
    expect(repoMapP0(index, {}).extraction.summary).toMatchObject({ scopeFileCount: 6, eligibleFileCount: 4, unsupportedFileCount: 2 })
  })
  it('freezes fuzzy reference scoring including camel boundaries, repeated terms, paths and contains names', async () => {
    const { index, snapshotId } = await fixture()
    const query = (name: string) => symbolQueryP0(index, { snapshotId, name, mode: 'fuzzy' }).matches
    expect(query('fooBar').find(s => s.name === 'fooBar')?.score).toBe(1700)
    expect(query('foobar').find(s => s.name === 'fooBar')?.score).toBe(1500)
    expect(query('foo foo').find(s => s.name === 'foo')?.score).toBe(200)
    expect(query('src').every(s => s.score === 40)).toBe(true)
    expect(query('run').map(s => [s.name, s.score])).toEqual([['run', 1600], ['Thing', 20]])
    expect(query('  fooBar  ')).toEqual(query('fooBar'))
    code(() => symbolQueryP0(index, { snapshotId, name: '---', mode: 'fuzzy' }), 'invalid-query')
  })
  it('normalizes requests once semantically for cursor bindings and rejects every version boundary', async () => {
    const { index, snapshotId } = await fixture()
    const request = { snapshotId, name: 'foo', mode: 'prefix', limit: 1, pathPrefix: 'src/' }
    const first = symbolQueryP0(index, request)
    expect(first.truncated).toBe(true)
    const cursor = first.nextCursor!
    expect(decodeCursorP0(cursor).offset).toBe(1)
    expect(symbolQueryP0(index, { ...request, pathPrefix: 'src', cursor }).matches[0].symbolId).not.toBe(first.matches[0].symbolId)
    const all: SymbolP0[] = [...first.matches]
    let next = cursor
    while (next) { const p = symbolQueryP0(index, { ...request, cursor: next }); all.push(...p.matches); next = p.nextCursor! }
    expect(all.map(s => s.symbolId)).toEqual(symbolQueryP0(index, { ...request, limit: 50 }).matches.map(s => s.symbolId))
    for (const changed of [{ name: 'Box' }, { limit: 2 }, { kind: 'class' }, { mode: 'exact' }, { pathPrefix: '' }]) code(() => symbolQueryP0(index, { ...request, ...changed, cursor }), 'stale-cursor')
    code(() => symbolQueryP0({ ...index, indexFingerprint: H('new-index') }, { ...request, cursor }), 'stale-cursor')
    code(() => symbolQueryP0(index, { ...request, cursor: encodeCursorP0({ ...decodeCursorP0(cursor), policyVersion: 'old-policy' }) }), 'stale-cursor')
    code(() => symbolQueryP0(index, { ...request, cursor: encodeCursorP0({ ...decodeCursorP0(cursor), offset: 99999 }) }), 'stale-cursor')
    code(() => repoMapP0(index, { limit: 1, cursor }), 'stale-cursor')
    for (const bad of ['', 'not-a-cursor', cursor.slice(1)]) code(() => symbolQueryP0(index, { ...request, cursor: bad }), 'invalid-cursor')
    code(() => symbolQueryP0(index, { ...request, cursor: 'x'.repeat(1025) }), 'invalid-query')
    for (const bad of [{}, { name: ' ' }, { name: 'x', kind: 'bogus' }, { name: 'x', pathPrefix: '../src' }, { name: 'x', unknown: true }]) code(() => symbolQueryP0(index, { snapshotId, ...bad }), 'invalid-query')
  })
  it('bounds optional metadata independently, preserves every partial result source, shrinks pages without skipping', async () => {
    const { index } = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'm2-large-')); roots.push(root)
    const name = 'A'.repeat(4000)
    for (let n = 0; n < 14; n++) await writeFile(join(root, `${n.toString().padStart(2, '0')}.ts`), `export const ${name} = ;`)
    const built = await buildIndexP0(parseSnapshotConfigP0({ deploymentRoot: root, revision: 'large' }))
    const p = symbolQueryP0(built, { snapshotId: built.snapshot.snapshotId, name: 'A', mode: 'prefix', limit: 50 })
    expect(p.matches.length).toBeGreaterThan(0); expect(p.matches.length).toBeLessThan(14)
    expect(p.extraction.detailsTruncated).toBe(true)
    expect(p.extraction.resultFiles?.length).toBe(p.matches.length)
    expect(p.extraction.summary.partialFileCount).toBe(14)
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(O.maxOutputBytes)
    expect(decodeCursorP0(p.nextCursor!).offset).toBe(p.matches.length)
    const seen = [...p.matches]
    let cursor = p.nextCursor
    while (cursor) { const page = symbolQueryP0(built, { snapshotId: built.snapshot.snapshotId, name: 'A', mode: 'prefix', limit: 50, cursor }); seen.push(...page.matches); cursor = page.nextCursor }
    expect(new Set(seen.map(s => s.symbolId)).size).toBe(14)
    // Maximum provider identity and no candidates can always be represented.
    const identity = { providerId: 'x'.repeat(128), providerVersion: 'x'.repeat(128), extractionConfigVersion: 'x'.repeat(128), typescriptVersion: 'x'.repeat(128) }
    const empty: BuiltIndexP0 = { ...index, providerConfigIdentity: identity, symbols: [], relationships: [], fileExtractionStates: [], snapshot: { ...index.snapshot, files: [] } }
    expect(parseRepoMapPageP0(repoMapP0(empty, {})).items).toEqual([])
    expect(indexProvenanceP0(empty.snapshot.snapshotId, identity).providerId.length).toBe(128)
  })
  it('shrinks JSON-escaped fact pages deterministically, retaining name values and normalized cursor continuation', async () => {
    const { root, config } = await fixture()
    const name = '\\"'.repeat(1000)
    await writeFile(join(root, 'escaped.ts'), `class Escaped { ${Array.from({ length: 12 }, (_, i) => `${JSON.stringify(name + i)} = 1;`).join('\n')} }`)
    const index = await buildIndexP0(config), snapshotId = index.snapshot.snapshotId
    const raw = { snapshotId, name: '\\"', mode: 'prefix', limit: 50 }
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = symbolQueryP0(index, { ...raw, ...(cursor ? { cursor } : {}) })
      expect(page.matches.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(O.maxOutputBytes)
      seen.push(...page.matches.map(s => s.name))
      cursor = page.nextCursor
      if (cursor) expect(decodeCursorP0(cursor).offset).toBe(seen.length)
    } while (cursor)
    expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => name + i))
    const first = repoMapP0(index, { limit: 1 })
    expect(repoMapP0(index, { snapshotId, limit: 1, cursor: first.nextCursor }).items[0].path).not.toBe(first.items[0].path)
  })
  it('trims oversized optional problem details before facts and rejects an unrepresentable single receipt', async () => {
    const { index } = await fixture()
    const original = index.fileExtractionStates.find(f => f.status === 'partial')!
    const states = Array.from({ length: 10 }, (_, n) => ({ ...original, path: `${n}/${'long/'.repeat(300)}x.ts` }))
    const modified = { ...index, fileExtractionStates: states }
    const p = symbolQueryP0(modified, { snapshotId: index.snapshot.snapshotId, name: 'no-match' })
    const { resultFiles: _, ...fixed } = p.extraction
    expect(Buffer.byteLength(JSON.stringify({ provenance: p.provenance, extraction: fixed }))).toBeLessThanOrEqual(O.maxMetadataBytes)
    expect(p.extraction.detailsTruncated).toBe(true)
    const longPath = `${'a/'.repeat(40000)}x.json`
    const huge = { ...index, snapshot: { ...index.snapshot, files: [{ path: longPath, contentHash: H('x'), byteLength: 1, language: 'text' }] }, fileExtractionStates: [] }
    code(() => repoMapP0(huge, {}), 'budget-exceeded')
  })
})

describe('M2 Q3 real AST relationships', () => {
  it('returns actual deduplicated source-specific edges with honest resolution and canonical paging', async () => {
    const { index, snapshotId } = await fixture()
    const request = { snapshotId, from: { path: 'src/a.ts' } }
    const p = relationQueryP0(index, request)
    expect(p.relationships.filter(r => r.type === 'imports').map(r => r.target)).toEqual([{ kind: 'unresolved', specifier: 'm' }])
    expect(p.relationships.filter(r => r.type === 'calls').map(r => [r.target, r.resolution])).toEqual([
      [{ kind: 'unresolved', name: 'ping' }, 'heuristic'], [{ kind: 'unresolved', name: 'pong' }, 'heuristic'],
    ])
    expect(p.relationships.filter(r => r.type === 'exports').map(r => r.target)).toEqual(expect.arrayContaining([
      { kind: 'unresolved', name: 'renamed', specifier: 'm' }, { kind: 'unresolved', specifier: 'z' }, { kind: 'unresolved', name: 'ns', specifier: 'n' }, { kind: 'unresolved', name: 'default' },
    ]))
    expect(p.relationships.some(r => r.target.kind === 'unresolved' && 'name' in r.target && r.target.name === 'named')).toBe(false)
    expect(relationQueryP0(index, { ...request, types: ['contains'] }).relationships).toEqual([])
    expect(relationQueryP0(index, { ...request, types: [] }).relationships).toEqual([])
    const first = relationQueryP0(index, { ...request, limit: 1, types: ['imports', 'exports', 'imports'] })
    const second = relationQueryP0(index, { ...request, limit: 1, types: ['exports', 'imports'], cursor: first.nextCursor })
    expect(second.relationships[0]).not.toEqual(first.relationships[0])
    const all = relationQueryP0(index, { ...request, types: ['exports', 'imports'] }).relationships
    expect([first.relationships[0], second.relationships[0]]).toEqual(all.slice(0, 2))
    expect(p.relationships).toEqual([...p.relationships].sort((a, b) => {
      const ka = [a.type, canonicalJson(a.source), canonicalJson(a.target)], kb = [b.type, canonicalJson(b.source), canonicalJson(b.target)]
      for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1
      return 0
    }))
  })
  it('shrinks real long-name relationship pages and reports partial contains source rather than target metadata', async () => {
    const { root, config } = await fixture()
    const long = 'L'.repeat(3900)
    await writeFile(join(root, 'large.ts'), Array.from({ length: 24 }, (_, n) => `import '${long}${n}';`).join('\n') + '\nexport class Incomplete { run() {} broken = ; }')
    const index = await buildIndexP0(config), snapshotId = index.snapshot.snapshotId
    const request = { snapshotId, from: { path: 'large.ts' }, types: ['imports'], limit: 50 }
    const first = relationQueryP0(index, request)
    expect(first.truncated).toBe(true)
    expect(first.relationships.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(O.maxOutputBytes)
    expect(first.extraction.resultFiles?.map(f => f.path)).toEqual(['large.ts'])
    const second = relationQueryP0(index, { ...request, cursor: first.nextCursor })
    expect(first.relationships.length + second.relationships.length).toBe(24)
    expect(second.truncated).toBe(false)
    const symbol = symbolQueryP0(index, { snapshotId, name: 'Incomplete' }).matches[0]
    const contains = relationQueryP0(index, { snapshotId, from: { symbolId: symbol.symbolId } })
    expect(contains.relationships.length).toBeGreaterThan(0)
    expect(contains.extraction.resultFiles?.map(f => f.path)).toEqual(['large.ts'])
    expect(contains.extraction.summary).toMatchObject({ scopeFileCount: 1, partialFileCount: 1 })
  })
  it('keeps empty, escaped and Unicode endpoints distinct and paginates normalized type sets without changing the index', async () => {
    const { root, config } = await fixture()
    const modules = ['', 'm', 'M', 'é', 'e\u0301', '😀', 'quote"slash\\', 'line\nnext']
    const exports = ['', '*', 'a:b', '😀']
    await writeFile(join(root, 'endpoints.ts'), [
      ...modules.flatMap(module => [`import ${JSON.stringify(module)};`, `import ${JSON.stringify(module)};`, `export * from ${JSON.stringify(module)};`]),
      ...exports.flatMap(name => modules.map(module => `export { x as ${JSON.stringify(name)} } from ${JSON.stringify(module)};`)),
    ].join('\n'))
    const index = await buildIndexP0(config), snapshotId = index.snapshot.snapshotId
    const before = canonicalJson(index)
    const expected = [
      ...modules.map(specifier => ({ type: 'imports', target: { kind: 'unresolved', specifier } })),
      ...modules.map(specifier => ({ type: 'exports', target: { kind: 'unresolved', specifier } })),
      ...exports.flatMap(name => modules.map(specifier => ({ type: 'exports', target: { kind: 'unresolved', name, specifier } }))),
    ].sort((a, b) => {
      const first = `${a.type}:${canonicalJson(a.target)}`, second = `${b.type}:${canonicalJson(b.target)}`
      return first < second ? -1 : first > second ? 1 : 0
    })
    const query = { snapshotId, from: { path: 'endpoints.ts' }, limit: 3 }
    let cursor: string | undefined
    const seen: typeof expected = []
    do {
      const page = relationQueryP0(index, { ...query, ...(cursor ? { cursor, types: ['imports', 'contains', 'exports', 'calls', 'imports'] } : {}) })
      expect(page.extraction.summary.status).toBe('complete')
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(O.maxOutputBytes)
      seen.push(...page.relationships.map(({ type, target }) => ({ type, target })) as typeof expected)
      cursor = page.nextCursor
      if (cursor) expect(decodeCursorP0(cursor).offset).toBe(seen.length)
    } while (cursor)
    expect(seen).toEqual(expected)
    expect(canonicalJson(index)).toBe(before)
  })

  it('validates from membership, contains endpoints and relevant partial/unsupported states even for empty pages', async () => {
    const { index, snapshotId } = await fixture()
    const box = symbolQueryP0(index, { snapshotId, name: 'Box' }).matches[0]
    const p = relationQueryP0(index, { snapshotId, from: { symbolId: box.symbolId } })
    expect(p.relationships).toHaveLength(1)
    const relation = p.relationships[0]
    expect(relation).toMatchObject({ type: 'contains', resolution: 'syntactic', source: { kind: 'symbol', symbolId: box.symbolId } })
    if (relation.target.kind !== 'symbol') throw new Error('Expected contains')
    expect(symbolQueryP0(index, { snapshotId, symbolId: relation.target.symbolId }).matches[0].name).toBe('Thing')
    expect(relationQueryP0(index, { snapshotId, from: { path: 'config.json' } }).extraction.summary.status).toBe('unsupported')
    const broken = relationQueryP0(index, { snapshotId, from: { path: 'src/broken.ts' }, types: ['contains'] })
    expect(broken.relationships).toEqual([]); expect(broken.extraction.summary.partialFileCount).toBe(1)
    const actualBroken = relationQueryP0(index, { snapshotId, from: { path: 'src/broken.ts' } })
    expect(actualBroken.extraction.resultFiles?.[0].path).toBe('src/broken.ts')
    code(() => relationQueryP0(index, { snapshotId, from: { path: 'src' } }), 'not-found')
    code(() => relationQueryP0(index, { snapshotId, from: { symbolId: H('old') } }), 'stale-symbol-id')
    code(() => relationQueryP0(index, { snapshotId, from: { path: 'src/a.ts', symbolId: box.symbolId } }), 'invalid-query')
    code(() => relationQueryP0(index, { snapshotId, from: { path: 'src/a.ts' }, types: ['callers'] }), 'invalid-query')
  })
})

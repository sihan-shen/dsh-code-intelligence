// Local working-tree smoke only, not fixed-commit independent gold or M5 evidence.
// Run after building: node scripts/smoke-m2.mjs
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { buildIndexP0, parseSnapshotConfigP0, repoMapP0, symbolQueryP0, relationQueryP0, expandSourceP0, createVerifiedReaderP0 } from '../lib/index.mjs'
const root = new URL('../', import.meta.url).pathname
const start = performance.now()
const index = await buildIndexP0(parseSnapshotConfigP0({ deploymentRoot: root, revision: 'm2-working-tree-smoke' }))
const buildMs = performance.now() - start
const receipt = repoMapP0(index, { path: 'package.json' })
const reader = await createVerifiedReaderP0(root)
const source = await expandSourceP0(index, reader, { snapshotId: receipt.snapshotId, path: receipt.items[0].path, sourceHash: receipt.items[0].sourceHash, wholeFile: true })
assert.equal(JSON.parse(source.text).name, '@han_05/dsh-code-intelligence')
assert.equal('blockId' in source, false)
const symbols = symbolQueryP0(index, { snapshotId: receipt.snapshotId, name: 'repoMapP0', pathPrefix: 'src', kind: 'function' })
assert.equal(symbols.matches.length, 1)
assert.equal(symbols.matches[0].path, 'src/p0-query.ts')
const symbol = symbols.matches[0]
const declaration = await expandSourceP0(index, reader, { snapshotId: receipt.snapshotId, path: symbol.path, sourceHash: symbol.sourceHash, offsetRange: { startOffset: symbol.startOffset, endOffset: symbol.endOffset } })
assert.ok(declaration.text.startsWith('export function repoMapP0('))
const imports = relationQueryP0(index, { snapshotId: receipt.snapshotId, from: { path: 'src/p0-query.ts' }, types: ['imports'] })
assert.ok(imports.relationships.some(r => r.type === 'imports' && r.target.specifier === '@han_05/dsh-context'))
const contains = relationQueryP0(index, { snapshotId: receipt.snapshotId, from: { symbolId: symbol.symbolId } })
assert.ok(contains.relationships.length > 0)
console.log(JSON.stringify({ kind: 'local-working-tree-only', receipts: index.snapshot.files.length, symbols: index.symbols.length, relationships: index.relationships.length, extraction: repoMapP0(index, {}).extraction.summary, buildMs: Math.round(buildMs), checks: ['package.json receipt/source', 'repoMapP0 exact location/source', 'imports', 'contains'] }, null, 2))

// Run after building dsh-context and this package:
// node scripts/benchmark-p0-ancestor-names.mjs [heapMiB=384] [variables=500]
// Synthetic diagnostic only; not a real-repository corpus or a latency SLA.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.argv[2] !== '--child') {
  const heapMiB = Number(process.argv[2] ?? 384)
  const variables = Number(process.argv[3] ?? 500)
  assert(Number.isSafeInteger(heapMiB) && heapMiB >= 64 && heapMiB <= 4096)
  assert(Number.isSafeInteger(variables) && variables >= 1 && variables <= 9000)
  const root = await mkdtemp(join(tmpdir(), 'p0-ancestor-bench-'))
  try {
    const source = ('namespace ' + 'N'.repeat(4000) + ' {\n').repeat(60)
      + Array.from({ length: variables }, (_, i) => `const v${i} = 1;`).join('\n') + '}'.repeat(60)
    await writeFile(join(root, 'a.ts'), source)
    const result = spawnSync(process.execPath, [`--max-old-space-size=${heapMiB}`, fileURLToPath(import.meta.url), '--child', root, String(variables)], {
      stdio: 'inherit', timeout: 60_000,
    })
    if (result.error) throw result.error
    if (result.signal) throw new Error(`Benchmark child terminated by ${result.signal}`)
    process.exitCode = result.status ?? 1
  } finally {
    await rm(root, { recursive: true, force: true })
  }
} else {
  const { buildIndexP0, parseSnapshotConfigP0 } = await import('../lib/index.mjs')
  const variables = Number(process.argv[4])
  const started = performance.now()
  const index = await buildIndexP0(parseSnapshotConfigP0({ deploymentRoot: process.argv[3], revision: 'ancestor-benchmark-v1' }))
  const elapsedMs = performance.now() - started
  assert.equal(index.symbols.length, variables + 60)
  assert.equal(index.relationships.length, variables + 59)
  assert.equal(index.fileExtractionStates[0].status, 'complete')
  assert.equal(index.symbols.filter(symbol => symbol.lexicalQualifiedName !== undefined).length, 1)
  const byId = new Map(index.symbols.map(symbol => [symbol.symbolId, symbol]))
  for (const relation of index.relationships) {
    assert.equal(relation.type, 'contains')
    assert.equal(byId.get(relation.target.symbolId).containerId, relation.source.symbolId)
  }
  console.log(JSON.stringify({
    node: process.version, sourceBytes: index.snapshot.files[0].byteLength,
    symbols: index.symbols.length, relationships: index.relationships.length,
    elapsedMs: Math.round(elapsedMs), peakRssKiB: process.resourceUsage().maxRSS,
    memoryBytes: process.memoryUsage(),
  }, null, 2))
}

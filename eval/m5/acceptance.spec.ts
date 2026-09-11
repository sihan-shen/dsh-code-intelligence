// M5 formal acceptance runner.
//
// This suite is intentionally isolated from `tests/**`: run it with
//   ./node_modules/.bin/vitest run --config eval/m5/vitest.config.ts
// after `pnpm run build` (it imports the public build entry, never `src/`).
//
// It refuses to run against a missing/changed corpus or gold file, then:
//   1. replays the 20 frozen gold samples through the public P0 query surface;
//   2. drives the five public tools through a real ToolRuntime + SessionStore +
//      WorkspaceRegistry over a temporary corpus copy, covering content edits,
//      line inserts, file adds, file removals, refresh failure, and stale
//      handles.
// A machine-readable report is written to
// `node_modules/.cache/m5-eval/reports/acceptance-result.json`.

import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  apply,
  buildIndexP0,
  createResolverP0,
  createVerifiedReaderP0,
  expandSourceP0,
  parseSnapshotConfigP0,
  relationQueryP0,
  symbolQueryP0,
} from '../../lib/index.js'

const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CORPUS_ROOT = join(PKG_ROOT, 'node_modules/.cache/m5-eval/corpus/zod-1fb56a5c18c27102dbc92260a4007c7732a0ccca/packages/zod/src')
const MANIFEST_PATH = join(PKG_ROOT, 'node_modules/.cache/m5-eval/corpus-manifest.json')
const GOLD_PATH = fileURLToPath(new URL('./gold.json', import.meta.url))
const REPORT_PATH = join(PKG_ROOT, 'node_modules/.cache/m5-eval/reports/acceptance-result.json')
const COMMIT = '1fb56a5c18c27102dbc92260a4007c7732a0ccca'
const FROZEN_GOLD_SHA256 = 'cb9b7c90ed06cfd6a1960fdd71d77733265d21213253916d4357651c409d5237'
const TOOL_NAMES = ['context_repo_map', 'context_symbol_query', 'context_relation_query', 'context_expand_source', 'context_refresh_snapshot']

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const exists = async (path: string) => readFile(path).then(() => true, () => false)
const byPathOffset = (a: { path: string; startOffset: number }, b: { path: string; startOffset: number }) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.startOffset - b.startOffset

const report: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), node: process.version, commit: COMMIT,
  corpusRoot: CORPUS_ROOT, goldSha256: FROZEN_GOLD_SHA256, goldSamples: 0, failures: [] as string[], checks: {} }

// ---------------------------------------------------------------------------
// Gold replay through the public P0 query surface.
// ---------------------------------------------------------------------------

type GoldSample = Record<string, any>
let index: Awaited<ReturnType<typeof buildIndexP0>>
let reader: Awaited<ReturnType<typeof createVerifiedReaderP0>>
let snapshotId: string

beforeAll(async () => {
  const corpusPresent = await exists(join(CORPUS_ROOT, 'index.ts'))
  const manifestPresent = await exists(MANIFEST_PATH)
  if (!corpusPresent || !manifestPresent) {
    throw new Error(`M5 corpus missing at ${CORPUS_ROOT}; run: node scripts/prepare-m5-env.mjs`)
  }
  if (!(await exists(GOLD_PATH))) throw new Error(`M5 gold missing at ${GOLD_PATH}`)
  const goldHash = sha256(await readFile(GOLD_PATH))
  if (goldHash !== FROZEN_GOLD_SHA256) throw new Error(`M5 gold hash drifted: got ${goldHash}, frozen ${FROZEN_GOLD_SHA256}`)

  const started = performance.now()
  index = await buildIndexP0(parseSnapshotConfigP0({ deploymentRoot: CORPUS_ROOT, revision: COMMIT }))
  const buildMs = Math.round(performance.now() - started)
  reader = await createVerifiedReaderP0(CORPUS_ROOT)
  snapshotId = index.snapshot.snapshotId

  // The index must sit exactly on the locked corpus manifest.
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const manifestHashes = new Map<string, string>(manifest.files.map((f: { path: string; sha256: string }) => [f.path, f.sha256]))
  const indexPaths = index.snapshot.files.map((f) => f.path).sort()
  const manifestPaths = [...manifestHashes.keys()].sort()
  expect(indexPaths).toEqual(manifestPaths)
  for (const receipt of index.snapshot.files) expect(receipt.contentHash).toBe(`sha256:${manifestHashes.get(receipt.path)}`)

  const extraction = index.fileExtractionStates.reduce((acc: Record<string, number>, s) => { acc[s.status] = (acc[s.status] ?? 0) + 1; return acc }, {})
  report.corpus = { fileCount: index.snapshot.files.length, totalBytes: index.snapshot.files.reduce((n, f) => n + f.byteLength, 0), manifestSha256: sha256(await readFile(MANIFEST_PATH)), symbols: index.symbols.length, relationships: index.relationships.length }
  report.build = { buildMs, snapshotId, extraction, node: process.version, goldSha256: goldHash }
  report.goldSamples = JSON.parse(await readFile(GOLD_PATH, 'utf8')).samples.length
}, 300_000)

function recordCheck(id: string, detail: unknown) {
  ;(report.checks as Record<string, unknown>)[id] = detail
}

describe('M5 gold replay (public P0 surface)', () => {
  let gold: { samples: GoldSample[] }
  beforeAll(async () => { gold = JSON.parse(await readFile(GOLD_PATH, 'utf8')) })

  it('has exactly 8 declaration / 6 source / 6 relation frozen samples', () => {
    const counts = gold.samples.reduce((acc: Record<string, number>, s) => { acc[s.category] = (acc[s.category] ?? 0) + 1; return acc }, {})
    expect(counts).toEqual({ declaration: 8, source: 6, relation: 6 })
    report.sampleCounts = counts
  })

  it('replays every declaration sample exactly, including the same-name set and recall@5', async () => {
    const items = gold.samples.filter(s => s.category === 'declaration')
    for (const sample of items) {
      const requested = { snapshotId, limit: 50, ...sample.request }
      const result = symbolQueryP0(index, requested)
      const got = result.matches.map(m => ({ path: m.path, name: m.name, kind: m.kind, startOffset: m.startOffset, endOffset: m.endOffset, start: m.start.line + ':' + m.start.column, end: m.end.line + ':' + m.end.column })).sort(byPathOffset)
      const want = sample.expectedTargets.map((t: any) => ({ path: t.path, name: t.name, kind: t.kind, startOffset: t.startOffset, endOffset: t.endOffset, start: t.start.line + ':' + t.start.column, end: t.end.line + ':' + t.end.column })).sort(byPathOffset)
      expect(got, sample.id).toEqual(want)
      if (sample.matchMode === 'unique') expect(result.matches.length, sample.id).toBe(1)
      const top5 = new Set(result.matches.slice(0, 5).map(m => `${m.path}:${m.startOffset}`))
      const recalled = sample.expectedTargets.filter((t: any) => top5.has(`${t.path}:${t.startOffset}`)).length
      expect(recalled, `${sample.id} recall@5`).toBe(sample.expectedTargets.length)
      // Span semantics: expanding the reported range must reproduce the gold snippet.
      for (const target of sample.expectedTargets) {
        const match = result.matches.find(m => m.path === target.path && m.startOffset === target.startOffset)!
        const expanded = await expandSourceP0(index, reader, { snapshotId, path: match.path, sourceHash: match.sourceHash, offsetRange: { startOffset: match.startOffset, endOffset: match.endOffset } })
        expect(expanded.text, `${sample.id} ${match.path}`).toBe(target.snippet)
      }
      recordCheck(sample.id, { matches: result.matches.length, recallAt5: recalled / sample.expectedTargets.length })
    }
  })

  it('replays every source sample exactly', async () => {
    const items = gold.samples.filter(s => s.category === 'source')
    for (const sample of items) {
      const req = { snapshotId, path: sample.request.path, sourceHash: sample.expected.sourceHash,
        ...(sample.request.offsetRange ? { offsetRange: sample.request.offsetRange } : {}),
        ...(sample.request.lineRange ? { lineRange: sample.request.lineRange } : {}),
        ...(sample.request.wholeFile ? { wholeFile: true } : {}),
        ...(sample.request.paddingLines !== undefined ? { paddingLines: sample.request.paddingLines } : {}) }
      const result = await expandSourceP0(index, reader, req)
      expect({ startOffset: result.startOffset, endOffset: result.endOffset, start: result.start, end: result.end, text: result.text }, sample.id)
        .toEqual({ startOffset: sample.expected.startOffset, endOffset: sample.expected.endOffset, start: sample.expected.start, end: sample.expected.end, text: sample.expected.text })
      recordCheck(sample.id, { startOffset: result.startOffset, endOffset: result.endOffset, textLength: result.text.length })
    }
  })

  it('replays every relation sample exactly (set equality; order-independent)', async () => {
    const canonical = (e: any) => JSON.stringify({ type: e.type, resolution: e.resolution, target: e.target })
    const allEdges = (from: any, types: string[]) => {
      const out: any[] = []
      let cursor: string | undefined
      do {
        const page = relationQueryP0(index, { snapshotId, from, types, limit: 50, ...(cursor ? { cursor } : {}) })
        out.push(...page.relationships)
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return out
    }
    for (const sample of gold.samples.filter(s => s.category === 'relation')) {
      if (sample.relationKind === 'symbol') {
        const source = symbolQueryP0(index, { snapshotId, limit: 50, name: sample.request.from.symbolName, mode: 'exact', kind: sample.request.from.symbolKind, pathPrefix: sample.request.from.symbolPrefix })
        expect(source.matches.length, sample.id).toBe(1)
        const symbol = source.matches[0]
        expect({ startOffset: symbol.startOffset, endOffset: symbol.endOffset }, sample.id).toEqual({ startOffset: sample.expected.source.startOffset, endOffset: sample.expected.source.endOffset })
        const edges = allEdges({ symbolId: symbol.symbolId }, sample.request.types)
        const targets = edges.map(e => index.symbols.find(s => s.symbolId === e.target.symbolId)!)
        const got = targets.map(t => ({ name: t.name, kind: t.kind, path: t.path, startOffset: t.startOffset, endOffset: t.endOffset })).sort(byPathOffset)
        const want = sample.expected.targets.map((t: any) => ({ name: t.name, kind: t.kind, path: t.path, startOffset: t.startOffset, endOffset: t.endOffset })).sort(byPathOffset)
        expect(got, sample.id).toEqual(want)
        for (const edge of edges) expect(edge, sample.id).toMatchObject({ type: 'contains', resolution: 'syntactic' })
        recordCheck(sample.id, { edges: edges.length, targets: got.map(t => t.name) })
      } else {
        const edges = allEdges(sample.request.from, sample.request.types)
        const got = edges.map(canonical).sort()
        const want = sample.expected.map(canonical).sort()
        if (sample.exact) expect(got, sample.id).toEqual(want)
        else for (const e of want) expect(got, sample.id).toContain(e)
        for (const edge of edges) expect(edge, sample.id).toHaveProperty('type')
        recordCheck(sample.id, { edges: edges.length })
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Five public tools through a real ToolRuntime / SessionStore / WorkspaceRegistry
// over a temporary corpus copy (locked corpus is never modified).
// ---------------------------------------------------------------------------

const cleanup: Array<() => unknown> = []
afterEach(async (task) => {
  if (task.task.result?.state === 'fail') (report.failures as string[]).push(task.task.name)
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function memoryBackend() {
  const units = new Map<string, { tables: Map<string, Map<string, unknown>>; global: unknown }>()
  return { kv: { async open(descriptor: { name: string; tables: readonly string[] }) {
    let state = units.get(descriptor.name)
    if (!state) { state = { tables: new Map(descriptor.tables.map(t => [t, new Map()])), global: null }; units.set(descriptor.name, state) }
    return { async loadAll() { return { tables: Object.fromEntries([...state!.tables].map(([n, r]) => [n, Object.fromEntries(r)])), global: state!.global } },
      async putRecord(table: string, key: string, value: unknown) { state!.tables.get(table)!.set(key, value) },
      async deleteRecord(table: string, key: string) { state!.tables.get(table)!.delete(key) },
      async setGlobal(value: unknown) { state!.global = value }, async close() {} }
  } }, async close() {} }
}

async function registry() {
  const ctx = new Context()
  ctx.provide('typert', { lookups: { register() { return () => {} } } } as never)
  ctx.provide('systemPrompt', { tools() { return () => {} }, section() { return () => {} } } as never)
  const sessions = await ctx.plugin(SessionStore); cleanup.push(() => sessions.dispose())
  const tools = await ctx.plugin(ToolRuntime, { mode: 'native' }); cleanup.push(() => tools.dispose())
  const storage = await import('@deepseek-ai/dsh-storage')
  const domain = await import('@deepseek-ai/dsh-storage-domain')
  const workspace = await import('@deepseek-ai/dsh-workspace')
  const sf = await ctx.plugin(storage.Storage); cleanup.push(() => sf.dispose())
  const backend = memoryBackend()
  ctx.storage.backend.register('memory', backend as never)
  ctx.provide('storage.backend.memory', backend as never)
  const df = await ctx.plugin({ name: domain.name, inject: [...domain.inject, 'storage.backend.memory'], Config: domain.Config, apply: domain.apply }, { backend: 'memory' })
  cleanup.push(() => df.dispose())
  ctx.provide('sessionPersistence', { async list() { return [] } } as never)
  const wf = await ctx.plugin(workspace.WorkspaceRegistry); cleanup.push(() => wf.dispose())
  return ctx
}

function call(ctx: Context, name: string, args: unknown, session?: Session, agent = 'one', signal = new AbortController().signal) {
  return ctx.tools.execute({ callId: ToolCallId(`${name}-${agent}`), name, arguments: args, signal, ...(session ? { agent: { id: agent, session } as never } : {}) })
}
function data(result: ToolExecutionResult) {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(result.error.message)
  return result.value as Record<string, any>
}
function failureCode(result: ToolExecutionResult) {
  expect(result.isError).toBe(true)
  const meta = result.meta as { codeIntelligenceFailure?: { code?: string } } | undefined
  return meta?.codeIntelligenceFailure?.code ?? result.error?.info?.code
}

describe('M5 five public tools over a temporary corpus copy', () => {
  it('builds, queries, expands, relates, then survives edit / insert / add / remove / refresh failure with stale handles', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'm5-accept-'))
    cleanup.push(() => rm(parent, { recursive: true, force: true }))
    const root = join(parent, 'src')
    await cp(CORPUS_ROOT, root, { recursive: true })

    const ctx = await registry()
    const workspaces = ctx.get('workspaceRegistry') as { create(path: string): Promise<unknown> }
    await workspaces.create(root)
    const fiber = await ctx.plugin(apply, { deploymentRoot: '.', revision: COMMIT }); cleanup.push(() => fiber.dispose())
    for (const name of TOOL_NAMES) expect(ctx.tools.get(name), name).toBeDefined()

    const s = ctx.sessions.prepare(SessionId('m5-accept'), { meta: { cwd: root } })
    const detach = ctx.sessions.enter(s); cleanup.push(detach)
    ctx.sessions.announce(s)

    // 1. repo_map: receipts + snapshotId from the real tool.
    const map = data(await call(ctx, 'context_repo_map', { path: 'v4/core/versions.ts' }, s))
    const snapshotId = map.snapshotId as string
    const receipt = map.items[0]
    expect(receipt.path).toBe('v4/core/versions.ts')
    // Full pagination over the real repo-map tool must enumerate all 286 files.
    let cursor: string | undefined
    let fileCount = 0
    do {
      const page = data(await call(ctx, 'context_repo_map', cursor ? { cursor } : {}, s))
      fileCount += page.items.length
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(fileCount).toBe(286)

    // 2. symbol_query + 3. expand_source across the symbol span.
    const symbols = data(await call(ctx, 'context_symbol_query', { snapshotId, name: 'version', mode: 'exact', kind: 'variable', pathPrefix: 'v4/core' }, s))
    expect(symbols.matches).toHaveLength(1)
    const symbol = symbols.matches[0]
    const source = data(await call(ctx, 'context_expand_source', { snapshotId, path: symbol.path, sourceHash: symbol.sourceHash, offsetRange: { startOffset: symbol.startOffset, endOffset: symbol.endOffset } }, s))
    expect(source.text.startsWith('version = {')).toBe(true)
    expect(source.text.endsWith('as const')).toBe(true)

    // 4. relation_query from a file path.
    const relations = data(await call(ctx, 'context_relation_query', { snapshotId, from: { path: 'v3/helpers/typeAliases.ts' }, types: ['exports'] }, s))
    expect(relations.relationships.map((e: any) => e.target.name).sort()).toEqual(['Primitive', 'Scalars'])

    // 5. content change -> refresh -> new symbol, old snapshot + old source handle are stale.
    await writeFile(join(root, 'v4/core/versions.ts'), 'export const version = { major: 5, minor: 0, patch: 0 } as const;\n')
    const refreshed = data(await call(ctx, 'context_refresh_snapshot', {}, s))
    expect(refreshed.changed).toBe(true)
    const newSnapshotId = refreshed.snapshotId as string
    expect(newSnapshotId).not.toBe(snapshotId)
    expect(failureCode(await call(ctx, 'context_symbol_query', { snapshotId, name: 'version', mode: 'exact', kind: 'variable' }, s, 'stale-snap'))).toBe('stale-snapshot')
    expect(failureCode(await call(ctx, 'context_expand_source', { snapshotId: newSnapshotId, path: receipt.path, sourceHash: receipt.sourceHash, wholeFile: true }, s, 'stale-src'))).toBe('stale-source')
    const versionAfter = data(await call(ctx, 'context_symbol_query', { snapshotId: newSnapshotId, name: 'version', mode: 'exact', kind: 'variable', pathPrefix: 'v4/core' }, s))
    expect(versionAfter.matches).toHaveLength(1)

    // 6. insert lines -> offsets shift on refresh.
    const originalDoc = await readFile(join(root, 'v4/core/doc.ts'), 'utf8')
    const prefix = '// m5 inserted probe line\n'
    await writeFile(join(root, 'v4/core/doc.ts'), prefix + originalDoc)
    const inserted = data(await call(ctx, 'context_refresh_snapshot', {}, s))
    const insertedSnapshot = inserted.snapshotId as string
    const indented = data(await call(ctx, 'context_symbol_query', { snapshotId: insertedSnapshot, name: 'indented', mode: 'exact', kind: 'method' }, s))
    expect(indented.matches).toHaveLength(1)
    expect(indented.matches[0].startOffset).toBe(234 + prefix.length)

    // 7. add file -> refresh -> new symbol is queryable.
    await writeFile(join(root, 'm5-probe.ts'), 'export const M5ProbeAdded = 1;\n')
    const added = data(await call(ctx, 'context_refresh_snapshot', {}, s))
    const addedSnapshot = added.snapshotId as string
    const probe = data(await call(ctx, 'context_symbol_query', { snapshotId: addedSnapshot, name: 'M5ProbeAdded', mode: 'exact', kind: 'variable' }, s))
    expect(probe.matches).toHaveLength(1)
    expect(probe.matches[0].path).toBe('m5-probe.ts')

    // 8. remove file -> refresh -> symbol disappears.
    await rm(join(root, 'm5-probe.ts'))
    const removed = data(await call(ctx, 'context_refresh_snapshot', {}, s))
    const removedSnapshot = removed.snapshotId as string
    const gone = data(await call(ctx, 'context_symbol_query', { snapshotId: removedSnapshot, name: 'M5ProbeAdded', mode: 'exact', kind: 'variable' }, s))
    expect(gone.matches).toHaveLength(0)

    // 9. refresh failure preserves the active runtime and a later refresh succeeds.
    await writeFile(join(root, '.gitignore'), '!keep.ts\n')
    expect(failureCode(await call(ctx, 'context_refresh_snapshot', {}, s, 'broken'))).toBe('refresh-failed')
    await rm(join(root, '.gitignore'))
    const recovered = data(await call(ctx, 'context_refresh_snapshot', {}, s, 'recovered'))
    expect(recovered.changed).toBe(false)
    expect(recovered.snapshotId).toBe(removedSnapshot)

    recordCheck('tool-refresh-scenarios', { snapshotRotations: [snapshotId, newSnapshotId, insertedSnapshot, addedSnapshot, removedSnapshot], recovered: recovered.snapshotId })
    await detach()
  }, 300_000)
})

afterAll(async () => {
  report.finishedAt = new Date().toISOString()
  report.ok = (report.failures as string[]).length === 0
  await mkdir(join(PKG_ROOT, 'node_modules/.cache/m5-eval/reports'), { recursive: true })
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n')
})

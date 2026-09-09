import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { sha256Utf8, parseCodeIntelligenceFailureP0, parseRepoMapPageP0, parseSymbolQueryResultP0, parseRelationQueryResultP0, parseExpandSourceResultP0 } from '@han_05/dsh-context'
import { apply } from '../src/plugin.ts'
import { createResolverP0, parseConfigP0 } from '../src/p0-runtime.ts'
import { CodeIntelligenceErrorP0 } from '../src/p0-tool-errors.ts'

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const names = ['context_repo_map', 'context_symbol_query', 'context_relation_query', 'context_expand_source']
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'm2-registry-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  await writeFile(join(path, 'config.json'), '{"enabled":true}\n')
  await writeFile(join(path, 'main.ts'), "import 'dep'; export class Main { run() { ping(); } }\n")
  return path
}
function memoryBackend() {
  const units = new Map<string, { tables: Map<string, Map<string, unknown>>; global: unknown }>()
  return { kv: { async open(descriptor: { name: string; tables: readonly string[] }) {
    let state = units.get(descriptor.name)
    if (!state) { state = { tables: new Map(descriptor.tables.map(t => [t, new Map()])), global: null }; units.set(descriptor.name, state) }
    return {
      async loadAll() { return { tables: Object.fromEntries([...state!.tables].map(([n, r]) => [n, Object.fromEntries(r)])), global: state!.global } },
      async putRecord(table: string, key: string, value: unknown) { state!.tables.get(table)!.set(key, value) },
      async deleteRecord(table: string, key: string) { state!.tables.get(table)!.delete(key) },
      async setGlobal(value: unknown) { state!.global = value }, async close() {},
    }
  } }, async close() {} }
}
async function registry(realWorkspace = false) {
  const ctx = new Context()
  ctx.provide('typert', { lookups: { register() { return () => {} } } } as never)
  ctx.provide('systemPrompt', { tools() { return () => {} }, section() { return () => {} } } as never)
  const sessions = await ctx.plugin(SessionStore); cleanup.push(() => sessions.dispose())
  const tools = await ctx.plugin(ToolRuntime, { mode: 'native' }); cleanup.push(() => tools.dispose())
  if (realWorkspace) {
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
  }
  return ctx
}
function call(ctx: Context, name: string, args: unknown, session?: Session, agent = 'one', signal = new AbortController().signal) {
  return ctx.tools.execute({ callId: ToolCallId(`${name}-${agent}`), name, arguments: args, signal, ...(session ? { agent: { id: agent, session } as never } : {}) })
}
function data(result: ToolExecutionResult) {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(result.error.message)
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
  return result.value
}
function failure(result: ToolExecutionResult, code: string) {
  expect(result.isError).toBe(true)
  const dto = parseCodeIntelligenceFailureP0((result.meta as { codeIntelligenceFailure: unknown }).codeIntelligenceFailure)
  expect(dto.code).toBe(code)
  expect(result.error).toEqual({ message: dto.message, info: { name: 'CodeIntelligenceErrorP0', code } })
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(dto) }])
  expect(result).not.toHaveProperty('value')
  return dto
}
function session(ctx: Context, cwd: string, id: string) {
  const s = ctx.sessions.prepare(SessionId(id), { meta: { cwd } })
  const detach = ctx.sessions.enter(s); cleanup.push(detach)
  ctx.sessions.announce(s)
  return { s, detach }
}
async function mount(ctx: Context, config: object = {}) {
  const fiber = await ctx.plugin(apply, { deploymentRoot: '.', revision: 'm2-registry', ...config })
  cleanup.push(() => fiber.dispose())
  return fiber
}

describe('M2 Q5 default plugin through the real Native registry', () => {
  it('runs receipt → JSON source and symbol → contains/file relations → source with real WorkspaceRegistry and SessionStore', async () => {
    const first = await root(), second = await root()
    const ctx = await registry(true)
    const workspaces = ctx.get('workspaceRegistry') as { create(path: string): Promise<unknown> }
    await workspaces.create(first)
    const fiber = await mount(ctx)
    for (const name of names) expect(ctx.tools.get(name)).toBeDefined()
    for (const name of ['code_repo_map', 'code_symbol_query', 'context_refresh_snapshot']) expect(ctx.tools.get(name)).toBeUndefined()
    expect(ctx.get('contextCompiler')).toBeUndefined()
    const { s, detach } = session(ctx, first, 'first')
    const { s: other } = session(ctx, second, 'unregistered')
    const map = parseRepoMapPageP0(data(await call(ctx, 'context_repo_map', { path: 'config.json' }, s)))
    expect(map.items[0].path).toBe('config.json')
    const sourceArgs = { snapshotId: map.snapshotId, ...map.items[0], wholeFile: true }
    const { byteLength: _bytes, language: _language, ...rawSource } = sourceArgs
    const source = parseExpandSourceResultP0(data(await call(ctx, 'context_expand_source', rawSource, s)))
    expect(source.text).toBe('{"enabled":true}\n'); expect(source).not.toHaveProperty('blockId')
    const symbols = parseSymbolQueryResultP0(data(await call(ctx, 'context_symbol_query', { snapshotId: map.snapshotId, name: 'Main' }, s)))
    expect(symbols.matches[0].path).toBe('main.ts')
    const contains = parseRelationQueryResultP0(data(await call(ctx, 'context_relation_query', { snapshotId: map.snapshotId, from: { symbolId: symbols.matches[0].symbolId } }, s)))
    expect(contains.relationships[0]).toMatchObject({ type: 'contains', resolution: 'syntactic' })
    const relations = parseRelationQueryResultP0(data(await call(ctx, 'context_relation_query', { snapshotId: map.snapshotId, from: { path: 'main.ts' } }, s)))
    expect(relations.relationships).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'calls', target: { kind: 'unresolved', name: 'ping' }, resolution: 'heuristic' }), expect.objectContaining({ type: 'imports', target: { kind: 'unresolved', specifier: 'dep' } })]))
    expect(relations.indexFingerprint).toBe(symbols.indexFingerprint)
    const symbol = symbols.matches[0]
    expect(parseExpandSourceResultP0(data(await call(ctx, 'context_expand_source', { snapshotId: map.snapshotId, path: symbol.path, sourceHash: symbol.sourceHash, offsetRange: { startOffset: symbol.startOffset, endOffset: symbol.endOffset } }, s))).text).toBe('export class Main { run() { ping(); } }')
    failure(await call(ctx, 'context_repo_map', {}, other), 'access-denied')
    failure(await call(ctx, 'context_repo_map', {}), 'access-denied')
    await expect(readFile(join(first, '.dsh-context-cache', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await detach()
    expect(await call(ctx, 'context_repo_map', {}, s)).toMatchObject({ isError: true, error: { info: { code: 'SESSION_CLOSED' } } })
    await fiber.dispose()
    for (const name of names) expect(ctx.tools.get(name)).toBeUndefined()
  })
  it('maps schema prevalidation and business failures to model-visible Native DTOs, including public Session replay and retry order', async () => {
    const path = await root(), ctx = await registry()
    ctx.provide('workspaceRegistry', { async resolveByPath(p: string) { return { path: p } } } as never)
    // Existing retry policy is inside the bridge installed by apply.
    ctx.on('tools/execute', async (exec, next) => { const result = await next(); return exec.callId === ToolCallId('context_symbol_query-retry') ? next() : result })
    await mount(ctx)
    const { s } = session(ctx, path, 'native')
    const map = parseRepoMapPageP0(data(await call(ctx, 'context_repo_map', {}, s)))
    const results = [
      [await call(ctx, 'context_symbol_query', { snapshotId: map.snapshotId, name: 1 }, s), 'invalid-query'],
      [await call(ctx, 'context_symbol_query', { snapshotId: map.snapshotId, name: 'Main', extra: true }, s), 'invalid-query'],
      [await call(ctx, 'context_symbol_query', { snapshotId: sha256Utf8('old'), name: 'Main' }, s, 'retry'), 'stale-snapshot'],
      [await call(ctx, 'context_symbol_query', { snapshotId: map.snapshotId, symbolId: sha256Utf8('old-id') }, s), 'stale-symbol-id'],
      [await call(ctx, 'context_repo_map', { cursor: 'broken' }, s), 'invalid-cursor'],
    ] as const
    for (const [result, code] of results) {
      const dto = failure(result, code)
      if (code === 'stale-snapshot') expect(dto.details?.currentSnapshotId).toBe(map.snapshotId)
      s.append('tool/result', { turn: 0, step: 0, message: createToolResultMessage({ callId: ToolCallId('native-result'), content: result.content, isError: true }), error: result.error?.info, meta: result.meta }, { surfaceOp: 'append' })
      expect(s.deriveMessages().at(-1)?.content[0]).toMatchObject({ type: 'tool-result', isError: true, content: result.content })
    }
    const replay = Session.create(SessionId('replay'), s.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(s.deriveMessages())
    const receipt = map.items.find(i => i.path === 'config.json')!
    const raw = { snapshotId: map.snapshotId, path: receipt.path, sourceHash: receipt.sourceHash, wholeFile: true }
    failure(await call(ctx, 'context_expand_source', { ...raw, blockId: sha256Utf8('block') }, s), 'cache-unavailable')
    await writeFile(join(path, 'config.json'), 'different')
    expect(failure(await call(ctx, 'context_expand_source', raw, s), 'stale-source').details?.reason).toBe('content-hash-mismatch')
    expect(parseRepoMapPageP0(data(await call(ctx, 'context_repo_map', { path: 'config.json' }, s))).items[0].sourceHash).toBe(receipt.sourceHash)
    await rm(join(path, 'config.json'))
    expect(failure(await call(ctx, 'context_expand_source', raw, s), 'stale-source').details?.reason).toBe('current-file-missing')
  })
  it('shares exact final JSON budget among live Session agents/root calls, isolates other sessions, permits overlap and disabling', async () => {
    const path = await root(), ctx = await registry()
    ctx.provide('workspaceRegistry', { async resolveByPath(p: string) { return { path: p } } } as never)
    // Determine exact output size from the same runtime/version; actual debit tested through registry below.
    const probe = createResolverP0({ deploymentRoot: '.', revision: 'm2-registry' }, { async resolveByPath(p) { return { path: p } } })
    const probeSession = ctx.sessions.prepare(SessionId('probe'), { meta: { cwd: path } })
    const handle = await probe.resolve(probeSession, new AbortController().signal)
    const { expandSourceP0 } = await import('../src/p0-source.ts')
    const receipt = handle.runtime.index.snapshot.files.find(f => f.path === 'config.json')!
    const raw = { snapshotId: handle.runtime.index.snapshot.snapshotId, path: receipt.path, sourceHash: receipt.contentHash, wholeFile: true }
    const value = await expandSourceP0(handle.runtime.index, handle.runtime.reader, raw)
    const bytes = Buffer.byteLength(JSON.stringify(value)); handle.done(); await probe.dispose()
    const fiber = await mount(ctx, { sessionSourceBytes: bytes * 2 })
    const { s } = session(ctx, path, 'budget-one'), { s: second } = session(ctx, path, 'budget-two')
    const outcomes = await Promise.all(['a', 'b', 'c'].map(agent => call(ctx, 'context_expand_source', raw, s, agent)))
    expect(outcomes.filter(r => !r.isError)).toHaveLength(2)
    expect(failure(outcomes.find(r => r.isError)!, 'budget-exceeded').details).toMatchObject({ limit: 'remainingSessionBytes', remainingSessionBytes: 0, requestedOutputBytes: bytes })
    expect(data(await call(ctx, 'context_expand_source', raw, second))).toEqual(value)
    // Query errors and query outputs are never charged to the source ledger.
    failure(await call(ctx, 'context_expand_source', { ...raw, wholeFile: false }, second), 'invalid-query')
    data(await call(ctx, 'context_repo_map', {}, second))
    expect(data(await call(ctx, 'context_expand_source', raw, second, 'again'))).toEqual(value)
    await fiber.dispose()
    await mount(ctx, { sessionSourceBytes: null })
    for (let i = 0; i < 3; i++) expect(data(await call(ctx, 'context_expand_source', raw, s, `unlimited-${i}`))).toEqual(value)
  })
  it('waits for registry injection, remounts with its service generation and rejects malformed config', async () => {
    const ctx = await registry()
    const pending = ctx.plugin(apply, { deploymentRoot: '.', revision: 'wait' })
    cleanup.push(() => pending.dispose())
    let settled = false
    void Promise.resolve(pending).then(() => { settled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false); expect(ctx.tools.get('context_repo_map')).toBeUndefined()
    const registryPlugin = await ctx.plugin((c: Context) => { c.provide('workspaceRegistry', { async resolveByPath(p: string) { return { path: p } } } as never) })
    cleanup.push(() => registryPlugin.dispose())
    await pending
    const old = ctx.tools.get('context_repo_map')
    await registryPlugin.dispose()
    const replacement = await ctx.plugin((c: Context) => { c.provide('workspaceRegistry', { async resolveByPath() { return undefined } } as never) })
    cleanup.push(() => replacement.dispose())
    expect(ctx.tools.get('context_repo_map')).not.toBe(old)
    const path = await root(), { s } = session(ctx, path, 'replacement')
    failure(await call(ctx, 'context_repo_map', {}, s), 'access-denied')
    const invalid = ctx.plugin(apply, { deploymentRoot: '.', revision: 'bad', maxFiles: 0 })
    cleanup.push(() => invalid.dispose())
    await expect(Promise.resolve(invalid)).rejects.toThrow(/maxFiles|invalid config/i)
  })
  it('canonicalizes workspace aliases and rejects out-of-workspace deployment roots and absent Session cwd', async () => {
    const path = await root(), alias = `${path}-alias`
    await symlink(path, alias); cleanup.push(() => rm(alias, { force: true }))
    const ctx = await registry()
    ctx.provide('workspaceRegistry', { async resolveByPath() { return { path } } } as never)
    const fiber = await mount(ctx)
    const { s } = session(ctx, alias, 'alias')
    expect(parseRepoMapPageP0(data(await call(ctx, 'context_repo_map', {}, s))).items).toHaveLength(2)
    const absent = Session.create(SessionId('absent'))
    failure(await call(ctx, 'context_repo_map', {}, absent), 'access-denied')
    await fiber.dispose()
    await mount(ctx, { deploymentRoot: tmpdir() })
    failure(await call(ctx, 'context_repo_map', {}, s), 'access-denied')
  })
  it('retries failed initialization on a new call; emits bounded initialization phase and no fake empty page', async () => {
    const path = await root(), ctx = await registry()
    await writeFile(join(path, '.gitignore'), '!keep.ts\n')
    ctx.provide('workspaceRegistry', { async resolveByPath(p: string) { return { path: p } } } as never)
    await mount(ctx)
    const { s } = session(ctx, path, 'retry-init')
    expect(failure(await call(ctx, 'context_repo_map', {}, s), 'refresh-failed').details).toMatchObject({ phase: 'initialization', reason: 'unsupported-ignore-pattern' })
    await writeFile(join(path, '.gitignore'), '')
    expect(parseRepoMapPageP0(data(await call(ctx, 'context_repo_map', {}, s))).items).toHaveLength(3)
  })
  it('keeps cooperative initialization timeout in the Native host channel, without a business DTO', async () => {
    const path = await root(), ctx = await registry()
    let clock: ReturnType<typeof vi.spyOn> | undefined
    ctx.provide('workspaceRegistry', { async resolveByPath() {
      const later = Date.now() + 2000
      clock = vi.spyOn(Date, 'now').mockReturnValue(later)
      return { path }
    } } as never)
    await mount(ctx, { initializationTimeoutMs: 1000 })
    const { s } = session(ctx, path, 'deadline-native')
    try {
      const result = await call(ctx, 'context_repo_map', {}, s)
      expect(result).toMatchObject({ isError: true, error: { info: { code: 'TOOL_TIMEOUT' } } })
      expect(result.meta ?? {}).not.toHaveProperty('codeIntelligenceFailure')
      expect(result.content).toEqual([{ type: 'text', text: 'Error: Code intelligence initialization timed out.' }])
    } finally { clock?.mockRestore() }
  })
  it('preserves recognized caller cancellation at the default-plugin bridge while shared initialization survives', async () => {
    const path = await root(), ctx = await registry()
    let entered!: () => void, release!: () => void, lookups = 0
    const started = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    ctx.provide('workspaceRegistry', { async resolveByPath() {
      lookups++; entered(); await barrier; return { path }
    } } as never)
    await mount(ctx)
    const { s } = session(ctx, path, 'cancel-business-reason')
    const controller = new AbortController()
    const reason = new CodeIntelligenceErrorP0({ code: 'invalid-query', message: 'Caller-owned cancellation marker.' })
    const pending = call(ctx, 'context_repo_map', {}, s, 'cancelled', controller.signal)
    try {
      await started
      controller.abort(reason)
      const result = await pending
      expect(result).toMatchObject({ isError: true, error: { message: reason.message, info: { code: reason.code } } })
      expect(result.meta ?? {}).not.toHaveProperty('codeIntelligenceFailure')
      expect(result.content).toEqual([{ type: 'text', text: `Error: ${reason.message}` }])
    } finally { release() }
    expect(parseRepoMapPageP0(data(await call(ctx, 'context_repo_map', {}, s, 'survivor'))).items).toHaveLength(2)
    expect(lookups).toBe(1)
  })

  it('exports its unchanged bundle manifest and rejects unsupported non-Cordis default mounting', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.version).toBe('0.2.1')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')).toContain("name: '@han_05/dsh-code-intelligence'")
    await expect(apply({} as never, { deploymentRoot: '.', revision: 'x' })).rejects.toThrow(/Cordis/)
    expect(parseConfigP0({ deploymentRoot: '.', revision: 'x' }).sessionSourceBytes).toBe(262144)
    for (const config of [{ sessionSourceBytes: -1 }, { initializationTimeoutMs: 0 }, { deploymentRoot: '..' }, { nestedCheckoutRoots: ['a', 'a'] }, { arbitrary: true }]) expect(() => parseConfigP0({ deploymentRoot: '.', revision: 'x', ...config })).toThrow()
  })
})

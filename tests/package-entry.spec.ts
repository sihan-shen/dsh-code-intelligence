import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '@han_05/dsh-code-intelligence'

it('exposes the built plugin entry and package metadata', async () => {
  expect(plugin.name).toBe('dsh-code-intelligence')
  expect(typeof plugin.apply).toBe('function')
  expect(plugin.Config).toBeDefined()
  // M2 default is P0; V1 programmatic exports remain explicit.
  expect(typeof plugin.buildIndexP0).toBe('function')
  expect(typeof plugin.createTypeScriptAstExtractorP0).toBe('function')
  expect(typeof plugin.parseSnapshotConfigP0).toBe('function')
  expect(typeof plugin.createVerifiedReaderP0).toBe('function')
  expect(typeof plugin.registerCodeIntelligenceToolsP0).toBe('function')
  expect(typeof plugin.repoMapP0).toBe('function')
  expect(typeof plugin.symbolQueryP0).toBe('function')
  expect(typeof plugin.relationQueryP0).toBe('function')
  expect(typeof plugin.expandSourceP0).toBe('function')
  expect(typeof plugin.createToolsP0).toBe('function')
  expect(typeof plugin.createResolverP0).toBe('function')
  expect(typeof plugin.SourceBudgetP0).toBe('function')
  expect(typeof plugin.createContextCompiler).toBe('function')
  expect(plugin.provide).toEqual([])
  expect(plugin.apply.Config).toBe(plugin.Config)

  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    exports: Record<string, unknown>
    files: string[]
  }
  expect(packageJson.exports['.']).toBeDefined()
  expect(packageJson.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
  expect(packageJson.exports['./client']).toEqual({ default: './lib/client.js' })
  expect(packageJson.files).toContain('lib/client.js')
  expect(packageJson.files).toContain('README.md')
})

it('mounts the built default plugin and preserves shared HarnessError identity in the real registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm2-built-registry-'))
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() { return () => {} }, section() { return () => {} } } as never)
  ctx.provide('workspaceRegistry', { async resolveByPath(path: string) { return { path } } } as never)
  const sessions = await ctx.plugin(SessionStore)
  const tools = await ctx.plugin(ToolRuntime, { mode: 'native' })
  let fiber: { dispose(): Promise<void> } | undefined
  try {
    await writeFile(join(root, 'config.json'), '{}')
    fiber = await ctx.plugin(plugin.apply, { deploymentRoot: '.', revision: 'built-registry' })
    const session = ctx.sessions.prepare(SessionId('built'), { meta: { cwd: root } })
    const exec = { callId: ToolCallId('built'), signal: new AbortController().signal, agent: { session } as never }
    const result = await ctx.tools.execute({ ...exec, name: 'context_repo_map', arguments: { path: 'config.json' } })
    expect(result).toMatchObject({ isError: false, value: { schemaVersion: 'p0', items: [{ path: 'config.json' }] } })
    const invalid = await ctx.tools.execute({ ...exec, name: 'context_symbol_query', arguments: {} })
    expect(invalid).toMatchObject({ isError: true, error: { info: { code: 'invalid-query' } }, meta: { codeIntelligenceFailure: { code: 'invalid-query' } } })
    expect(JSON.parse((invalid.content[0] as { text: string }).text).code).toBe('invalid-query')
    expect(ctx.get('contextCompiler')).toBeUndefined()
  } finally { await fiber?.dispose(); await tools.dispose(); await sessions.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('executes real reader/AST/query/source through the built public entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm2-built-entry-'))
  try {
    await writeFile(join(root, 'config.json'), '{"ok":true}')
    await writeFile(join(root, 'main.ts'), "import 'dep'; export class Main { run() { ping(); } }")
    const index = await plugin.buildIndexP0(plugin.parseSnapshotConfigP0({ deploymentRoot: root, revision: 'entry' }))
    const map = plugin.repoMapP0(index, { path: 'config.json' })
    const source = await plugin.expandSourceP0(index, await plugin.createVerifiedReaderP0(root), {
      snapshotId: map.snapshotId, path: map.items[0].path, sourceHash: map.items[0].sourceHash, wholeFile: true,
    })
    expect(source.text).toBe('{"ok":true}')
    expect(source).not.toHaveProperty('blockId')
    const symbol = plugin.symbolQueryP0(index, { snapshotId: map.snapshotId, name: 'Main' }).matches[0]
    expect(symbol.name).toBe('Main')
    expect(plugin.relationQueryP0(index, { snapshotId: map.snapshotId, from: { symbolId: symbol.symbolId } }).relationships[0].type).toBe('contains')
    expect(plugin.relationQueryP0(index, { snapshotId: map.snapshotId, from: { path: 'main.ts' }, types: ['calls'] }).relationships[0]).toMatchObject({ resolution: 'heuristic', target: { name: 'ping' } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

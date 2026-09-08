import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRepoMapPageV1, parseSymbolQueryResultV1 } from '@han_05/dsh-context'
import { RepositorySnapshotStore } from '../src/snapshot.ts'
import { parseSnapshotConfig } from '../src/config.ts'
import { extractFallbackSymbols } from '../src/fallback.ts'
import { buildSymbolIndex } from '../src/symbol-index.ts'
import { createCodeIntelligenceTools } from '../src/tools.ts'
import { mountCodeIntelligence } from '../src/plugin.ts'

type RegisteredTool = {
  readonly name: string
  readonly execute: (args: unknown, exec: { readonly signal: AbortSignal }) => Promise<unknown>
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tools-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'auth.ts'), 'export function authenticate(token: string) { return token.length > 0 }\n')
  const config = parseSnapshotConfig({
    deploymentRoot: root,
    revision: 'tools-fixture-1',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
  })
  const store = await RepositorySnapshotStore.create(config)
  const adapter = await extractFallbackSymbols(store)
  return { store, index: buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries) }
}

function execution() {
  return { signal: new AbortController().signal }
}

function registry() {
  const values = new Map<string, RegisteredTool>()
  return {
    values,
    register(tool: RegisteredTool) {
      if (values.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`)
      values.set(tool.name, tool)
      return () => { values.delete(tool.name) }
    },
  }
}

describe('read-only code intelligence tools', () => {
  it('creates exactly two model-visible tools and no write, execution, cache, or orchestration tools', async () => {
    const { store, index } = await fixture()
    const tools = createCodeIntelligenceTools({ snapshot: store.snapshot, index })
    expect(tools.map(tool => tool.name)).toEqual(['code_repo_map', 'code_symbol_query'])
    expect(tools.map(tool => tool.parameters)).toEqual([
      expect.objectContaining({ required: ['limit'] }),
      expect.objectContaining({ required: ['query', 'limit'] }),
    ])
    expect(JSON.stringify(tools.map(tool => tool.parameters))).not.toContain('snapshotId')
    expect(tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining([
      'lsp_format', 'lsp_code_action', 'lsp_rename', 'run_code', 'source_window', 'write_file', 'code_cache', 'delegate_worker', 'targeted_verify',
    ]))
  })

  it('renders the canonical value passed as Harness render’s second argument', async () => {
    const { store, index } = await fixture()
    const [repoMap, symbolQuery] = createCodeIntelligenceTools({ snapshot: store.snapshot, index })
    const repoMapArgs = { limit: 10 }
    const repoMapValue = await repoMap.execute(repoMapArgs, execution())
    const symbolQueryArgs = { query: 'authenticate', limit: 10 }
    const symbolQueryValue = await symbolQuery.execute(symbolQueryArgs, execution())

    expect(repoMap.output.render(repoMapArgs, repoMapValue)).toEqual([{ type: 'text', text: JSON.stringify(repoMapValue) }])
    expect(symbolQuery.output.render(symbolQueryArgs, symbolQueryValue)).toEqual([{ type: 'text', text: JSON.stringify(symbolQueryValue) }])
  })

  it('rejects snapshot overrides, unknown keys, invalid bounds, overlong values, and cwd attempts', async () => {
    const { store, index } = await fixture()
    const [repoMap, symbolQuery] = createCodeIntelligenceTools({ snapshot: store.snapshot, index })
    const signal = execution()
    const snapshotId = store.snapshot.snapshotId
    await expect(repoMap.execute({ limit: 1, extra: true }, signal)).rejects.toThrow(/unknown|allowed|key/i)
    await expect(repoMap.execute({ snapshotId, limit: 1 }, signal)).rejects.toThrow(/unknown|allowed|snapshot/i)
    await expect(repoMap.execute({ limit: 0 }, signal)).rejects.toThrow(/limit/i)
    await expect(repoMap.execute({ limit: 1, cursor: 'x'.repeat(1025) }, signal)).rejects.toThrow(/cursor/i)
    await expect(repoMap.execute({ limit: 1, cwd: '/tmp' }, signal)).rejects.toThrow(/unknown|allowed|cwd|key/i)
    await expect(symbolQuery.execute({ query: 'x'.repeat(257), limit: 1 }, signal)).rejects.toThrow(/query/i)
    await expect(symbolQuery.execute({ query: 'auth', limit: 51 }, signal)).rejects.toThrow(/limit/i)
    await expect(symbolQuery.execute({ query: 'auth', limit: 1, cwd: '/tmp' }, signal)).rejects.toThrow(/unknown|allowed|cwd|key/i)
  })

  it('executes against one immutable snapshot/index and returns parsed bounded provenance', async () => {
    const { store, index } = await fixture()
    const [repoMap, symbolQuery] = createCodeIntelligenceTools({ snapshot: store.snapshot, index })
    const snapshotId = store.snapshot.snapshotId
    const map = await repoMap.execute({ limit: 10 }, execution())
    const query = await symbolQuery.execute({ query: 'authenticate', limit: 10 }, execution())
    expect(parseRepoMapPageV1(map)).toEqual(map)
    expect(parseSymbolQueryResultV1(query)).toEqual(query)
    expect(map).toMatchObject({ snapshotId })
    expect(query).toMatchObject({ snapshotId })
    expect(JSON.stringify(map)).not.toContain('export function')
    expect(JSON.stringify(query)).not.toContain('export function')
    expect(JSON.stringify(map)).not.toMatch(/\/home\/|[A-Za-z]:\\/)
    expect(JSON.stringify(query)).not.toMatch(/\/home\/|[A-Za-z]:\\/)
    expect(new TextEncoder().encode(JSON.stringify(map)).byteLength).toBeLessThanOrEqual(65_536)
    expect(new TextEncoder().encode(JSON.stringify(query)).byteLength).toBeLessThanOrEqual(65_536)
  })

  it('registers and unregisters exactly the two tools in one effect', async () => {
    const { store, index } = await fixture()
    const tools = registry()
    const effects: Array<() => void> = []
    const ctx = {
      tools,
      effect(effect: () => () => void) {
        const dispose = effect()
        effects.push(dispose)
        return dispose
      },
    }
    await mountCodeIntelligence(ctx as never, { snapshot: store.snapshot, index })
    expect([...tools.values.keys()]).toEqual(['code_repo_map', 'code_symbol_query'])
    expect(effects).toHaveLength(1)
    effects[0]!()
    expect([...tools.values.keys()]).toEqual([])
  })
})

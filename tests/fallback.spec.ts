import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson, sha256Utf8 } from '@han_05/dsh-context'
import { RepositorySnapshotStore } from '../src/snapshot.ts'
import { parseSnapshotConfig } from '../src/config.ts'
import { buildSymbolIndex, InternalSymbolIndexStore } from '../src/symbol-index.ts'
import { extractFallbackSymbols } from '../src/fallback.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(sourceByPath: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-symbols-'))
  roots.push(root)
  for (const [path, source] of Object.entries(sourceByPath)) {
    const absolute = join(root, path)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, source)
  }
  const store = await RepositorySnapshotStore.create(parseSnapshotConfig({
    deploymentRoot: root,
    revision: 'symbols-fixture-1',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
  }))
  return { root, store }
}

describe('deterministic TypeScript/JavaScript fallback symbols', () => {
  it('extracts declarations and relations across supported extensions without exposing source', async () => {
    const source = [
      'import { helper as alias } from "./dep.js"',
      'export interface 公開接口 { value: string }',
      'export type Alias = 公開接口',
      'export enum Mode { One, Two }',
      'export const value = 1, second = 2',
      'export function overloaded(value: string): string',
      'export function overloaded(value: number): string { return String(value) }',
      'export class Outer {',
      '  method(input: string) { return helper(input) }',
      '  nested() { class Inner {} return new Inner() }',
      '}',
      'export { alias as helper } from "./dep.js"',
    ].join('\n')
    const { store } = await fixture({
      'src/main.ts': source,
      'src/dep.js': 'export function helper(value) { return value }\n',
      'src/view.tsx': 'export const View = () => <div />\n',
      'src/module.mts': 'export const moduleValue = 1\n',
      'src/common.cts': 'export class Common {}\n',
      'src/module.mjs': 'export function modern() {}\n',
      'src/common.cjs': 'exports.legacy = true\nmodule.exports.named = function named() {}\nexports.malformed = ;\n',
      'src/view.jsx': 'export function Component() { return null }\n',
      'README.md': 'not a source symbol\n',
    })

    const result = await extractFallbackSymbols(store)
    const names = result.entries.map(entry => `${entry.kind}:${entry.name}`)
    for (const expected of [
      'interface:公开接口', 'type:Alias', 'enum:Mode', 'variable:value', 'variable:second',
      'function:overloaded', 'class:Outer', 'method:method', 'method:nested',
      'variable:View', 'variable:moduleValue', 'class:Common', 'function:modern', 'function:Component',
      'variable:legacy', 'variable:named', 'variable:malformed',
    ]) {
      if (expected.startsWith('interface:')) expect(names.some(name => name.includes('接口'))).toBe(true)
      else expect(names).toContain(expected)
    }
    expect(result.entries.find(entry => entry.name === 'Inner')?.container).toBe('Outer.nested')
    expect(result.entries.filter(entry => entry.name === 'overloaded')).toHaveLength(1)
    expect(result.relations).toEqual(expect.objectContaining({
      'file:src/main.ts': expect.arrayContaining([
        expect.objectContaining({ kind: 'imports', targetName: './dep.js' }),
        expect.objectContaining({ kind: 'exports', targetName: './dep.js' }),
      ]),
      'file:src/common.cjs': expect.arrayContaining([
        expect.objectContaining({ kind: 'exports', targetName: 'legacy' }),
        expect.objectContaining({ kind: 'exports', targetName: 'named' }),
        expect.objectContaining({ kind: 'exports', targetName: 'malformed' }),
      ]),
    }))
    expect(result.entries.every(entry => !Object.prototype.hasOwnProperty.call(entry, 'source'))).toBe(true)
    expect(JSON.stringify(result)).not.toContain(source)
    expect(result.entries.filter(entry => entry.path === 'src/main.ts').every(entry => entry.sourceHash === sha256Utf8(source))).toBe(true)
  })

  it('uses one-based lines, zero-based columns, real hashes, stable IDs and recovers malformed syntax', async () => {
    const source = 'export function first() {}\n\nexport const broken = ;\nexport function recovered() { return true }\n'
    const { store } = await fixture({ 'src/malformed.ts': source, 'src/unsupported.css': 'export const notATypeScriptSymbol = true' })
    const first = await extractFallbackSymbols(store)
    const second = await extractFallbackSymbols(store)
    expect(first.entries).toEqual(second.entries)
    // P0's parent-ID migration must not alter the default V1 identity formula.
    for (const entry of first.entries) {
      expect(entry.symbolId).toBe(sha256Utf8(canonicalJson([store.snapshot.snapshotId,
        entry.path, entry.kind, entry.name, entry.start, entry.end, entry.container ?? null])))
    }
    expect(first.entries.map(entry => `${entry.path}:${entry.start.line}:${entry.start.column}:${entry.kind}:${entry.name}:${entry.symbolId}`)).toEqual([...first.entries].sort((a, b) => a.path.localeCompare(b.path) || a.start.line - b.start.line || a.start.column - b.start.column || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.symbolId.localeCompare(b.symbolId)).map(entry => `${entry.path}:${entry.start.line}:${entry.start.column}:${entry.kind}:${entry.name}:${entry.symbolId}`))
    const recovered = first.entries.find(entry => entry.name === 'recovered')
    expect(recovered).toBeDefined()
    expect(recovered?.start.line).toBe(4)
    expect(recovered?.start.column).toBe(0)
    expect(recovered?.sourceHash).toBe(sha256Utf8(source))
    expect(first.entries.some(entry => entry.name === 'notATypeScriptSymbol')).toBe(false)
  })
})

describe('InternalSymbolIndexStore boundary', () => {
  it('does not consult the process cwd for snapshot-bound symbol paths', async () => {
    const { store } = await fixture({ 'src/stable.ts': 'export function stable() {}\n' })
    const adapter = await extractFallbackSymbols(store)
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('session cwd is unavailable')
    })
    try {
      expect(() => buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)).not.toThrow()
    } finally {
      cwd.mockRestore()
    }
  })

  it('freezes entries and relations and rejects stale, unknown, or duplicate input', async () => {
    const source = 'import "./dep.ts"\nexport function stable() {}\n'
    const { store } = await fixture({ 'src/stable.ts': source, 'src/dep.ts': 'export const dependency = true\n' })
    const adapter = await extractFallbackSymbols(store)
    const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
    expect(index).toBeInstanceOf(InternalSymbolIndexStore)
    expect(Object.isFrozen(index)).toBe(true)
    expect(Object.isFrozen(index.entriesForPath('src/stable.ts'))).toBe(true)
    expect(index.entriesForPath('src/stable.ts')).toHaveLength(1)
    expect(index.searchCandidates('stable')).toHaveLength(1)
    expect((index as unknown as { relationsForPath(path: string): readonly unknown[] }).relationsForPath('src/stable.ts')).toEqual([
      { kind: 'imports', targetName: './dep.ts' },
    ])
    expect(Object.keys(index)).not.toContain('toModelDto')
    expect(JSON.stringify(index)).not.toContain('stable')

    const entry = adapter.entries[0]
    const unboundAdapter = { ...adapter }
    expect(() => buildSymbolIndex(store.snapshot.snapshotId, unboundAdapter, adapter.entries)).toThrow(/trusted|receipt|snapshot/i)
    const fabricatedSnapshot = { ...store.snapshot, files: [...store.snapshot.files] }
    expect(() => Reflect.construct(InternalSymbolIndexStore as unknown as Function, [store.snapshot.snapshotId, adapter, adapter.entries, fabricatedSnapshot])).toThrow(/constructor|trusted|factory|snapshot/i)
    expect(() => buildSymbolIndex('sha256:' + '1'.repeat(64), adapter, adapter.entries)).toThrow(/snapshot/i)
    expect(() => buildSymbolIndex(store.snapshot.snapshotId, adapter, [{ ...entry, path: 'src/missing.ts' }])).toThrow(/path|file/i)
    expect(() => buildSymbolIndex(store.snapshot.snapshotId, adapter, [{ ...entry, sourceHash: 'sha256:' + '0'.repeat(64) }])).toThrow(/hash/i)
    expect(() => buildSymbolIndex(store.snapshot.snapshotId, adapter, [entry, entry])).toThrow(/duplicate/i)
    expect(() => buildSymbolIndex(store.snapshot.snapshotId, adapter, [{ ...entry, source: 'private source' } as typeof entry])).toThrow(/unknown|source/i)
    expect(() => buildSymbolIndex(store.snapshot.snapshotId, adapter, [{ ...entry, start: { ...entry.start, rawSource: 'private source' } } as typeof entry])).toThrow(/unknown|start|position/i)
    expect(() => buildSymbolIndex(store.snapshot.snapshotId, adapter, [{ ...entry, end: { ...entry.end, rawSource: 'private source' } } as typeof entry])).toThrow(/unknown|end|position/i)
  })
})

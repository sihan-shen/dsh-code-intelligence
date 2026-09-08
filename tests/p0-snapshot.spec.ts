import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Utf8, SNAPSHOT_POLICY_P0 } from '@han_05/dsh-context'
import { collectSnapshotP0, parseSnapshotConfigP0 } from '../src/p0-snapshot.ts'
import type { FileExtractorP0, SnapshotConfigP0 } from '../src/p0-types.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup() { const root = await mkdtemp(join(tmpdir(), 'p0-snapshot-')); roots.push(root); return root }
const extractor: FileExtractorP0 = {
  identity: { providerId: 'fixture', providerVersion: '1', extractionConfigVersion: '1', typescriptVersion: '5.9.3' },
  supports: file => file.language === 'typescript',
  extract: file => ({ path: file.receipt.path, sourceHash: file.receipt.contentHash, eligible: file.receipt.language === 'typescript', status: file.receipt.language === 'typescript' ? 'complete' : 'unsupported', reasons: [], diagnosticsCount: 0, symbols: [], relationships: [] }),
}
function config(root: string, overrides: Partial<SnapshotConfigP0> = {}) { return parseSnapshotConfigP0({ deploymentRoot: root, revision: 'test', ...overrides }) }

describe('P0 bounded snapshot collection', () => {
  it('normalizes shared finite defaults without changing V1 config', async () => {
    const root = await setup()
    const parsed = config(root)
    for (const [key, value] of Object.entries(SNAPSHOT_POLICY_P0)) if (key !== 'policyVersion') expect(parsed[key as keyof SnapshotConfigP0]).toBe(value)
    expect(() => config(root, { maxScanEntries: Infinity })).toThrow()
    expect(() => config(root, { maxIgnorePatterns: SNAPSHOT_POLICY_P0.maxIgnorePatterns + 1 })).toThrow()
    expect(() => parseSnapshotConfigP0({ ...parsed, unknown: 1 })).toThrow()
    expect(() => config(root, { nestedCheckoutRoots: ['../escape'] })).toThrow()
    expect(() => parseSnapshotConfigP0({ deploymentRoot: '.', revision: 'test' })).toThrow()
    expect(parseSnapshotConfigP0({ workspaceRoot: root, deploymentRoot: '.', revision: 'test' }).deploymentRoot).toBe(root)
  })
  it('counts ignored entries before bounded buffering; cannot evade maxScanEntries', async () => {
    const root = await setup()
    await writeFile(join(root, '.gitignore'), '*.ts\n')
    for (const name of ['a.ts', 'b.ts', 'c.ts']) await writeFile(join(root, name), 'x')
    let observed = 0
    await expect(collectSnapshotP0(config(root, { maxScanEntries: 2 }), extractor, {}, { onEntry: (_path, count) => { observed = count } })).rejects.toMatchObject({ code: 'refresh-failed', reason: 'max-scan-entries-exceeded' })
    expect(observed).toBe(2)
    const accepted = await collectSnapshotP0(config(root, { maxScanEntries: 4 }), extractor)
    expect(accepted.scanCoverage.observedEntries).toBe(4)
    expect(accepted.scanCoverage.skipped['excluded-by-policy']).toBe(3)
  })
  it('produces deterministic receipts/local facts sequentially, with unsupported text retained', async () => {
    const root = await setup()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'z.json'), '{}')
    await writeFile(join(root, 'src', 'a.ts'), '\uFEFFconst a = 1\r\n')
    await writeFile(join(root, 'README.md'), 'hello')
    const sequence: string[] = []
    const localExtractor: FileExtractorP0 = { ...extractor, extract: async file => {
      sequence.push(`extract:${file.receipt.path}`)
      expect(file.receipt.contentHash).toBe(sha256Utf8(file.text))
      return extractor.extract(file)
    } }
    const first = await collectSnapshotP0(config(root), localExtractor, {}, { readerHooks: { afterOpen: path => { sequence.push(`read:${path.slice(root.length + 1)}`) } } })
    const second = await collectSnapshotP0(config(root), extractor)
    expect(first).toEqual(second)
    expect(first.files.map(f => f.receipt.path)).toEqual(['README.md', 'src/a.ts', 'z.json'])
    expect(sequence).toEqual(['read:README.md', 'extract:README.md', 'read:src/a.ts', 'extract:src/a.ts', 'read:z.json', 'extract:z.json'])
    expect(first.files[0].facts.status).toBe('unsupported')
    expect(first.scanCoverage).toMatchObject({ openedDirectories: 2, observedEntries: 4, candidateFiles: 3, receiptFiles: 3 })
    expect(first.files.every(f => !('text' in f))).toBe(true)
    expect(Object.isFrozen(first.files)).toBe(true)
    expect('snapshotId' in first).toBe(false)
  })
  it('distinguishes policy, format and known overlarge skips without opening them', async () => {
    const root = await setup()
    await writeFile(join(root, 'good.ts'), 'x')
    await writeFile(join(root, 'large.ts'), 'x'.repeat(30))
    await writeFile(join(root, 'asset.png'), 'x')
    await writeFile(join(root, 'private.key'), 'x')
    await writeFile(join(root, 'nul.ts'), 'x\0')
    await writeFile(join(root, 'bad.ts'), Buffer.from([0xff]))
    await symlink(join(root, 'good.ts'), join(root, 'link.ts'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'hidden.ts'), 'x')
    const opened: string[] = []
    const collected = await collectSnapshotP0(config(root, { maxFileBytes: 10 }), extractor, {}, { readerHooks: { afterOpen: path => { opened.push(path) } } })
    expect(collected.files.map(f => f.receipt.path)).toEqual(['good.ts'])
    expect(opened.map(path => path.slice(root.length + 1))).toEqual(['bad.ts', 'good.ts', 'nul.ts'])
    expect(collected.scanCoverage).toMatchObject({ candidateFiles: 3, receiptFiles: 1, receiptBytes: 1, skipped: { 'excluded-by-policy': 3, 'unsupported-format': 3, 'file-too-large': 1 } })
  })
  it('does not refund invalid UTF8 candidates and enforces directory/total receipt caps', async () => {
    const root = await setup()
    await writeFile(join(root, 'a.ts'), Buffer.from([0xff]))
    await writeFile(join(root, 'b.ts'), '123')
    await expect(collectSnapshotP0(config(root, { maxFiles: 1 }), extractor)).rejects.toMatchObject({ reason: 'max-files-exceeded' })
    await expect(collectSnapshotP0(config(root, { maxTotalBytes: 2 }), extractor)).rejects.toMatchObject({ reason: 'max-total-bytes-exceeded' })
    await mkdir(join(root, 'sub'))
    await expect(collectSnapshotP0(config(root, { maxDirectories: 1 }), extractor)).rejects.toMatchObject({ reason: 'max-directories-exceeded' })
  })
  it.each(['!keep.ts', '!(keep).ts', '/!keep.ts'])('rejects unsupported ignore negation %s', async pattern => {
    const root = await setup(); await writeFile(join(root, '.gitignore'), pattern)
    await expect(collectSnapshotP0(config(root), extractor)).rejects.toMatchObject({ code: 'refresh-failed', reason: 'unsupported-ignore-pattern' })
  })
  it('uses inherited picomatch rules with leading slash handling, not gitignore directory slash semantics', async () => {
    const root = await setup()
    await mkdir(join(root, 'src')); await mkdir(join(root, 'dir'))
    await writeFile(join(root, '.gitignore'), '#comment\n/skip.ts\ndir/\n')
    await writeFile(join(root, 'src', '.gitignore'), '*.js\n')
    await writeFile(join(root, 'skip.ts'), 'x')
    await writeFile(join(root, 'src', 'skip.js'), 'x')
    await writeFile(join(root, 'dir', 'keep.ts'), 'x')
    expect((await collectSnapshotP0(config(root), extractor)).files.map(f => f.receipt.path)).toEqual(['.gitignore', 'dir/keep.ts', 'src/.gitignore'])
  })
  it('bounds cumulative ignore bytes/patterns and detects growth rather than skipping it', async () => {
    const root = await setup()
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, '.gitignore'), 'a\n')
    await writeFile(join(root, 'sub', '.gitignore'), 'b\n')
    await expect(collectSnapshotP0(config(root, { maxIgnoreBytes: 3 }), extractor)).rejects.toMatchObject({ reason: 'max-ignore-bytes-exceeded' })
    await expect(collectSnapshotP0(config(root, { maxIgnorePatterns: 1 }), extractor)).rejects.toMatchObject({ reason: 'max-ignore-patterns-exceeded' })
    await expect(collectSnapshotP0(config(root, { maxIgnoreBytes: 4 }), extractor, {}, { readerHooks: { afterOpen: path => appendFile(path, 'x'.repeat(30)) } })).rejects.toMatchObject({ reason: 'changed-during-read' })
  })
  it('binds an ignore receipt to the same bytes used for matching', async () => {
    const root = await setup(); await writeFile(join(root, '.gitignore'), '#a\n')
    let reads = 0
    await expect(collectSnapshotP0(config(root), extractor, {}, { readerHooks: {
      beforeOpen: async path => { if (++reads === 2) await appendFile(path, '#changed\n') },
    } })).rejects.toMatchObject({ code: 'stale-source' })
  })
  it('prunes explicit and detected nested checkouts without enumerating their contents', async () => {
    const root = await setup()
    await mkdir(join(root, 'nested', '.git'), { recursive: true })
    await mkdir(join(root, 'explicit'))
    await writeFile(join(root, 'nested', 'hidden.ts'), 'x')
    await writeFile(join(root, 'explicit', 'hidden.ts'), 'x')
    const result = await collectSnapshotP0(config(root, { nestedCheckoutRoots: ['explicit'] }), extractor)
    expect(result.files).toEqual([])
    expect(result.scanCoverage).toMatchObject({ openedDirectories: 1, observedEntries: 2, skipped: { 'excluded-by-policy': 2 } })
  })
  it('rejects nonregular ignore inputs and cancels during enumeration with handles closed', async () => {
    const root = await setup(); await mkdir(join(root, '.gitignore'))
    await expect(collectSnapshotP0(config(root), extractor)).rejects.toMatchObject({ reason: 'invalid-ignore-file' })
    await rm(join(root, '.gitignore'), { recursive: true }); await writeFile(join(root, 'a.ts'), 'x')
    const controller = new AbortController(); const reason = new Error('cancel')
    await expect(collectSnapshotP0(config(root), extractor, { signal: controller.signal }, { onEntry: () => controller.abort(reason) })).rejects.toBe(reason)
    // A fresh attempt succeeds after cancellation; no retained enumeration state.
    expect((await collectSnapshotP0(config(root), extractor)).files).toHaveLength(1)
  })
})

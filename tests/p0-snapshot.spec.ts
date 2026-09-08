import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Utf8, SNAPSHOT_POLICY_P0 } from '@han_05/dsh-context'
import { collectSnapshotP0, parseSnapshotConfigP0 } from '../src/p0-snapshot.ts'
import { createVerifiedReaderP0 } from '../src/p0-reader.ts'
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
  it.each([
    ['', 'edit'], ['', 'grow'], ['', 'delete'],
    ['src', 'edit'], ['src', 'grow'], ['src', 'delete'],
  ] as const)('reuses the first verified ignore text in %s after a later %s', async (directory, mutation) => {
    const root = await setup()
    const base = join(root, directory)
    await mkdir(base, { recursive: true })
    const ignorePath = directory ? `${directory}/.gitignore` : '.gitignore'
    const aPath = directory ? `${directory}/a.ts` : 'a.ts'
    const bPath = directory ? `${directory}/b.ts` : 'b.ts'
    const original = 'b.ts\n# initial\n'
    const updated = `a.ts\n${mutation === 'grow' ? '#'.repeat(40) : ''}`
    await writeFile(join(base, '.gitignore'), original)
    await writeFile(join(base, 'a.ts'), 'a')
    await writeFile(join(base, 'b.ts'), 'b')
    let reads = 0
    let extracts = 0
    const localExtractor: FileExtractorP0 = { ...extractor, extract(file, control) {
      if (file.receipt.path === ignorePath) {
        extracts++
        expect(file.text).toBe(original)
        expect(file.receipt.contentHash).toBe(sha256Utf8(original))
      }
      return extractor.extract(file, control)
    } }
    const settings = config(root, { maxFileBytes: 32 })
    const first = await collectSnapshotP0(settings, localExtractor, {}, { readerHooks: {
      afterClose: async path => {
        if (path !== join(base, '.gitignore')) return
        if (++reads !== 1) return
        if (mutation === 'delete') await rm(path)
        else await writeFile(path, updated)
      },
    } })
    expect(reads).toBe(1)
    expect(extracts).toBe(1)
    expect(first.files.map(file => file.receipt.path)).toEqual([ignorePath, aPath])
    expect(first.files[0].receipt).toMatchObject({ contentHash: sha256Utf8(original), byteLength: Buffer.byteLength(original) })
    expect(first.files[0].facts.sourceHash).toBe(sha256Utf8(original))
    expect(first.scanCoverage).toMatchObject({ candidateFiles: 2, receiptFiles: 2, receiptBytes: Buffer.byteLength(original) + 1,
      skipped: { 'excluded-by-policy': 1, 'unsupported-format': 0, 'file-too-large': 0 },
    })
    // Retaining a sampled receipt never makes the current on-disk source that version.
    const reader = await createVerifiedReaderP0(root)
    await expect(reader({ path: ignorePath, maxBytes: 32, expectedHash: sha256Utf8(original) })).rejects.toMatchObject({ code: 'stale-source' })
    const next = await collectSnapshotP0(settings, extractor)
    expect(next.files.map(file => file.receipt.path)).toEqual(mutation === 'delete' ? [aPath, bPath] : mutation === 'grow' ? [bPath] : [ignorePath, bPath])
    if (mutation === 'edit') expect(next.files[0].receipt.contentHash).toBe(sha256Utf8(updated))
  })
  it('charges reused ignore receipts once and still enforces candidate and total byte caps', async () => {
    const root = await setup()
    const original = '#a\n'
    await writeFile(join(root, '.gitignore'), original)
    await writeFile(join(root, 'a.ts'), 'x')
    const result = await collectSnapshotP0(config(root, { maxFiles: 2, maxTotalBytes: 4, maxIgnoreBytes: 3 }), extractor)
    expect(result.scanCoverage).toMatchObject({ candidateFiles: 2, receiptFiles: 2, receiptBytes: 4 })
    await expect(collectSnapshotP0(config(root, { maxFiles: 1 }), extractor)).rejects.toMatchObject({ reason: 'max-files-exceeded' })
    await expect(collectSnapshotP0(config(root, { maxTotalBytes: 2 }), extractor)).rejects.toMatchObject({ reason: 'max-total-bytes-exceeded' })
  })
  it('keeps receipt exclusion and size policies for the sampled ignore bytes', async () => {
    const root = await setup()
    const ignore = join(root, '.gitignore')
    await writeFile(ignore, 'a.ts\n' + '#'.repeat(40))
    await writeFile(join(root, 'a.ts'), 'a')
    await writeFile(join(root, 'b.ts'), 'b')
    let reads = 0
    const large = await collectSnapshotP0(config(root, { maxFileBytes: 32 }), extractor, {}, { readerHooks: {
      afterClose: async path => { if (path === ignore) { reads++; await writeFile(path, '#small\n') } },
    } })
    expect(reads).toBe(1)
    expect(large.files.map(file => file.receipt.path)).toEqual(['b.ts'])
    expect(large.scanCoverage).toMatchObject({ candidateFiles: 1, receiptFiles: 1, receiptBytes: 1,
      skipped: { 'excluded-by-policy': 1, 'unsupported-format': 0, 'file-too-large': 1 },
    })
    await writeFile(ignore, '.gitignore\na.ts\n')
    const excluded = await collectSnapshotP0(config(root), extractor)
    expect(excluded.files.map(file => file.receipt.path)).toEqual(['b.ts'])
    expect(excluded.scanCoverage).toMatchObject({ candidateFiles: 1, receiptFiles: 1, receiptBytes: 1,
      skipped: { 'excluded-by-policy': 2, 'unsupported-format': 0, 'file-too-large': 0 },
    })
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
  it.each(['ENOENT', 'EACCES'])('preserves enumeration cancellation carrying %s', async code => {
    const root = await setup(); await writeFile(join(root, 'a.ts'), 'x')
    const controller = new AbortController()
    const reason = Object.assign(new Error('caller cancellation'), { code })
    await expect(collectSnapshotP0(config(root), extractor, { signal: controller.signal }, {
      onEntry: () => controller.abort(reason),
    })).rejects.toBe(reason)
    expect((await collectSnapshotP0(config(root), extractor)).files).toHaveLength(1)
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

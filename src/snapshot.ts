import { lstat, opendir, open, readFile, realpath } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import picomatch from 'picomatch'
import {
  assertSafeRepoPath,
  assertSnapshotHash,
  canonicalJson,
  isIndexableFile,
  sha256Utf8,
  type IgnoreRules,
  type RepoFileSummaryV1,
  type RepositorySnapshotV1,
} from '@ds-plugins/dsh-context'
import {
  HASH_PATTERN,
  MAX_FILE_BYTES,
  MAX_IGNORE_PATTERNS,
  SNAPSHOT_POLICY_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
} from './constants.js'
import type { SnapshotConfigV1, SnapshotTestHooks, SourceMeasurementV1 } from './types.js'
import { parseSnapshotConfig } from './config.js'

type Signature = { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number; readonly mode: number }
type IgnoreRule = { readonly base: string; readonly match: (input: string) => boolean }
type ScanState = { directories: number; files: number; totalBytes: number; ignoreBytes: number; patterns: number }
type Receipt = { readonly text: string; readonly byteLength: number; readonly contentHash: string }
const CONTEXT_CACHE_DIRECTORY = '.dsh-context-cache'

function signature(stat: Stats): Signature {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode }
}

function sameSignature(first: Signature, second: Signature): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs && first.mode === second.mode
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

function languageFor(path: string): string {
  const extension = extname(path).toLowerCase()
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) return 'typescript'
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'javascript'
  return 'text'
}

function isHardExcludedDirectory(name: string): boolean {
  return name === '.git' || name === '.dsh' || name === CONTEXT_CACHE_DIRECTORY || name === 'node_modules' || name === 'upstream' || name === '.worktrees' || name.startsWith('.env')
}

function isExplicitNestedRoot(path: string, roots: readonly string[]): boolean {
  return roots.some(root => path === root || path.startsWith(`${root}/`))
}

function ignoredPath(path: string, rules: readonly IgnoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    const localPath = rule.base === '' ? path : path.startsWith(`${rule.base}/`) ? path.slice(rule.base.length + 1) : path
    if (rule.match(path) || rule.match(localPath)) ignored = true
  }
  return ignored
}

async function readIgnoreFile(root: string, directory: string, config: SnapshotConfigV1, state: ScanState): Promise<IgnoreRule[]> {
  const relativePath = directory === '' ? '.gitignore' : `${directory}/.gitignore`
  const absolutePath = join(root, ...relativePath.split('/'))
  let stat: Stats
  try {
    stat = await lstat(absolutePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return []
  assertSafeRepoPath(root, relativePath)
  const canonicalPath = await realpath(absolutePath)
  if (!contained(root, canonicalPath)) throw new Error('gitignore escapes deployment root')
  if (stat.size > config.maxIgnoreBytes || state.ignoreBytes + stat.size > config.maxIgnoreBytes) throw new Error('gitignore byte cap exceeded')
  const bytes = await readFile(absolutePath)
  if (bytes.byteLength > config.maxIgnoreBytes || state.ignoreBytes + bytes.byteLength > config.maxIgnoreBytes) throw new Error('gitignore byte cap exceeded')
  state.ignoreBytes += bytes.byteLength
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.includes('\0')) throw new Error('gitignore contains NUL bytes')
  const rules: IgnoreRule[] = []
  for (const line of text.split(/\r?\n/)) {
    const pattern = line.trim()
    if (pattern === '' || pattern.startsWith('#')) continue
    if (pattern.includes('\0')) throw new Error('gitignore contains NUL pattern')
    if (++state.patterns > MAX_IGNORE_PATTERNS) throw new Error('gitignore pattern cap exceeded')
    const normalized = pattern.startsWith('/') ? pattern.slice(1) : pattern
    rules.push({ base: directory, match: picomatch(normalized, { dot: true }) })
  }
  return rules
}

async function isNestedCheckout(absolutePath: string): Promise<boolean> {
  try {
    const marker = await lstat(join(absolutePath, '.git'))
    return (marker.isDirectory() || marker.isFile()) && !marker.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return true
  }
}

async function checkedReceipt(root: string, path: string, ignoreRules: IgnoreRules, expectedHash: string | undefined, hooks: SnapshotTestHooks | undefined): Promise<Receipt> {
  const maxBytes = ignoreRules.maxBytes
  const normalizedPath = assertSafeRepoPath(root, path)
  const absolutePath = resolve(root, ...normalizedPath.split('/'))
  const canonicalBefore = await realpath(absolutePath)
  if (!contained(root, canonicalBefore)) throw new Error('file escapes deployment root')
  const before = await lstat(absolutePath)
  if (!isIndexableFile(normalizedPath, before, ignoreRules)) throw new Error('file is not a safe bounded regular file')
  const beforeSignature = signature(before)
  const handle = await open(absolutePath, 'r')
  try {
    await hooks?.afterOpenForTest?.(absolutePath)
    const bytes = await handle.readFile()
    if (bytes.byteLength > maxBytes) throw new Error('file exceeds byte cap')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error('file is not valid UTF-8')
    }
    if (text.includes('\0')) throw new Error('file contains NUL bytes')
    const after = await lstat(absolutePath)
    const canonicalAfter = await realpath(absolutePath)
    if (!after.isFile() || after.isSymbolicLink() || !sameSignature(beforeSignature, signature(after)) || !contained(root, canonicalAfter)) throw new Error('file changed during verified read')
    const byteLength = new TextEncoder().encode(text).byteLength
    if (byteLength !== bytes.byteLength) throw new Error('UTF-8 byte length mismatch')
    const contentHash = sha256Utf8(text)
    if (!HASH_PATTERN.test(contentHash)) throw new Error('computed source hash is invalid')
    if (expectedHash !== undefined) {
      if (!HASH_PATTERN.test(expectedHash)) throw new Error('expected source hash is invalid')
      assertSnapshotHash(expectedHash, contentHash)
    }
    return { text, byteLength, contentHash }
  } finally {
    await handle.close()
  }
}

export class RepositorySnapshotStore {
  readonly #root: string
  readonly #config: SnapshotConfigV1
  readonly #snapshotValue: RepositorySnapshotV1
  readonly #hooks?: SnapshotTestHooks

  private constructor(root: string, config: SnapshotConfigV1, snapshot: RepositorySnapshotV1, hooks?: SnapshotTestHooks) {
    this.#root = root
    this.#config = config
    this.#snapshotValue = snapshot
    this.#hooks = hooks
  }

  static async create(config: SnapshotConfigV1, hooks?: SnapshotTestHooks): Promise<RepositorySnapshotStore> {
    const parsed = parseSnapshotConfig(config)
    const state: ScanState = { directories: 0, files: 0, totalBytes: 0, ignoreBytes: 0, patterns: 0 }
    const summaries: RepoFileSummaryV1[] = []
    const scan = async (directory: string, inheritedRules: readonly IgnoreRule[] = []): Promise<void> => {
      if (++state.directories > parsed.maxDirectories) throw new Error('directory cap exceeded')
      const localRules = await readIgnoreFile(parsed.deploymentRoot, directory, parsed, state)
      const rules = [...inheritedRules, ...localRules]
      const absoluteDirectory = directory === '' ? parsed.deploymentRoot : resolve(parsed.deploymentRoot, ...directory.split('/'))
      const entries: Dirent[] = []
      const handle = await opendir(absoluteDirectory)
      for await (const entry of handle) entries.push(entry)
      entries.sort((first, second) => first.name < second.name ? -1 : first.name > second.name ? 1 : 0)
      for (const entry of entries) {
        if (entry.name.includes('\0')) throw new Error('directory entry contains NUL')
        const path = directory === '' ? entry.name : `${directory}/${entry.name}`
        if (ignoredPath(path, rules)) continue
        if (isHardExcludedDirectory(entry.name)) continue
        if (isExplicitNestedRoot(path, parsed.nestedCheckoutRoots)) continue
        const absolutePath = resolve(parsed.deploymentRoot, ...path.split('/'))
        const stat = await lstat(absolutePath)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) {
          if (await isNestedCheckout(absolutePath)) continue
          await scan(path, rules)
          continue
        }
        const ignoreRules: IgnoreRules = { maxBytes: parsed.maxFileBytes, isIgnored: candidate => ignoredPath(candidate, rules), nestedCheckoutRoots: parsed.nestedCheckoutRoots }
        if (!isIndexableFile(path, stat, ignoreRules)) continue
        if (++state.files > parsed.maxFiles) throw new Error('file cap exceeded')
        if (state.totalBytes + stat.size > parsed.maxTotalBytes) throw new Error('total byte cap exceeded')
        let receipt: Receipt
        try {
          receipt = await checkedReceipt(parsed.deploymentRoot, path, ignoreRules, undefined, undefined)
        } catch (error) {
          if (error instanceof Error && (error.message === 'file contains NUL bytes' || error.message === 'file is not valid UTF-8')) continue
          throw error
        }
        state.totalBytes += receipt.byteLength
        if (state.totalBytes > parsed.maxTotalBytes) throw new Error('total byte cap exceeded')
        summaries.push(Object.freeze({ path, contentHash: receipt.contentHash, byteLength: receipt.byteLength, language: languageFor(path) }))
      }
    }
    await scan('')
    summaries.sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0)
    const workspaceFingerprint = sha256Utf8(parsed.deploymentRoot)
    const snapshotId = sha256Utf8(canonicalJson({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, workspaceFingerprint, revision: parsed.revision, files: summaries, policyVersion: SNAPSHOT_POLICY_VERSION }))
    const snapshot = Object.freeze({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, snapshotId, workspaceFingerprint, revision: parsed.revision, files: Object.freeze(summaries) })
    return new RepositorySnapshotStore(parsed.deploymentRoot, parsed, snapshot, hooks)
  }

  get snapshot(): RepositorySnapshotV1 {
    return this.#snapshotValue
  }

  async readVerifiedFile(path: string, expectedHash: string): Promise<string> {
    const summary = this.#snapshotValue.files.find(file => file.path === path)
    if (!summary) throw new Error('path is not present in this snapshot')
    assertSnapshotHash(summary.contentHash, expectedHash)
    const ignoreRules: IgnoreRules = { maxBytes: Math.min(this.#config.maxFileBytes, MAX_FILE_BYTES), nestedCheckoutRoots: this.#config.nestedCheckoutRoots }
    return (await checkedReceipt(this.#root, path, ignoreRules, expectedHash, this.#hooks)).text
  }

  async readSourceMeasurement(path: string, sourceHash: string, startOffset: number, endOffset: number): Promise<SourceMeasurementV1> {
    if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) || startOffset < 0 || endOffset < startOffset) throw new TypeError('source offsets must be ordered non-negative UTF-16 offsets')
    const text = await this.readVerifiedFile(path, sourceHash)
    if (endOffset > text.length) throw new RangeError('source window exceeds UTF-16 source length')
    const measurement = { path, sourceHash, startOffset, endOffset, text: text.slice(startOffset, endOffset), byteLength: new TextEncoder().encode(text.slice(startOffset, endOffset)).byteLength }
    return Object.freeze(measurement)
  }
}

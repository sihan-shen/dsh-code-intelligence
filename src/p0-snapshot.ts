import { realpathSync, statSync, type Dirent } from 'node:fs'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import picomatch from 'picomatch'
import { isIndexableFile, normalizeRepoPath, sha256Utf8, SNAPSHOT_POLICY_P0, type ScanCoverageP0 } from '@han_05/dsh-context'
import { checkBuildControlP0, containedP0, createVerifiedReaderP0, excludedPathP0, P0ReadError, type VerifiedReaderHooksP0 } from './p0-reader.js'
import type { BuildControlP0, CollectedFileP0, CollectedSnapshotP0, FileExtractorP0, SnapshotConfigP0, VerifiedReaderP0 } from './p0-types.js'

const LIMIT_KEYS = ['maxFileBytes', 'maxFiles', 'maxTotalBytes', 'maxDirectories', 'maxScanEntries', 'maxIgnoreBytes', 'maxIgnorePatterns'] as const

/** P0-only normalization. Omitted limits use the single shared policy, never V1 defaults. */
export function parseSnapshotConfigP0(value: unknown): SnapshotConfigP0 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('snapshot config must be an object')
  const input = value as Record<string, unknown>
  const allowed: readonly string[] = ['workspaceRoot', 'deploymentRoot', 'revision', 'nestedCheckoutRoots', ...LIMIT_KEYS]
  for (const key of Reflect.ownKeys(input)) if (typeof key !== 'string' || !allowed.includes(key)) throw new TypeError('unknown snapshot config key')
  const string = (item: unknown): string => {
    if (typeof item !== 'string' || item.trim() === '' || item.includes('\0')) throw new TypeError('expected non-empty string')
    return item
  }
  const directory = (path: string): string => {
    const canonical = realpathSync(path)
    if (!statSync(canonical).isDirectory()) throw new TypeError('root must be a directory')
    return canonical
  }
  let workspaceRoot: string | undefined
  if (input.workspaceRoot !== undefined) {
    const workspace = string(input.workspaceRoot)
    if (!isAbsolute(workspace)) throw new TypeError('workspaceRoot must be absolute')
    workspaceRoot = directory(workspace)
  }
  const rootInput = string(input.deploymentRoot)
  if (!isAbsolute(rootInput)) {
    if (!workspaceRoot) throw new TypeError('relative deploymentRoot requires workspaceRoot')
    if (rootInput !== '.') normalizeRepoPath(workspaceRoot, rootInput)
  }
  const deploymentRoot = directory(isAbsolute(rootInput) ? rootInput : resolve(workspaceRoot!, rootInput))
  if (workspaceRoot && workspaceRoot !== deploymentRoot && !containedP0(workspaceRoot, deploymentRoot)) throw new TypeError('deploymentRoot must be inside workspaceRoot')
  const limits = {} as Pick<SnapshotConfigP0, typeof LIMIT_KEYS[number]>
  for (const key of LIMIT_KEYS) {
    const limit = input[key] === undefined ? SNAPSHOT_POLICY_P0[key] : input[key]
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > SNAPSHOT_POLICY_P0[key]) throw new TypeError(`invalid ${key}`)
    Object.assign(limits, { [key]: limit })
  }
  const roots = input.nestedCheckoutRoots ?? []
  if (!Array.isArray(roots) || roots.length > limits.maxDirectories) throw new TypeError('invalid nestedCheckoutRoots')
  const nestedCheckoutRoots = roots.map(item => normalizeRepoPath(deploymentRoot, string(item)))
  if (new Set(nestedCheckoutRoots).size !== nestedCheckoutRoots.length) throw new TypeError('duplicate nestedCheckoutRoots')
  return Object.freeze({ ...(workspaceRoot ? { workspaceRoot } : {}), deploymentRoot, revision: string(input.revision), ...limits, nestedCheckoutRoots: Object.freeze(nestedCheckoutRoots) })
}

type IgnoreRule = { base: string; match: (path: string) => boolean }
export type SnapshotHooksP0 = {
  readonly readerHooks?: VerifiedReaderHooksP0
  /** Trusted internal reader injection; replacement must fulfill VerifiedReaderP0. */
  readonly reader?: VerifiedReaderP0
  readonly onEntry?: (path: string, observedEntries: number) => void | Promise<void>
}

function ignored(path: string, rules: readonly IgnoreRule[]): boolean {
  return rules.some(rule => rule.match(path) || rule.match(rule.base === '' ? path : path.slice(rule.base.length + 1)))
}

/** One collection attempt, no publication/retry or final IDs. Only one source/AST at a time. */
export async function collectSnapshotP0(config: SnapshotConfigP0, extractor: FileExtractorP0, control: BuildControlP0 = {}, hooks: SnapshotHooksP0 = {}): Promise<CollectedSnapshotP0> {
  checkBuildControlP0(control)
  const parsed = parseSnapshotConfigP0(config)
  const root = parsed.deploymentRoot
  const reader = hooks.reader ?? await createVerifiedReaderP0(root, hooks.readerHooks)
  const coverage = { openedDirectories: 0, observedEntries: 0, candidateFiles: 0, receiptFiles: 0, receiptBytes: 0, skipped: { 'excluded-by-policy': 0, 'unsupported-format': 0, 'file-too-large': 0 } }
  let ignoreBytes = 0
  let patterns = 0
  const files: CollectedFileP0[] = []
  const scan = async (directory: string, inherited: readonly IgnoreRule[]): Promise<void> => {
    checkBuildControlP0(control)
    if (coverage.openedDirectories >= parsed.maxDirectories) throw new P0ReadError('refresh-failed', 'max-directories-exceeded')
    const absolute = directory === '' ? root : resolve(root, ...directory.split('/'))
    const before = await lstat(absolute, { bigint: true })
    const canonical = await realpath(absolute)
    if (!before.isDirectory() || before.isSymbolicLink() || (canonical !== root && !containedP0(root, canonical))) throw new P0ReadError('access-denied', 'excluded-by-policy')
    const handle = await opendir(absolute, { bufferSize: 1 })
    coverage.openedDirectories++
    const entries: Dirent[] = []
    try {
      while (true) {
        checkBuildControlP0(control)
        const entry = await handle.read()
        if (entry === null) break
        coverage.observedEntries++
        checkBuildControlP0(control)
        if (coverage.observedEntries > parsed.maxScanEntries) throw new P0ReadError('refresh-failed', 'max-scan-entries-exceeded')
        const path = directory === '' ? entry.name : `${directory}/${entry.name}`
        await hooks.onEntry?.(path, coverage.observedEntries)
        checkBuildControlP0(control)
        entries.push(entry)
      }
    } finally { await handle.close() }
    const after = await lstat(absolute, { bigint: true })
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || canonical !== await realpath(absolute)) throw new P0ReadError('stale-source', 'changed-during-read')
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const rules = [...inherited]
    let ignoreHash: string | undefined
    if (entries.some(entry => entry.name === '.gitignore')) {
      const path = directory === '' ? '.gitignore' : `${directory}/.gitignore`
      const initial = await lstat(join(absolute, '.gitignore'))
      if (!initial.isFile() || initial.isSymbolicLink()) throw new P0ReadError('refresh-failed', 'invalid-ignore-file')
      if (initial.size > parsed.maxIgnoreBytes - ignoreBytes) throw new P0ReadError('refresh-failed', 'max-ignore-bytes-exceeded')
      let file
      try { file = await reader({ ...control, path, maxBytes: parsed.maxIgnoreBytes - ignoreBytes }) } catch (error) {
        if (error instanceof P0ReadError && error.reason === 'unsupported-format') throw new P0ReadError('refresh-failed', 'invalid-ignore-file')
        if (error instanceof P0ReadError && error.reason === 'file-too-large') throw new P0ReadError('stale-source', 'changed-during-read')
        throw error
      }
      ignoreBytes += file.receipt.byteLength
      ignoreHash = file.receipt.contentHash
      // split is bounded by the already bounded cumulative ignore bytes.
      for (const line of file.text.split(/\r?\n/)) {
        checkBuildControlP0(control)
        const pattern = line.trim()
        if (pattern === '' || pattern.startsWith('#')) continue
        if (++patterns > parsed.maxIgnorePatterns) throw new P0ReadError('refresh-failed', 'max-ignore-patterns-exceeded')
        const normalized = pattern.startsWith('/') ? pattern.slice(1) : pattern
        if (pattern.startsWith('!') || normalized.startsWith('!')) throw new P0ReadError('refresh-failed', 'unsupported-ignore-pattern')
        // Keep V1 picomatch syntax except explicitly disable its negate interpretation.
        const options = { dot: true, nonegate: true }
        rules.push({ base: directory, match: picomatch(normalized, options) })
      }
    }
    for (const entry of entries) {
      checkBuildControlP0(control)
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`
      if (excludedPathP0(path, parsed.nestedCheckoutRoots) || ignored(path, rules)) { coverage.skipped['excluded-by-policy']++; continue }
      normalizeRepoPath(root, path)
      const absolutePath = resolve(root, ...path.split('/'))
      const initial = await lstat(absolutePath)
      if (initial.isSymbolicLink() || (!initial.isFile() && !initial.isDirectory())) { coverage.skipped['excluded-by-policy']++; continue }
      if (initial.isDirectory()) {
        let nested = false
        try {
          const marker = await lstat(join(absolutePath, '.git'))
          nested = !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (nested) { coverage.skipped['excluded-by-policy']++; continue }
        await scan(path, rules)
        continue
      }
      if (!isIndexableFile(path, { isFile: () => true, isSymbolicLink: () => false, size: 0 }, { maxBytes: parsed.maxFileBytes })) { coverage.skipped['unsupported-format']++; continue }
      if (initial.size > parsed.maxFileBytes) { coverage.skipped['file-too-large']++; continue }
      if (++coverage.candidateFiles > parsed.maxFiles) throw new P0ReadError('refresh-failed', 'max-files-exceeded')
      let file
      try { file = await reader({ ...control, path, maxBytes: parsed.maxFileBytes, ...(entry.name === '.gitignore' && ignoreHash !== undefined ? { expectedHash: ignoreHash } : {}) }) } catch (error) {
        if (error instanceof P0ReadError && error.reason === 'unsupported-format') { coverage.skipped['unsupported-format']++; continue }
        if (error instanceof P0ReadError && error.reason === 'file-too-large') throw new P0ReadError('stale-source', 'changed-during-read')
        throw error
      }
      if (coverage.receiptBytes + file.receipt.byteLength > parsed.maxTotalBytes) throw new P0ReadError('refresh-failed', 'max-total-bytes-exceeded')
      coverage.receiptBytes += file.receipt.byteLength
      coverage.receiptFiles++
      checkBuildControlP0(control)
      // Extractor owns local failure isolation; F5 owns validation, not this scanner.
      const facts = await extractor.extract(file, control)
      checkBuildControlP0(control)
      files.push(Object.freeze({ receipt: file.receipt, lineMap: file.lineMap, facts }))
    }
  }
  try { await scan('', []) } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new P0ReadError('stale-source', 'current-file-missing')
    if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') throw new P0ReadError('access-denied', 'excluded-by-policy')
    throw error
  }
  checkBuildControlP0(control)
  files.sort((a, b) => a.receipt.path < b.receipt.path ? -1 : a.receipt.path > b.receipt.path ? 1 : 0)
  const scanCoverage: ScanCoverageP0 = Object.freeze({ ...coverage, skipped: Object.freeze(coverage.skipped) })
  return Object.freeze({ workspaceFingerprint: sha256Utf8(root), revision: parsed.revision, files: Object.freeze(files), scanCoverage })
}

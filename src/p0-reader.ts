import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { isIndexableFile, normalizeRepoPath, SNAPSHOT_POLICY_P0, type CodeIntelligenceFailureCodeP0 } from '@han_05/dsh-context'
import { createCanonicalLineMapP0 } from './p0-line-map.js'
import type { BuildControlP0, VerifiedReaderP0, VerifiedReadRequestP0, VerifiedFileP0 } from './p0-types.js'

export type ReadReasonP0 = 'changed-during-read' | 'current-file-missing' | 'content-hash-mismatch' | 'file-too-large' | 'unsupported-format' | 'excluded-by-policy' | 'invalid-query'
export type ScanFailureReasonP0 = 'max-files-exceeded' | 'max-directories-exceeded' | 'max-scan-entries-exceeded' | 'max-total-bytes-exceeded' | 'max-ignore-bytes-exceeded' | 'max-ignore-patterns-exceeded' | 'unsupported-ignore-pattern' | 'invalid-ignore-file'
/** Internal business error, not a host envelope. Unknown I/O errors are not wrapped. */
export class P0ReadError extends Error {
  readonly details: Readonly<{ reason: string }>
  constructor(readonly code: CodeIntelligenceFailureCodeP0, readonly reason: ReadReasonP0 | ScanFailureReasonP0) {
    super(reason)
    this.name = 'P0ReadError'
    // Format/policy classifications are internal skip reasons, not new wire reason enums.
    this.details = Object.freeze({ reason: ['file-too-large', 'unsupported-format', 'excluded-by-policy', 'invalid-ignore-file'].includes(reason) ? 'read-failed' : reason === 'invalid-query' ? 'contract-invalid' : reason })
  }
}

export function checkBuildControlP0(control: BuildControlP0 = {}): void {
  control.signal?.throwIfAborted()
  if (control.deadlineMs !== undefined) {
    if (!Number.isFinite(control.deadlineMs)) throw new TypeError('deadlineMs must be finite')
    if (Date.now() >= control.deadlineMs) throw new DOMException('Build deadline exceeded', 'TimeoutError')
  }
}

export function containedP0(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export function excludedPathP0(path: string, nestedRoots: readonly string[] = []): boolean {
  return path.split('/').some(part => ['.git', '.dsh', '.dsh-context-cache', 'node_modules', 'upstream', '.worktrees'].includes(part) || part.startsWith('.env') || /\.(pem|key|p12|pfx|jks|der)$/i.test(part)) || nestedRoots.some(root => path === root || path.startsWith(`${root}/`))
}

function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
}

/** Test-only deterministic boundaries; never receive or return source replacements. */
export type VerifiedReaderHooksP0 = {
  readonly beforeOpen?: (absolutePath: string) => void | Promise<void>
  readonly afterOpen?: (absolutePath: string, handle: FileHandle) => void | Promise<void>
  readonly afterRead?: (absolutePath: string, handle: FileHandle, byteLength: number) => void | Promise<void>
  readonly afterClose?: (absolutePath: string, handle: FileHandle) => void | Promise<void>
}

function ioFailure(error: unknown): never {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new P0ReadError('stale-source', 'current-file-missing')
  if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') throw new P0ReadError('access-denied', 'excluded-by-policy')
  throw error
}

function languageFor(path: string): string {
  const extension = extname(path).toLowerCase()
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) return 'typescript'
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'javascript'
  return 'text'
}

/** Ordinary concurrent edits only: realpath/lstat/fstat are NOT atomic ancestor-swap isolation.
 * Caller owns workspace authorization, ignore policy and snapshot receipt membership. */
export async function createVerifiedReaderP0(deploymentRoot: string, hooks?: VerifiedReaderHooksP0): Promise<VerifiedReaderP0> {
  const root = await realpath(deploymentRoot)
  if (!(await stat(root)).isDirectory()) throw new TypeError('deploymentRoot must be a directory')
  return async (request: VerifiedReadRequestP0): Promise<VerifiedFileP0> => {
    checkBuildControlP0(request)
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0 || request.maxBytes > SNAPSHOT_POLICY_P0.maxFileBytes || (request.expectedHash !== undefined && !/^sha256:[0-9a-f]{64}$/.test(request.expectedHash))) throw new P0ReadError('invalid-query', 'invalid-query')
    let path: string
    try { path = normalizeRepoPath(root, request.path) } catch { throw new P0ReadError('access-denied', 'excluded-by-policy') }
    if (excludedPathP0(path)) throw new P0ReadError('access-denied', 'excluded-by-policy')
    const absolutePath = resolve(root, ...path.split('/'))
    try {
      const before = await lstat(absolutePath, { bigint: true })
      if (!before.isFile() || before.isSymbolicLink()) throw new P0ReadError('access-denied', 'excluded-by-policy')
      const canonicalBefore = await realpath(absolutePath)
      if (!containedP0(root, canonicalBefore)) throw new P0ReadError('access-denied', 'excluded-by-policy')
      if (!isIndexableFile(path, { isFile: () => true, isSymbolicLink: () => false, size: 0 }, { maxBytes: request.maxBytes })) throw new P0ReadError('access-denied', 'excluded-by-policy')
      if (before.size > BigInt(request.maxBytes)) throw new P0ReadError(request.expectedHash === undefined ? 'refresh-failed' : 'stale-source', request.expectedHash === undefined ? 'file-too-large' : 'changed-during-read')
      checkBuildControlP0(request)
      await hooks?.beforeOpen?.(absolutePath)
      checkBuildControlP0(request)
      // O_NONBLOCK prevents a FIFO replacement from blocking open; fstat rejects it before read.
      const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const opened = await handle.stat({ bigint: true })
        if (!opened.isFile() || !sameStat(before, opened)) throw new P0ReadError('stale-source', 'changed-during-read')
        await hooks?.afterOpen?.(absolutePath, handle)
        const bytes = Buffer.allocUnsafe(request.maxBytes + 1)
        let length = 0
        while (length < bytes.length) {
          checkBuildControlP0(request)
          const result = await handle.read(bytes, length, Math.min(65_536, bytes.length - length), length)
          if (result.bytesRead === 0) break
          length += result.bytesRead
        }
        await hooks?.afterRead?.(absolutePath, handle, length)
        checkBuildControlP0(request)
        const afterDescriptor = await handle.stat({ bigint: true })
        const afterPath = await lstat(absolutePath, { bigint: true })
        const canonicalAfter = await realpath(absolutePath)
        if (!containedP0(root, canonicalAfter)) throw new P0ReadError('access-denied', 'excluded-by-policy')
        if (canonicalBefore !== canonicalAfter || !afterPath.isFile() || afterPath.isSymbolicLink() || !sameStat(opened, afterDescriptor) || !sameStat(opened, afterPath) || length > request.maxBytes || BigInt(length) !== opened.size) throw new P0ReadError('stale-source', 'changed-during-read')
        const content = bytes.subarray(0, length)
        const contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`
        if (request.expectedHash !== undefined && contentHash !== request.expectedHash) throw new P0ReadError('stale-source', 'content-hash-mismatch')
        let text: string
        try {
          // ignoreBOM means preserve U+FEFF, rather than strip it from offsets/hash text.
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content)
        } catch { throw new P0ReadError('refresh-failed', 'unsupported-format') }
        if (text.includes('\0')) throw new P0ReadError('refresh-failed', 'unsupported-format')
        checkBuildControlP0(request)
        return Object.freeze({ receipt: Object.freeze({ path, contentHash, byteLength: length, language: languageFor(path) }), text, lineMap: createCanonicalLineMapP0(text) })
      } finally {
        await handle.close()
        await hooks?.afterClose?.(absolutePath, handle)
      }
    } catch (error) { return ioFailure(error) }
  }
}

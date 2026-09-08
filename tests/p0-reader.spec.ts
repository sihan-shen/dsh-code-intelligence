import { mkdtemp, rm, writeFile, appendFile, unlink, symlink, mkdir, utimes } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Utf8 } from '@han_05/dsh-context'
import { createVerifiedReaderP0, P0ReadError } from '../src/p0-reader.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup(content: string | Buffer = 'abc') {
  const root = await mkdtemp(join(tmpdir(), 'p0-reader-')); roots.push(root)
  const path = join(root, 'a.ts'); await writeFile(path, content)
  return { root, path }
}

describe('P0 verified reader', () => {
  it('reads exact bytes/text including BOM and needs no expected hash or snapshot', async () => {
    const text = '\uFEFFconst 😀x = "é"\r\n'
    const { root } = await setup(text)
    const reader = await createVerifiedReaderP0(root)
    const file = await reader({ path: 'a.ts', maxBytes: Buffer.byteLength(text) })
    expect(file.text).toBe(text)
    expect(file.receipt).toEqual({ path: 'a.ts', contentHash: sha256Utf8(text), byteLength: Buffer.byteLength(text), language: 'typescript' })
    expect(file.lineMap.textLength).toBe(text.length)
    await expect(reader({ path: 'a.ts', maxBytes: 100, expectedHash: sha256Utf8('other') })).rejects.toMatchObject({ code: 'stale-source', reason: 'content-hash-mismatch' })
  })
  it('skips known overlarge before opening and bounds growth to max+1', async () => {
    const { root, path } = await setup('abcd')
    let opens = 0
    const early = await createVerifiedReaderP0(root, { afterOpen: () => { opens++ } })
    await expect(early({ path: 'a.ts', maxBytes: 3 })).rejects.toMatchObject({ reason: 'file-too-large' })
    expect(opens).toBe(0)
    await writeFile(path, 'abc')
    let bytes = 0
    let closed: FileHandle | undefined
    const growing = await createVerifiedReaderP0(root, {
      afterOpen: async () => { await appendFile(path, 'x'.repeat(1000)) },
      afterRead: (_path, _handle, length) => { bytes = length },
      afterClose: (_path, handle) => { closed = handle },
    })
    await expect(growing({ path: 'a.ts', maxBytes: 3 })).rejects.toMatchObject({ code: 'stale-source', reason: 'changed-during-read' })
    expect(bytes).toBe(4)
    await expect(closed!.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })
  it.each(['change', 'delete', 'replace'] as const)('rejects deterministic %s after open and closes descriptor', async mutation => {
    const { root, path } = await setup()
    let closed: FileHandle | undefined
    const reader = await createVerifiedReaderP0(root, {
      afterOpen: async () => {
        if (mutation === 'change') { await writeFile(path, 'xyz'); await utimes(path, 1, 1) }
        else { await unlink(path); if (mutation === 'replace') await writeFile(path, 'abc') }
      },
      afterClose: (_path, handle) => { closed = handle },
    })
    await expect(reader({ path: 'a.ts', maxBytes: 10 })).rejects.toBeInstanceOf(P0ReadError)
    await expect(closed!.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })
  it.each([Buffer.from([0xc3, 0x28]), Buffer.from('x\0y')])('rejects unsupported bytes without partial text', async bytes => {
    const { root } = await setup(bytes)
    const reader = await createVerifiedReaderP0(root)
    await expect(reader({ path: 'a.ts', maxBytes: 20 })).rejects.toMatchObject({ reason: 'unsupported-format' })
  })
  it('rechecks descriptor metadata after bytes are read and preserves unknown I/O errors', async () => {
    const { root, path } = await setup()
    const reader = await createVerifiedReaderP0(root, { afterRead: async () => { await utimes(path, 1, 1) } })
    await expect(reader({ path: 'a.ts', maxBytes: 20 })).rejects.toMatchObject({ reason: 'changed-during-read' })
    const unknown = Object.assign(new Error('test disk error'), { code: 'EIO' })
    const failing = await createVerifiedReaderP0(root, { afterOpen: () => { throw unknown } })
    await expect(failing({ path: 'a.ts', maxBytes: 20 })).rejects.toBe(unknown)
  })
  it('preserves abort reason, checks deadline, and closes an open handle on cancellation', async () => {
    const { root } = await setup()
    const controller = new AbortController()
    const reason = new Error('cancelled test')
    let closed: FileHandle | undefined
    const reader = await createVerifiedReaderP0(root, { afterOpen: () => controller.abort(reason), afterClose: (_path, handle) => { closed = handle } })
    await expect(reader({ path: 'a.ts', maxBytes: 20, signal: controller.signal })).rejects.toBe(reason)
    await expect(closed!.stat()).rejects.toMatchObject({ code: 'EBADF' })
    await expect(reader({ path: 'a.ts', maxBytes: 20, deadlineMs: 0 })).rejects.toMatchObject({ name: 'TimeoutError' })
  })
  it('rejects traversal, hard exclusions, nonregular files and symlink containment escape', async () => {
    const { root } = await setup()
    const outside = await setup()
    await symlink(outside.path, join(root, 'link.ts'))
    await mkdir(join(root, 'dir.ts'))
    await writeFile(join(root, '.env'), 'secret')
    const reader = await createVerifiedReaderP0(root)
    for (const path of ['../a.ts', '.env', 'link.ts', 'dir.ts']) await expect(reader({ path, maxBytes: 20 })).rejects.toMatchObject({ code: 'access-denied' })
    await expect(reader({ path: 'missing.ts', maxBytes: 20 })).rejects.toMatchObject({ code: 'stale-source', reason: 'current-file-missing' })
  })
  it.skipIf(process.platform === 'win32')('does not block when a regular file is replaced by FIFO before open', async () => {
    const { root, path } = await setup()
    let closed: FileHandle | undefined
    const reader = await createVerifiedReaderP0(root, {
      beforeOpen: async () => { await unlink(path); execFileSync('mkfifo', [path]) },
      afterClose: (_path, handle) => { closed = handle },
    })
    await expect(reader({ path: 'a.ts', maxBytes: 20 })).rejects.toMatchObject({ reason: 'changed-during-read' })
    await expect(closed!.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })
})

import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { sha256Utf8, OUTPUT_POLICY_P0 as O } from '@han_05/dsh-context'
import { buildIndexP0 } from '../src/p0-build.ts'
import { parseSnapshotConfigP0 } from '../src/p0-snapshot.ts'
import { createVerifiedReaderP0, P0ReadError } from '../src/p0-reader.ts'
import { expandSourceP0, SourceBudgetP0 } from '../src/p0-source.ts'
import { createToolsP0 } from '../src/p0-tools.ts'
import type { ResolverP0 } from '../src/p0-runtime.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))) })
async function fixture(text = 'α😀\r\nB\rC\u2028D\u2029E\n') {
  const root = await mkdtemp(join(tmpdir(), 'm2-source-')); roots.push(root)
  await writeFile(join(root, 'data.json'), text)
  const config = parseSnapshotConfigP0({ deploymentRoot: root, revision: 'source' })
  const index = await buildIndexP0(config), reader = await createVerifiedReaderP0(root)
  const request = { snapshotId: index.snapshot.snapshotId, path: 'data.json', sourceHash: index.snapshot.files[0].contentHash }
  return { root, index, reader, request, config, text }
}
it('reads all explicit range modes using the same canonical UTF-16 line map and padding rules', async () => {
  const f = await fixture()
  const read = (range: object) => expandSourceP0(f.index, f.reader, { ...f.request, ...range })
  expect((await read({ wholeFile: true })).text).toBe(f.text)
  expect(await read({ lineRange: { startLine: 1, endLine: 2 } })).toMatchObject({ text: 'α😀\r\nB\r', startOffset: 0, endOffset: 7, start: { line: 1, column: 0 }, end: { line: 3, column: 0 } })
  expect((await read({ lineRange: { startLine: 6, endLine: 6 } })).text).toBe('')
  expect((await read({ offsetRange: { startOffset: 1, endOffset: 3 } })).text).toBe('😀')
  expect((await read({ offsetRange: { startOffset: 1, endOffset: 3 }, paddingLines: 1 })).text).toBe('α😀\r\nB\r')
  expect((await read({ offsetRange: { startOffset: 5, endOffset: 5 }, paddingLines: 1 })).text).toBe('α😀\r\nB\rC\u2028')
  expect((await read({ offsetRange: { startOffset: 5, endOffset: 5 }, paddingLines: 0 })).text).toBe('')
  expect((await read({ offsetRange: { startOffset: 0, endOffset: 5 }, paddingLines: 1 })).text).toBe('α😀\r\nB\r')
  expect((await read({ lineRange: { startLine: 3, endLine: 3 }, paddingLines: 20 })).text).toBe(f.text)
  expect(await read({ wholeFile: true })).not.toHaveProperty('blockId')
})
it('matches an independent line/offset oracle at every valid endpoint, including CRLF interiors and empty EOF', async () => {
  const f = await fixture('\uFEFF😀\r\nα\rB\u2028C\u2029D\n')
  const starts = [0, ...Array.from(f.text.matchAll(/\r\n|[\n\r\u2028\u2029]/g), match => match.index + match[0].length)]
  const line = (offset: number) => starts.filter(start => start <= offset).length - 1
  const offsets = Array.from({ length: f.text.length + 1 }, (_, n) => n).filter(n => n !== 2)
  for (const startOffset of offsets) for (const endOffset of offsets.filter(n => n >= startOffset)) {
    for (const paddingLines of [0, 1, 20]) {
      const start = paddingLines ? starts[Math.max(0, line(startOffset) - paddingLines)] : startOffset
      const last = line(endOffset > startOffset ? endOffset - 1 : startOffset)
      const end = paddingLines ? starts[last + paddingLines + 1] ?? f.text.length : endOffset
      const result = await expandSourceP0(f.index, f.reader, { ...f.request, offsetRange: { startOffset, endOffset }, paddingLines })
      expect(result).toMatchObject({ startOffset: start, endOffset: end, text: f.text.slice(start, end),
        start: { line: line(start) + 1, column: start - starts[line(start)] }, end: { line: line(end) + 1, column: end - starts[line(end)] } })
    }
  }
})
it('rejects invalid modes/ranges/surrogate endpoints without rewriting the explicit request', async () => {
  const f = await fixture()
  for (const range of [{}, { wholeFile: true, paddingLines: 0 }, { wholeFile: false }, { wholeFile: true, lineRange: { startLine: 1, endLine: 1 } },
    { offsetRange: { startOffset: 2, endOffset: 3 } }, { offsetRange: { startOffset: 0, endOffset: 2 }, paddingLines: 1 },
    { offsetRange: { startOffset: 0, endOffset: 999 } }, { lineRange: { startLine: 0, endLine: 1 } }, { lineRange: { startLine: 1, endLine: 7 } },
    { lineRange: { startLine: 1, endLine: 1 }, paddingLines: 21 }]) {
    await expect(expandSourceP0(f.index, f.reader, { ...f.request, ...range })).rejects.toMatchObject({ code: 'invalid-query' })
  }
  const empty = await fixture('')
  expect(await expandSourceP0(empty.index, empty.reader, { ...empty.request, lineRange: { startLine: 1, endLine: 1 } })).toMatchObject({ text: '', startOffset: 0, endOffset: 0 })
})
it('distinguishes snapshot/membership/access/block/receipt hash/content change/deletion, never returns partial text', async () => {
  const f = await fixture()
  const raw = { ...f.request, wholeFile: true }
  await expect(expandSourceP0(f.index, f.reader, { ...raw, snapshotId: sha256Utf8('old') })).rejects.toMatchObject({ code: 'stale-snapshot' })
  await expect(expandSourceP0(f.index, f.reader, { ...raw, path: 'outside.json' })).rejects.toMatchObject({ code: 'not-found' })
  await expect(expandSourceP0(f.index, f.reader, { ...raw, path: '.env.private' })).rejects.toMatchObject({ code: 'access-denied' })
  await expect(expandSourceP0(f.index, f.reader, { ...raw, blockId: sha256Utf8('block') })).rejects.toMatchObject({ code: 'cache-unavailable' })
  await expect(expandSourceP0(f.index, f.reader, { ...raw, sourceHash: sha256Utf8('wrong') })).rejects.toMatchObject({ code: 'stale-source', failure: { details: { reason: 'receipt-hash-mismatch' } } })
  await writeFile(join(f.root, 'new.json'), 'new')
  await expect(expandSourceP0(f.index, f.reader, { ...raw, path: 'new.json', sourceHash: sha256Utf8('new') })).rejects.toMatchObject({ code: 'not-found' })
  await writeFile(join(f.root, 'data.json'), 'changed')
  await expect(expandSourceP0(f.index, f.reader, raw)).rejects.toMatchObject({ code: 'stale-source', reason: 'content-hash-mismatch' })
  await rm(join(f.root, 'data.json'))
  await expect(expandSourceP0(f.index, f.reader, raw)).rejects.toMatchObject({ code: 'stale-source', reason: 'current-file-missing' })
})
it('enforces final serialized bytes including escaping, allows overlapping retries, and charges atomically across agents', async () => {
  const f = await fixture('"\\\n'.repeat(30))
  const value = await expandSourceP0(f.index, f.reader, { ...f.request, wholeFile: true })
  const bytes = Buffer.byteLength(JSON.stringify(value))
  expect(bytes).toBeGreaterThan(Buffer.byteLength(value.text))
  const budget = new SourceBudgetP0(bytes)
  let entered = 0, release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const runtime = { index: f.index, config: f.config, reader: async (...args: Parameters<typeof f.reader>) => { const file = await f.reader(...args); if (++entered === 2) release(); await barrier; return file } }
  const resolver: ResolverP0 = { async resolve(_session, signal) { return { runtime, budget, signal, done() {} } }, async release() {}, async dispose() {} }
  const tool = createToolsP0(resolver).find(t => t.name === 'context_expand_source')!
  const exec = (agent: number) => ({ signal: new AbortController().signal, agent: { id: agent } }) as unknown as ToolRunContext
  const results = await Promise.allSettled([tool.execute({ ...f.request, wholeFile: true }, exec(1)), tool.execute({ ...f.request, wholeFile: true }, exec(2))])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'budget-exceeded', failure: { details: { remainingSessionBytes: 0, requestedOutputBytes: bytes } } } })
  expect(budget.spent).toBe(bytes)
  await expect(tool.execute({ ...f.request, offsetRange: { startOffset: 0, endOffset: 1 } }, exec(3))).rejects.toMatchObject({ code: 'budget-exceeded' })
  await expect(tool.execute({ ...f.request, offsetRange: { startOffset: 0, endOffset: 999 } }, exec(4))).rejects.toMatchObject({ code: 'invalid-query' })
  expect(budget.spent).toBe(bytes)
  const unlimited = new SourceBudgetP0(null)
  unlimited.debit(bytes); unlimited.debit(bytes); expect(unlimited.spent).toBe(2 * bytes); expect(unlimited.remaining).toBeNull()
})
it('preserves caller-owned cancellation reasons even when they resemble internal business errors', async () => {
  const f = await fixture()
  const controller = new AbortController(), reason = new P0ReadError('stale-source', 'changed-during-read')
  const budget = new SourceBudgetP0()
  let done = false
  const runtime = { ...f, reader: async (...args: Parameters<typeof f.reader>) => {
    const file = await f.reader(...args)
    controller.abort(reason)
    return file
  } }
  const resolver: ResolverP0 = { async resolve() { return { runtime, budget, signal: controller.signal, done() { done = true } } }, async release() {}, async dispose() {} }
  const tool = createToolsP0(resolver).find(t => t.name === 'context_expand_source')!
  await expect(tool.execute({ ...f.request, wholeFile: true }, { signal: controller.signal } as ToolRunContext)).rejects.toBe(reason)
  expect(done).toBe(true)
  expect(budget.spent).toBe(0)
})
it('fails oversized whole source before debit and preserves cancellation/unknown reader errors', async () => {
  const f = await fixture('"'.repeat(40000))
  await expect(expandSourceP0(f.index, f.reader, { ...f.request, wholeFile: true })).rejects.toMatchObject({ code: 'budget-exceeded', failure: { details: { limit: 'maxOutputBytes', maxOutputBytes: O.maxOutputBytes } } })
  const budget = new SourceBudgetP0()
  const resolver: ResolverP0 = { async resolve(_s, signal) { return { runtime: f, budget, signal, done() {} } }, async release() {}, async dispose() {} }
  const tool = createToolsP0(resolver).find(t => t.name === 'context_expand_source')!
  await expect(tool.execute({ ...f.request, wholeFile: true }, { signal: new AbortController().signal } as ToolRunContext)).rejects.toMatchObject({ code: 'budget-exceeded' })
  expect(budget.spent).toBe(0)
  const error = new Error('unexpected I/O')
  await expect(expandSourceP0(f.index, async () => { throw error }, { ...f.request, wholeFile: true })).rejects.toBe(error)
  const controller = new AbortController()
  const reader = async (...args: Parameters<typeof f.reader>) => { const file = await f.reader(...args); controller.abort(error); return file }
  await expect(expandSourceP0(f.index, reader, { ...f.request, offsetRange: { startOffset: 0, endOffset: 1 } }, { signal: controller.signal })).rejects.toBe(error)
})

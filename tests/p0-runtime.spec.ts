import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createResolverP0 } from '../src/p0-runtime.ts'
const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'm2-runtime-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'a.ts'), 'const a = 1')
  const ctx = new Context(), store = await ctx.plugin(SessionStore); cleanup.push(() => store.dispose())
  const session = ctx.sessions.prepare(SessionId('runtime'), { meta: { cwd: root } })
  return { root, session }
}
it('shares one initialization; canceling a waiter does not cancel another or start an extra build', async () => {
  const { root, session } = await fixture(), entered = gate(), release = gate()
  let lookups = 0
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'runtime' }, { async resolveByPath() { lookups++; entered.resolve(); await release.promise; return { path: root } } })
  cleanup.push(() => resolver.dispose())
  const first = new AbortController(), second = new AbortController()
  const pending = resolver.resolve(session, first.signal)
  await entered.promise
  const surviving = resolver.resolve(session, second.signal)
  first.abort(new Error('cancel waiter'))
  await expect(pending).rejects.toThrow('cancel waiter')
  release.resolve()
  const handle = await surviving
  expect(lookups).toBe(1)
  const again = await resolver.resolve(session, second.signal)
  expect(again.runtime).toBe(handle.runtime); expect(again.budget).toBe(handle.budget)
  handle.done(); again.done()
})
it('release prohibits initialization publication and does not recreate the same Session', async () => {
  const { root, session } = await fixture(), entered = gate(), release = gate()
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'runtime' }, { async resolveByPath() { entered.resolve(); await release.promise; return { path: root } } })
  const pending = resolver.resolve(session, new AbortController().signal)
  await entered.promise
  const closing = resolver.release(session)
  await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  release.resolve(); await closing
  await expect(resolver.resolve(session, new AbortController().signal)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  await resolver.dispose()
})
it('reports cooperative initialization deadline through the same host timeout channel as its timer', async () => {
  const { root, session } = await fixture()
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'deadline', initializationTimeoutMs: 1000 }, { async resolveByPath() { return { path: root } } })
  const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(2000)
  try {
    await expect(resolver.resolve(session, new AbortController().signal)).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' })
  } finally { clock.mockRestore(); await resolver.dispose() }
})
it('timer timeout rejects all waiters, waits for build cleanup, then allows a later initialization', async () => {
  const { root, session } = await fixture(), entered = gate(), release = gate()
  let lookups = 0
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'timer', initializationTimeoutMs: 1000 }, { async resolveByPath() {
    if (++lookups === 1) { entered.resolve(); await release.promise; return undefined }
    return { path: root }
  } })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const first = resolver.resolve(session, new AbortController().signal)
    const second = resolver.resolve(session, new AbortController().signal)
    const outcomes = Promise.allSettled([first, second])
    await entered.promise
    await vi.advanceTimersByTimeAsync(1000)
    for (const result of await outcomes) expect(result).toMatchObject({ status: 'rejected', reason: { code: 'TOOL_TIMEOUT' } })
    release.resolve()
    // Let the non-cancelable registry lookup settle and construction clean up.
    await new Promise<void>(resolve => setImmediate(resolve))
    const handle = await resolver.resolve(session, new AbortController().signal)
    expect(lookups).toBe(2)
    handle.done()
  } finally { release.resolve(); vi.useRealTimers(); await resolver.dispose() }
})
it('shares cleanup across release, dispose and synchronous abort-listener reentry', async () => {
  const { root, session } = await fixture()
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'reentrant-close' }, { async resolveByPath() { return { path: root } } })
  const handle = await resolver.resolve(session, new AbortController().signal)
  const finished: string[] = []
  let reentered!: Promise<void>
  handle.signal.addEventListener('abort', () => { reentered = resolver.release(session).then(() => { finished.push('reentered') }) }, { once: true })
  const first = resolver.release(session).then(() => { finished.push('release') })
  const disposed = resolver.dispose().then(() => { finished.push('dispose') })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(finished).toEqual([])
    await expect(resolver.resolve(session, new AbortController().signal)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  } finally { handle.done() }
  await Promise.all([first, disposed, reentered])
  expect(finished.sort()).toEqual(['dispose', 'reentered', 'release'])
})

it('release cancels a captured call and waits for caller cleanup before dropping the runtime', async () => {
  const { root, session } = await fixture()
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'runtime' }, { async resolveByPath() { return { path: root } } })
  const handle = await resolver.resolve(session, new AbortController().signal)
  let finished = false, secondFinished = false
  const closing = resolver.release(session).then(() => { finished = true })
  const secondClosing = resolver.release(session).then(() => { secondFinished = true })
  expect(handle.signal.aborted).toBe(true)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(finished).toBe(false)
  expect(secondFinished).toBe(false)
  handle.done(); handle.done(); await Promise.all([closing, secondClosing])
  expect(finished).toBe(true)
  await resolver.dispose()
})

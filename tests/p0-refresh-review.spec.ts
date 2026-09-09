import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createResolverP0 } from '../src/p0-runtime.ts'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const cleanup: Array<() => unknown> = []
let sequence = 0
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture(onLookup: (n: number) => Promise<void> = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'm3-review-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'main.ts'), 'export const before = 1\n')
  const ctx = new Context(), store = await ctx.plugin(SessionStore)
  cleanup.push(() => store.dispose())
  const session = ctx.sessions.prepare(SessionId(`m3-review-${++sequence}`), { meta: { cwd: root } })
  let lookups = 0
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'review' }, { async resolveByPath(path) {
    await onLookup(++lookups)
    return { path }
  } })
  cleanup.push(() => resolver.dispose())
  return { root, session, resolver, lookups: () => lookups }
}
const signal = () => new AbortController().signal

it('shares the queued first build after initialization failure instead of starting a competing query build', async () => {
  const first = barrier(), second = barrier(), entered = barrier()
  const f = await fixture(async n => {
    if (n === 1) { await first.promise; throw new Error('initial failure') }
    if (n === 2) { entered.release(); await second.promise }
  })
  const initial = f.resolver.resolve(f.session, signal()).catch(error => error)
  const refresh = f.resolver.refresh!(f.session, signal())
  first.release(); await initial; await entered.promise
  let queryFinished = false
  const query = f.resolver.resolve(f.session, signal()).then(handle => { queryFinished = true; return handle })
  const nextRefresh = f.resolver.refresh!(f.session, signal())
  await Promise.resolve(); await Promise.resolve()
  expect(f.lookups()).toBe(2)
  expect(queryFinished).toBe(false)
  second.release()
  const [result, handle] = await Promise.all([refresh, query])
  expect(handle.runtime.index.snapshot.snapshotId).toBe(result.snapshotId)
  handle.done()
  await nextRefresh
  expect(f.lookups()).toBe(3)
})

it('counts idle refresh in the queue bound and canceled queued calls never collect', async () => {
  const gate = barrier(), entered = barrier()
  const f = await fixture(async n => { if (n === 1) { entered.release(); await gate.promise } })
  const head = f.resolver.refresh!(f.session, signal())
  await entered.promise
  const controllers = Array.from({ length: 15 }, () => new AbortController())
  const queued = controllers.map(c => f.resolver.refresh!(f.session, c.signal).catch(error => error))
  await expect(f.resolver.refresh!(f.session, signal())).rejects.toMatchObject({ code: 'TOOL_OVERLOADED' })
  controllers.forEach(c => c.abort(new Error('queued cancel')))
  expect((await Promise.all(queued)).every(e => e.message === 'queued cancel')).toBe(true)
  expect(f.lookups()).toBe(1)
  gate.release(); await head
  // Drain canceled internal jobs before verifying capacity is reusable.
  await f.resolver.release(f.session)
  expect(f.lookups()).toBe(1)
})

it('a failed active refresh does not prevent an already queued refresh from collecting', async () => {
  const gate = barrier(), entered = barrier()
  const f = await fixture(async n => { if (n === 2) { entered.release(); await gate.promise; throw new Error('build failure') } })
  const initial = await f.resolver.resolve(f.session, signal()); initial.done()
  const failed = f.resolver.refresh!(f.session, signal()).catch(error => error)
  await entered.promise
  const next = f.resolver.refresh!(f.session, signal())
  gate.release()
  expect((await failed).message).toBe('build failure')
  expect((await next).changed).toBe(false)
  expect(f.lookups()).toBe(3)
})

it('close alone cancels an active candidate, rejects queued calls, and waits for old leases', async () => {
  const gate = barrier(), entered = barrier()
  const f = await fixture(async n => { if (n === 2) { entered.release(); await gate.promise } })
  const old = await f.resolver.resolve(f.session, signal())
  const active = f.resolver.refresh!(f.session, signal()).catch(error => error)
  await entered.promise
  const queued = f.resolver.refresh!(f.session, signal()).catch(error => error)
  let closed = false
  const closing = f.resolver.release(f.session).then(() => { closed = true })
  expect((await active).code).toBe('SESSION_CLOSED')
  expect((await queued).code).toBe('SESSION_CLOSED')
  gate.release()
  await Promise.resolve(); await Promise.resolve()
  expect(closed).toBe(false)
  old.done(); await closing
  expect(f.lookups()).toBe(2)
  await expect(f.resolver.resolve(f.session, signal())).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
})

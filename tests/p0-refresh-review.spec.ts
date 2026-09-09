import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { buildIndexP0, P0BuildError } from '../src/p0-build.ts'
import { createResolverP0, type RuntimeEventP0, type RuntimeP0 } from '../src/p0-runtime.ts'

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

it('retries one full build only for read races', async () => {
  const f = await fixture()
  let attempts = 0
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'review' }, { async resolveByPath(path) { return { path } } }, {
    async buildIndex(config, options) {
      attempts++
      if (attempts === 1) throw new P0BuildError('changed-during-read')
      return buildIndexP0(config, options)
    },
  })
  cleanup.push(() => resolver.dispose())
  const result = await resolver.refresh!(f.session, signal())
  expect(result.changed).toBe(true)
  expect(attempts).toBe(2)
})

it('does not retry a second read race or a non-read build failure', async () => {
  const f = await fixture()
  for (const reason of ['read-failed', 'contract-invalid'] as const) {
    let attempts = 0
    const resolver = createResolverP0({ deploymentRoot: '.', revision: reason }, { async resolveByPath(path) { return { path } } }, {
      async buildIndex() { attempts++; throw new P0BuildError(reason) },
    })
    await expect(resolver.refresh!(f.session, signal())).rejects.toMatchObject({ code: 'refresh-failed' })
    expect(attempts).toBe(reason === 'read-failed' ? 2 : 1)
    await resolver.dispose()
  }
})

it('caller cancellation at the pre-commit barrier preserves the old runtime without closing', async () => {
  const f = await fixture()
  const commit = barrier()
  let refreshBuild = false
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'review' }, { async resolveByPath(path) { return { path } } }, {
    async beforeCommit(phase) { if (phase === 'refresh' && refreshBuild) await commit.promise },
  })
  cleanup.push(() => resolver.dispose())
  const old = await resolver.resolve(f.session, signal())
  const oldRuntime = old.runtime; old.done()
  refreshBuild = true
  await writeFile(join(f.root, 'main.ts'), 'export const after = 2\n')
  const controller = new AbortController()
  const refreshing = resolver.refresh!(f.session, controller.signal)
  await Promise.resolve(); await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('pre-commit cancel')); commit.release()
  await expect(refreshing).rejects.toThrow('pre-commit cancel')
  const current = await resolver.resolve(f.session, signal())
  expect(current.runtime).toBe(oldRuntime)
  current.done()
})

it('releases a retired runtime only after its last lease and isolates observer failures', async () => {
  const f = await fixture()
  const retired: RuntimeP0[] = [], released: RuntimeP0[] = [], events: RuntimeEventP0[] = []
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'review' }, { async resolveByPath(path) { return { path } } }, {
    onRuntimeRetired(runtime) { retired.push(runtime); throw new Error('observer failure') },
    onRuntimeReleased(runtime) { released.push(runtime) },
    eventSink(event) { events.push(event); if (event.kind === 'runtime-retired') throw new Error('sink failure') },
  })
  cleanup.push(() => resolver.dispose())
  const old = await resolver.resolve(f.session, signal())
  await writeFile(join(f.root, 'main.ts'), 'export const after = 2\n')
  await resolver.refresh!(f.session, signal())
  expect(retired).toEqual([old.runtime])
  expect(released).toEqual([])
  old.done()
  expect(released).toEqual([old.runtime])
  expect(events.map(event => event.kind)).toEqual(expect.arrayContaining(['build-started', 'build-succeeded', 'runtime-committed', 'refresh-queued', 'runtime-retired', 'runtime-released']))
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

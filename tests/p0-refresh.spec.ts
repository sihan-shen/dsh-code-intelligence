import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { parseRefreshSnapshotResultP0 } from '@han_05/dsh-context'
import { createResolverP0 } from '../src/p0-runtime.ts'
import { repoMapP0, symbolQueryP0 } from '../src/p0-query.ts'

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'm3-refresh-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'main.ts'), 'export const before = 1\n')
  const ctx = new Context(), sessions = await ctx.plugin(SessionStore)
  cleanup.push(() => sessions.dispose())
  return { root, session: ctx.sessions.prepare(SessionId(`m3-${Math.random()}`), { meta: { cwd: root } }) }
}
function registry(root: string) { return { async resolveByPath(path: string) { return path === root ? { path } : undefined } } }

it('refreshes edited files atomically, returns changed, and retains the Session budget', async () => {
  const { root, session } = await fixture()
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'm3' }, registry(root))
  const first = await resolver.resolve(session, new AbortController().signal)
  const old = first.runtime
  const oldMap = repoMapP0(old.index, { path: 'main.ts' })
  first.done()
  await writeFile(join(root, 'main.ts'), 'export const after = 2\n')
  const refreshed = parseRefreshSnapshotResultP0(await resolver.refresh!(session, new AbortController().signal))
  expect(refreshed.changed).toBe(true)
  expect(refreshed.snapshotId).not.toBe(oldMap.snapshotId)
  const current = await resolver.resolve(session, new AbortController().signal)
  expect(symbolQueryP0(current.runtime.index, { snapshotId: refreshed.snapshotId, name: 'after' }).matches[0].name).toBe('after')
  expect(() => symbolQueryP0(current.runtime.index, { snapshotId: oldMap.snapshotId, name: 'before' })).toThrow()
  expect(current.budget).toBe(first.budget)
  current.done()
  await resolver.release(session)
})

it('keeps an old lease usable while a refresh commits and releases it only after done', async () => {
  const { root, session } = await fixture()
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'm3' }, registry(root))
  const old = await resolver.resolve(session, new AbortController().signal)
  const oldMap = repoMapP0(old.runtime.index, { path: 'main.ts' })
  await writeFile(join(root, 'main.ts'), 'export const newer = 3\n')
  const result = await resolver.refresh!(session, new AbortController().signal)
  expect(result.snapshotId).not.toBe(oldMap.snapshotId)
  expect(repoMapP0(old.runtime.index, { snapshotId: oldMap.snapshotId, path: 'main.ts' }).items[0].sourceHash).toBe(oldMap.items[0].sourceHash)
  const current = await resolver.resolve(session, new AbortController().signal)
  expect(current.runtime).not.toBe(old.runtime)
  current.done()
  old.done()
  await resolver.release(session)
})

it('refresh failure preserves the active runtime and a later queued refresh can succeed', async () => {
  const { root, session } = await fixture()
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'm3', maxFiles: 1 }, registry(root))
  const first = await resolver.resolve(session, new AbortController().signal)
  const snapshotId = first.runtime.index.snapshot.snapshotId
  first.done()
  await writeFile(join(root, 'extra.ts'), 'export const extra = true\n')
  await expect(resolver.refresh!(session, new AbortController().signal)).rejects.toMatchObject({ code: 'refresh-failed' })
  const retained = await resolver.resolve(session, new AbortController().signal)
  expect(retained.runtime.index.snapshot.snapshotId).toBe(snapshotId)
  retained.done()
  await rm(join(root, 'extra.ts'))
  const refreshed = await resolver.refresh!(session, new AbortController().signal)
  expect(refreshed.changed).toBe(false)
  await resolver.release(session)
})

it('cancels queued refresh before commit and closing prevents a late candidate from publishing', async () => {
  const { root, session } = await fixture()
  const entered = new Promise<void>(resolve => { (globalThis as { entered?: () => void }).entered = resolve })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let builds = 0
  const resolver = createResolverP0({ deploymentRoot: '.', revision: 'm3' }, { async resolveByPath(path: string) {
    if (path !== root) return undefined
    if (++builds === 2) { (globalThis as { entered?: () => void }).entered?.(); await gate }
    return { path }
  } })
  const first = await resolver.resolve(session, new AbortController().signal)
  first.done()
  await writeFile(join(root, 'main.ts'), 'export const queued = 4\n')
  const controller = new AbortController()
  const refresh = resolver.refresh!(session, controller.signal)
  await entered
  controller.abort(new Error('caller canceled'))
  await expect(refresh).rejects.toThrow('caller canceled')
  const closing = resolver.release(session)
  release()
  await closing
  await expect(resolver.resolve(session, new AbortController().signal)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
})

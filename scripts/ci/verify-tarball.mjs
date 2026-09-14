#!/usr/bin/env node
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const [, , archive] = process.argv
if (!archive) throw new Error('usage: verify-tarball.mjs <package.tgz>')
delete process.env.NODE_PATH
if (process.env.NODE_PATH !== undefined) throw new Error('NODE_PATH could not be cleared')
const hostVersions = JSON.parse(process.env.DSH_HOST_VERSIONS_JSON ?? JSON.stringify({
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/dsh-llm': '0.1.2-rc.1',
  '@deepseek-ai/dsh-session': '0.1.2-rc.1',
  '@deepseek-ai/dsh-tools': '0.1.2-rc.1',
  '@deepseek-ai/dsh-workspace': '0.1.2-rc.1',
  '@deepseek-ai/schemastery': '3.18.2',
  '@deepseek-ai/dsh-client-locale': '0.1.2-rc.1',
  '@deepseek-ai/dsh-client-ui-settings': '0.1.2-rc.1',
  '@deepseek-ai/dsh-client-ui-slots': '0.1.2-rc.1',
  '@deepseek-ai/dsh-settings': '0.1.2-rc.1',
  '@deepseek-ai/dsh-subprocess': '0.1.2-rc.1',
  react: '18.3.1',
}))
const root = await mkdtemp(join(tmpdir(), 'dsh-code-intelligence-consumer-'))
let primary
let fiber
let sessions
let tools
try {
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  await writeFile(join(root, 'fixture.ts'), 'export const verified = true\n')
  const hostArgs = Object.entries(hostVersions).map(([name, version]) => `${name}@${version}`)
  const packageManager = process.env.npm_config_user_agent?.startsWith('pnpm/') ? 'pnpm' : 'npm'
  if (packageManager === 'pnpm') await exec('pnpm', ['add', '--ignore-scripts', archive, ...hostArgs], { cwd: root })
  else await exec('npm', ['install', '--ignore-scripts', archive, ...hostArgs], { cwd: root })

  const pkg = JSON.parse(await readFile(join(root, 'node_modules/@han_05/dsh-code-intelligence/package.json'), 'utf8'))
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle patch metadata mismatch')
  for (const [name, expected] of Object.entries(hostVersions)) {
    const installed = JSON.parse(await readFile(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    if (installed.version !== expected) throw new Error(`${name} expected ${expected}, got ${installed.version}`)
  }
  const patch = await readFile(join(root, 'node_modules/@han_05/dsh-code-intelligence/cordis.patch.yml'), 'utf8')
  if (!patch.includes('dsh-code-intelligence')) throw new Error('bundle patch is not loadable')

  const consumerPackageRoot = await realpath(join(root, 'node_modules/@han_05/dsh-code-intelligence'))
  const workspaceRoot = await realpath(process.cwd())
  if (consumerPackageRoot === workspaceRoot || consumerPackageRoot.startsWith(`${workspaceRoot}/`)) throw new Error('consumer resolved back into workspace')
  const consumerRequire = createRequire(join(root, 'package.json'))
  const importConsumer = async (name) => import(pathToFileURL(consumerRequire.resolve(name)).href)
  const plugin = await importConsumer('@han_05/dsh-code-intelligence')
  const { Context } = await importConsumer('@deepseek-ai/cordis')
  const SessionStore = (await importConsumer('@deepseek-ai/dsh-session')).default
  const { SessionId } = await importConsumer('@deepseek-ai/dsh-session')
  const ToolRuntime = (await importConsumer('@deepseek-ai/dsh-tools')).default
  const { ToolCallId } = await importConsumer('@deepseek-ai/dsh-llm')
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() { return () => {} }, section() { return () => {} } })
  ctx.provide('workspaceRegistry', { async resolveByPath(path) { return { path } } })
  sessions = await ctx.plugin(SessionStore)
  tools = await ctx.plugin(ToolRuntime, { mode: 'native' })
  fiber = await ctx.plugin(plugin.apply, { deploymentRoot: '.', revision: 'tarball-consumer' })
  const names = ['context_repo_map', 'context_symbol_query', 'context_relation_query', 'context_expand_source', 'context_refresh_snapshot']
  for (const name of names) if (!ctx.tools.get(name)) throw new Error(`missing registered tool: ${name}`)
  const session = ctx.sessions.prepare(SessionId('tarball'), { meta: { cwd: root } })
  const signal = new AbortController().signal
  const call = (name, arguments_, id) => ctx.tools.execute({ callId: ToolCallId(id), name, arguments: arguments_, signal, agent: { session } })
  const map = await call('context_repo_map', { path: 'fixture.ts' }, 'tarball-map')
  if (map.isError) throw new Error(`context_repo_map failed: ${map.error.message}`)
  if (!JSON.stringify(map.value).includes('fixture.ts')) throw new Error('context_repo_map returned no fixture')
  const snapshot = map.value
  const receipt = snapshot.items?.find(item => item.path === 'fixture.ts')
  if (!receipt?.sourceHash || !snapshot.snapshotId) throw new Error('context_repo_map did not return fixture receipt')
  const checks = [
    ['context_symbol_query', { snapshotId: snapshot.snapshotId, name: 'verified' }, 'tarball-symbol'],
    ['context_relation_query', { snapshotId: snapshot.snapshotId, from: { path: 'fixture.ts' }, types: ['imports'] }, 'tarball-relation'],
    ['context_expand_source', { snapshotId: snapshot.snapshotId, path: 'fixture.ts', sourceHash: receipt.sourceHash, wholeFile: true }, 'tarball-source'],
    ['context_refresh_snapshot', {}, 'tarball-refresh'],
  ]
  for (const [name, arguments_, id] of checks) {
    const result = await call(name, arguments_, id)
    if (result.isError) throw new Error(`${name} failed: ${result.error.message}`)
  }
} catch (error) {
  primary = error
} finally {
  const cleanupErrors = []
  for (const cleanup of [
    () => fiber?.dispose(),
    () => tools?.dispose(),
    () => sessions?.dispose(),
    () => rm(root, { recursive: true, force: true }),
  ]) {
    try { await cleanup() } catch (error) { cleanupErrors.push(error) }
  }
  if (primary && cleanupErrors.length) primary = new AggregateError([primary, ...cleanupErrors], 'tarball verification and cleanup failed')
  else if (!primary && cleanupErrors.length) primary = new AggregateError(cleanupErrors, 'tarball cleanup failed')
}
if (primary) throw primary
console.log(`verified tarball consumer: ${pathToFileURL(root).href}`)

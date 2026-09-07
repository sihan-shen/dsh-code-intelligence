import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { parseLspDeploymentConfig } from '../src/config.ts'
import { encodeLspFrame, LspFrameDecoder } from '../src/lsp-framing.ts'
import { RepositorySnapshotStore } from '../src/snapshot.ts'
import { parseSnapshotConfig } from '../src/config.ts'
import { ReadonlyLspAdapter } from '../src/lsp-adapter.ts'
import type { HostNetworkIsolation, LspDeploymentConfigV1 } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

type Scenario = 'success' | 'protocol-invalid' | 'hang'

class FakeRuntime {
  constructor(readonly scenario: Scenario = 'success') {}
  readonly resolveExecutable = vi.fn(async (command: string) => command)
  readonly spawn = vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
    if (spec.argv[0] === '/spawn/fails') throw new Error('spawn failed')
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const decoder = new LspFrameDecoder(262_144)
    let resolveDone!: (outcome: SubprocessOutcome) => void
    const done = new Promise<SubprocessOutcome>(resolve => { resolveDone = resolve })
    const methods: string[] = []
    const scenario = this.scenario
    stdin.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        const method = typeof message.method === 'string' ? message.method : undefined
        if (method) methods.push(method)
        if (scenario === 'hang') continue
        if (scenario === 'protocol-invalid' && method === 'initialize') {
          stdout.write(encodeLspFrame({ jsonrpc: '2.0', id: 99, method: 'workspace/applyEdit', params: {} }, 262_144))
          continue
        }
        if (method === 'initialize') {
          stdout.write(encodeLspFrame({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }, 262_144))
        } else if (method === 'textDocument/documentSymbol') {
          stdout.write(encodeLspFrame({
            jsonrpc: '2.0',
            id: message.id,
            result: [{
              name: 'greet',
              kind: 12,
              range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
              selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
            }],
          }, 262_144))
        } else if (method === 'shutdown') {
          stdout.write(encodeLspFrame({ jsonrpc: '2.0', id: message.id, result: null }, 262_144))
        } else if (method === 'exit') {
          stdout.end()
          resolveDone({ exitCode: 0, signal: null })
        }
      }
    })
    let terminated = 0
    const handle: SubprocessHandle = {
      pid: 1,
      stdin,
      stdout,
      stderr: undefined,
      collected: {},
      done,
      terminate: () => { terminated += 1 },
      waitForExit: async () => true,
    }
    Object.defineProperties(handle, {
      __methods: { value: methods },
      __terminated: { get: () => terminated },
    })
    return handle
  })
}

async function fixture(overrides: { readonly scenario?: Scenario; readonly timeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-adapter-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'main.ts'), 'export function greet(name: string) {\n  return name\n}\n')
  const executable = join(root, 'server')
  await writeFile(executable, '#!/bin/sh\n')
  await chmod(executable, 0o755)
  const store = await RepositorySnapshotStore.create(parseSnapshotConfig({
    deploymentRoot: root,
    revision: 'lsp-adapter-fixture-1',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
  }))
  const config = parseLspDeploymentConfig({
    executable,
    fixedArgs: ['--stdio'],
    environment: { LANG: 'C', TMPDIR: root },
    timeoutMs: overrides.timeoutMs ?? 100,
    maxMessageBytes: 262_144,
    maxStderrBytes: 256,
    graceMs: 10,
  }, root)
  return { root, store, config, scenario: overrides.scenario ?? 'success' }
}

const capability: HostNetworkIsolation = Object.freeze({ networkIsolation: 'enforced', capabilityId: Symbol('test-host') })

function adapterFor(config: LspDeploymentConfigV1, store: RepositorySnapshotStore, scenario: Scenario, runtime?: FakeRuntime) {
  const effectiveRuntime = runtime ?? new FakeRuntime(scenario)
  const adapter = new ReadonlyLspAdapter(config, store, capability, effectiveRuntime)
  return { adapter, runtime: effectiveRuntime, restore: () => {
  } }
}

describe('ReadonlyLspAdapter', () => {
  it('rejects an unavailable or missing network isolation capability before spawn', async () => {
    const { store, config } = await fixture()
    const runtime = new FakeRuntime()
    expect(() => new ReadonlyLspAdapter(config, store, { networkIsolation: 'unavailable' }, runtime)).toThrow(/network|capability/i)
    expect(runtime.spawn).not.toHaveBeenCalled()
  })

  it('uses one exact fixed spawn spec and converts a complete DocumentSymbol result', async () => {
    const { store, config } = await fixture()
    const { adapter, runtime, restore } = adapterFor(config, store, 'success')
    try {
      process.env.OPENAI_API_KEY = 'ambient-secret'
      process.env.HTTP_PROXY = 'http://proxy.invalid'
      const result = await adapter.index(store)
      expect(result).toMatchObject({ adapterId: 'typescript-lsp', adapterVersion: expect.any(String) })
      if ('code' in result) throw new Error(`unexpected unavailable: ${result.code}`)
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0]).toMatchObject({ path: 'src/main.ts', name: 'greet', kind: 'function', score: 0 })
      expect(result.entries[0]?.sourceHash).toBe(store.snapshot.files.find(file => file.path === 'src/main.ts')?.contentHash)
      const spec = runtime.spawn.mock.calls[0]?.[0]
      expect(runtime.spawn).toHaveBeenCalledTimes(1)
      expect(runtime.resolveExecutable).toHaveBeenCalledTimes(1)
      expect(spec).toMatchObject({
        argv: [config.executable, '--stdio'],
        cwd: config.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: config.maxStderrBytes } },
        graceMs: config.graceMs,
      })
      expect(spec?.env?.OPENAI_API_KEY).toBeUndefined()
      expect(spec?.env?.HTTP_PROXY).toBeUndefined()
      expect(spec?.env?.PATH).toBeUndefined()
      expect(spec?.env?.HOME).toBeUndefined()
      expect(spec?.env?.LANG).toBe('C')
      expect(spec?.env?.TMPDIR).toBe(config.environment.TMPDIR)
    } finally {
      restore()
      delete process.env.OPENAI_API_KEY
      delete process.env.HTTP_PROXY
    }
  })

  it('returns only a bounded unavailable result for malformed protocol output', async () => {
    const { store, config } = await fixture({ scenario: 'protocol-invalid' })
    const { adapter, restore } = adapterFor(config, store, 'protocol-invalid')
    try {
      await expect(adapter.index(store)).resolves.toEqual({ adapterId: 'typescript-lsp', adapterVersion: expect.any(String), code: 'protocol-invalid' })
    } finally { restore() }
  })

  it('returns spawn-failed without exposing diagnostics or source', async () => {
    const { store, config } = await fixture()
    const failingConfig = { ...config, executable: '/spawn/fails' }
    const runtime = new FakeRuntime()
    const adapter = new ReadonlyLspAdapter(failingConfig, store, capability, runtime)
    await expect(adapter.index(store)).resolves.toEqual({ adapterId: 'typescript-lsp', adapterVersion: expect.any(String), code: 'spawn-failed' })
  })

  it('times out, terminates once, and bounds process-tree cleanup', async () => {
    const { store, config } = await fixture({ scenario: 'hang', timeoutMs: 10 })
    const { adapter, runtime, restore } = adapterFor(config, store, 'hang')
    try {
      await expect(adapter.index(store)).resolves.toMatchObject({ code: 'timed-out' })
      const handle = runtime.spawn.mock.results[0]?.value as SubprocessHandle & { __terminated: number }
      expect(handle.__terminated).toBe(1)
    } finally { restore() }
  })

  it('preserves the caller cancellation reason after cleanup', async () => {
    const { store, config } = await fixture({ scenario: 'hang', timeoutMs: 10_000 })
    const { adapter, restore } = adapterFor(config, store, 'hang')
    const reason = new Error('caller stopped')
    const controller = new AbortController()
    try {
      const pending = adapter.index(store, controller.signal)
      controller.abort(reason)
      await expect(pending).rejects.toBe(reason)
    } finally { restore() }
  })

  it('emits no write tools or commands and performs the fixed read-only lifecycle', async () => {
    const { store, config } = await fixture()
    const { adapter, runtime, restore } = adapterFor(config, store, 'success')
    try {
      await adapter.index(store)
      const handle = runtime.spawn.mock.results[0]?.value as SubprocessHandle & { __methods: string[] }
      expect(handle.__methods).toEqual([
        'initialize', 'initialized', 'textDocument/didOpen', 'textDocument/documentSymbol',
        'textDocument/didClose', 'shutdown', 'exit',
      ])
      expect(handle.__methods.some(method => method.includes('apply') || method.includes('codeAction') || method.includes('rename') || method.includes('execute'))).toBe(false)
    } finally { restore() }
  })
})

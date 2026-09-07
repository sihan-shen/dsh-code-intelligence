import { chmod, lstat, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseLspDeploymentConfig, parseSnapshotConfig } from '../src/config.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true }))
  }
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lsp-config-'))
  roots.push(root)
  return root
}

async function executable(root: string, name = 'server.mjs'): Promise<string> {
  const path = join(root, name)
  await writeFile(path, '#!/usr/bin/env node\n')
  await chmod(path, 0o755)
  return path
}

function input(path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executable: path,
    fixedArgs: ['--stdio'],
    environment: { LANG: 'C.UTF-8' },
    timeoutMs: 5_000,
    maxMessageBytes: 65_536,
    maxStderrBytes: 4_096,
    graceMs: 500,
    ...overrides,
  }
}

describe('LSP deployment configuration', () => {
  it('canonicalizes and binds the executable and cwd to the deployment root', async () => {
    const root = await temporaryRoot()
    const server = await executable(root)
    const parsed = parseLspDeploymentConfig(input(server), join(root, '.'))

    expect(parsed.executable).toBe(server)
    expect(parsed.cwd).toBe(root)
    expect(parsed.fixedArgs).toEqual(['--stdio'])
    expect(parsed.environment).toEqual({ LANG: 'C.UTF-8' })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.fixedArgs)).toBe(true)
    expect(Object.isFrozen(parsed.environment)).toBe(true)
    expect(() => (parsed.fixedArgs as string[]).push('--bad')).toThrow()
    expect(() => ((parsed.environment as Record<string, string>).LANG = 'bad')).toThrow()
  })

  it('rejects unknown or missing top-level fields and mutable/non-string arguments', async () => {
    const root = await temporaryRoot()
    const server = await executable(root)
    const valid = input(server)
    expect(() => parseLspDeploymentConfig({ ...valid, unknown: true }, root)).toThrow(/unknown/i)
    for (const key of Object.keys(valid)) {
      const copy = { ...valid }
      delete copy[key]
      expect(() => parseLspDeploymentConfig(copy, root), key).toThrow(/required|missing/i)
    }
    expect(() => parseLspDeploymentConfig(input(server, { fixedArgs: '--stdio' }), root)).toThrow(/fixedArgs/i)
    expect(() => parseLspDeploymentConfig(input(server, { fixedArgs: ['--ok', 'bad\0arg'] }), root)).toThrow(/NUL/i)
    expect(() => parseLspDeploymentConfig(input(server, { fixedArgs: ['--ok', 1] }), root)).toThrow(/string/i)
    expect(() => parseLspDeploymentConfig(input(server, { environment: [] }), root)).toThrow(/environment|object/i)
  })

  it('rejects shell, relative, non-canonical, symlink, outside-root, and unsafe executables', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    const server = await executable(root)
    const outsideServer = await executable(outside, 'outside.mjs')
    await symlink(server, join(root, 'link.mjs'))
    await mkdir(join(root, 'directory.mjs'))
    await writeFile(join(root, 'not-executable.mjs'), 'x')
    expect(() => parseLspDeploymentConfig(input('server.mjs'), root)).toThrow(/absolute|canonical|executable/i)
    expect(() => parseLspDeploymentConfig(input(`${root}/./server.mjs`), root)).toThrow(/canonical/i)
    expect(() => parseLspDeploymentConfig(input(join(root, 'link.mjs')), root)).toThrow(/symlink|canonical/i)
    expect(() => parseLspDeploymentConfig(input(outsideServer), root)).toThrow(/root|deployment/i)
    expect(() => parseLspDeploymentConfig(input(join(root, 'directory.mjs')), root)).toThrow(/regular|executable/i)
    expect(() => parseLspDeploymentConfig(input(join(root, 'not-executable.mjs')), root)).toThrow(/executable/i)
    for (const value of ['/bin/sh -c bad', `${root}/server.mjs\0`, `${root}/server.mjs\n--bad`, 'C:\\server.exe']) {
      expect(() => parseLspDeploymentConfig(input(value), root)).toThrow(/executable|NUL|shell|canonical/i)
    }
    expect(() => parseLspDeploymentConfig(input(server), join(root, 'missing'))).toThrow(/root|directory/i)
  })

  it('allows only safe locale/temp environment keys and rejects inherited-secret classes', async () => {
    const root = await temporaryRoot()
    const server = await executable(root)
    const valid = { LANG: 'C.UTF-8', LC_ALL: 'C', TMPDIR: root, TEMP: root, TMP: root }
    expect(parseLspDeploymentConfig(input(server, { environment: valid }), root).environment).toEqual(valid)
    for (const key of ['HOME', 'PATH', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'DSH_HOME', 'DSH_ROOT', 'NODE_OPTIONS']) {
      expect(() => parseLspDeploymentConfig(input(server, { environment: { [key]: 'bad' } }), root), key).toThrow(/environment|allowed|not allowed/i)
    }
    for (const value of [null, 1, '', 'bad\0value', 'bad\nvalue']) {
      expect(() => parseLspDeploymentConfig(input(server, { environment: { LANG: value } }), root)).toThrow(/environment|LANG|string|NUL/i)
    }
  })

  it('enforces exact resource limits', async () => {
    const root = await temporaryRoot()
    const server = await executable(root)
    const limits: Array<[string, number, number, number]> = [
      ['timeoutMs', 1, 60_000, 60_001],
      ['maxMessageBytes', 1, 262_144, 262_145],
      ['maxStderrBytes', 1, 65_536, 65_537],
      ['graceMs', 1, 5_000, 5_001],
    ]
    for (const [name, minimum, maximum, above] of limits) {
      expect(() => parseLspDeploymentConfig(input(server, { [name]: minimum }), root)).not.toThrow()
      expect(() => parseLspDeploymentConfig(input(server, { [name]: maximum }), root)).not.toThrow()
      for (const value of [0, above, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => parseLspDeploymentConfig(input(server, { [name]: value }), root), `${name}=${value}`).toThrow(/integer|between|limit/i)
      }
    }
  })

  it('does not change snapshot parsing', async () => {
    const root = await temporaryRoot()
    const parsed = parseSnapshotConfig({
      deploymentRoot: join(root, '.'),
      revision: 'revision',
      maxFileBytes: 1_048_576,
      maxFiles: 10_000,
      maxTotalBytes: 67_108_864,
      maxDirectories: 20_000,
      maxIgnoreBytes: 262_144,
      nestedCheckoutRoots: [],
    })
    expect(parsed.deploymentRoot).toBe(resolve(root))
    expect((await lstat(root)).isDirectory()).toBe(true)
  })

  it('resolves a relative deployment root from the explicit workspace root', async () => {
    const workspaceRoot = await temporaryRoot()
    const launcherRoot = await temporaryRoot()
    const previousCwd = process.cwd()
    process.chdir(launcherRoot)
    try {
      const parsed = parseSnapshotConfig({
        workspaceRoot,
        deploymentRoot: '.',
        revision: 'revision',
        maxFileBytes: 1_048_576,
        maxFiles: 10_000,
        maxTotalBytes: 67_108_864,
        maxDirectories: 20_000,
        maxIgnoreBytes: 262_144,
        nestedCheckoutRoots: [],
      })
      expect(parsed.workspaceRoot).toBe(workspaceRoot)
      expect(parsed.deploymentRoot).toBe(workspaceRoot)
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('rejects a relative deployment root without an explicit workspace root', async () => {
    await expect(() => parseSnapshotConfig({
      deploymentRoot: '.',
      revision: 'revision',
      maxFileBytes: 1_048_576,
      maxFiles: 10_000,
      maxTotalBytes: 67_108_864,
      maxDirectories: 20_000,
      maxIgnoreBytes: 262_144,
      nestedCheckoutRoots: [],
    })).toThrow(/relative deploymentRoot.*workspaceRoot/i)
  })

  it('rejects a deployment root outside the explicit workspace root', async () => {
    const workspaceRoot = await temporaryRoot()
    const deploymentRoot = await temporaryRoot()
    expect(() => parseSnapshotConfig({
      workspaceRoot,
      deploymentRoot,
      revision: 'revision',
      maxFileBytes: 1_048_576,
      maxFiles: 10_000,
      maxTotalBytes: 67_108_864,
      maxDirectories: 20_000,
      maxIgnoreBytes: 262_144,
      nestedCheckoutRoots: [],
    })).toThrow(/inside workspaceRoot/i)
  })
})

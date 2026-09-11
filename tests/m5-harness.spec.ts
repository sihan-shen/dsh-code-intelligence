import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_RUN_SEED,
  DSH_PROFILE_MODULES,
  EVALUATION_CODE_INTELLIGENCE_CONFIG,
  assertEvaluationHostConsistency,
  createAgentRunSchedule,
  expectedTargetTokens,
  jsonRepairRequest,
  relationTargetTokens,
  requestCarriesToolSchemas,
  resolveEvaluationHost,
  summarizeCompletedRuns,
  summarizeTaskMajority,
  textSurfacesToken,
  tokensSurfaced,
  verifyCorpusTree,
} from '../eval/m5/harness.mjs'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'm5-harness-test-'))
  temporaryRoots.push(root)
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, 'a.ts'), 'export const a = 1\n')
  await writeFile(join(root, 'nested/b.ts'), 'export const b = 2\n')
  return root
}

const manifest = {
  fileCount: 2,
  totalBytes: 38,
  files: [
    { path: 'a.ts', bytes: 19, sha256: 'a3b135bcfeaabda5d6780642cf256059889ad4649c9ba4f7a4d5d6e83a68b402' },
    { path: 'nested/b.ts', bytes: 19, sha256: '70e328b58e3b0eb4a9d1ba67a5b22a0ada841e8797eb22732e10b5b10878f38b' },
  ],
}

describe('M5 comparison harness invariants', () => {
  it('resolves one peer-identical DSH evaluation host and records every core module', async () => {
    const host = await resolveEvaluationHost()
    expect(host.generation).toBe('0.1.3-alpha.2')
    expect(Object.keys(host.provenance.modules).sort()).toEqual([
      'cordis',
      'dsh-fs-observation-policy',
      'dsh-fs-sandbox',
      'dsh-llm',
      'dsh-sandbox-local',
      'dsh-sandbox-policy',
      'dsh-session',
      'dsh-storage',
      'dsh-storage-domain',
      'dsh-tool-fs',
      'dsh-tool-fs-search',
      'dsh-tools',
      'dsh-workspace',
    ])
    expect(host.provenance.modules['dsh-tool-fs'].version).toBe(host.generation)
    expect(host.provenance.modules['dsh-tool-fs-search'].version).toBe(host.generation)
    expect(host.provenance.codeIntelligence.loadingPolicy).toBe('in-memory-external-remap-to-profile-v2')
    expect(host.provenance.codeIntelligence.externalMappings['@deepseek-ai/dsh-tools'])
      .toBe(new URL(`file://${host.provenance.modules['dsh-tools'].entry}`).href)
    // A shared library reachable from both trees must be taken from the host
    // graph, or the process instantiates it twice.
    expect(host.provenance.codeIntelligence.externalResolution['@deepseek-ai/schemastery']).toBe('host-graph')
    const hostRequire = createRequire(join(DSH_PROFILE_MODULES, 'dsh-tools', 'package.json'))
    const hostSchemastery = await realpath(hostRequire.resolve('@deepseek-ai/schemastery/package.json'))
    expect(host.provenance.codeIntelligence.externalMappings['@deepseek-ai/schemastery'])
      .toBe(new URL(`file://${await realpath(join(dirname(hostSchemastery), 'lib/index.mjs'))}`).href)
  })

  it('exposes a usable call-id constructor on the 0.1.3 host (ToolCallId was renamed to CallId)', async () => {
    const host = await resolveEvaluationHost()
    expect(typeof host.apis.ToolCallId).toBe('function')
    expect(host.apis.ToolCallId('abc')).toBe('abc')
  })

  it('fails closed on a DSH generation or peer-identity mismatch', () => {
    const names = [
      'cordis', 'dsh-tools', 'dsh-session', 'dsh-llm', 'dsh-storage', 'dsh-storage-domain',
      'dsh-workspace', 'dsh-sandbox-local', 'dsh-sandbox-policy', 'dsh-fs-sandbox',
      'dsh-fs-observation-policy', 'dsh-tool-fs', 'dsh-tool-fs-search',
    ]
    const records = names.map(name => ({
      name: `@deepseek-ai/${name}`,
      version: name === 'cordis' ? '4.0.2' : '0.1.3-alpha.2',
      packageJson: `/host/${name}/package.json`,
      peerIdentities: {},
    }))
    expect(() => assertEvaluationHostConsistency(records.map(record =>
      record.name.endsWith('/dsh-tool-fs') ? { ...record, version: '0.1.2-rc.1' } : record,
    ))).toThrow('evaluation host version mismatch')
    expect(() => assertEvaluationHostConsistency(records.map(record =>
      record.name.endsWith('/dsh-tool-fs')
        ? { ...record, peerIdentities: { 'dsh-tools': '/other/dsh-tools/package.json' } }
        : record,
    ))).toThrow('evaluation host peer identity mismatch')
  })

  it('builds a deterministic counterbalanced schedule with varying repeat task order', () => {
    const input = {
      armNames: ['default', 'additive', 'replacement'],
      taskIds: ['one', 'two', 'three', 'four', 'five', 'six'],
      repeats: 4,
      seed: DEFAULT_AGENT_RUN_SEED,
    }
    const first = createAgentRunSchedule(input)
    const second = createAgentRunSchedule(input)

    expect(second).toEqual(first)
    expect(first.map(item => item.armOrder)).toEqual([
      ['default', 'additive', 'replacement'],
      ['additive', 'replacement', 'default'],
      ['replacement', 'default', 'additive'],
      ['default', 'additive', 'replacement'],
    ])
    expect(new Set(first.map(item => item.taskOrder.join(','))).size).toBe(first.length)
    for (const item of first) expect([...item.taskOrder].sort()).toEqual([...input.taskIds].sort())
  })

  it('keeps single-arm and single-task schedules valid', () => {
    expect(createAgentRunSchedule({ armNames: ['default'], taskIds: ['only'], repeats: 2, seed: 'fixed' })).toEqual([
      { repeat: 1, armOrder: ['default'], taskOrder: ['only'] },
      { repeat: 2, armOrder: ['default'], taskOrder: ['only'] },
    ])
  })

  it('disables cumulative Session source budget while retaining one arm runtime', () => {
    expect(EVALUATION_CODE_INTELLIGENCE_CONFIG).toMatchObject({ sessionSourceBytes: null })
    expect(Object.isFrozen(EVALUATION_CODE_INTELLIGENCE_CONFIG)).toBe(true)
  })

  it('excludes harness failures from the accuracy denominator', () => {
    expect(summarizeCompletedRuns([
      { taskId: 'one', ok: true, stopReason: 'answered' },
      { taskId: 'two', ok: false, stopReason: 'answered' },
      { taskId: 'three', ok: false, stopReason: 'harness-error' },
    ])).toEqual({ attempts: 3, completed: 2, failed: 1, correct: 1, correctRate: 0.5 })
  })

  it('preserves schemas but disables tool use in JSON repair calls', () => {
    const wireTools = [{ type: 'function', function: { name: 'read' } }]
    const body = jsonRepairRequest({ model: 'model', messages: [], wireTools, maxOutputTokens: 1200 })
    expect(body).toMatchObject({ tools: wireTools, tool_choice: 'none', max_tokens: 1200 })
    expect(requestCarriesToolSchemas(body)).toBe(true)
    expect(requestCarriesToolSchemas({ tools: [] })).toBe(false)
    expect(requestCarriesToolSchemas({})).toBe(false)
  })

  it('keeps harness.mjs the only DSH host loader for its consumers', async () => {
    const packageRoot = fileURLToPath(new URL('..', import.meta.url))
    for (const name of ['agent-baseline.mjs', 'audit-tool-surface.mjs', 'build-agent-tasks.mjs', 'grep-baseline.mjs', 'semantic-probe.mjs']) {
      const source = await readFile(join(packageRoot, 'eval/m5', name), 'utf8')
      // A package-local DSH import or a direct built-bundle import reintroduces
      // the mixed 0.1.2-rc.1 / 0.1.3-alpha.2 host that fix #3 removed.
      expect(source, name).not.toMatch(/from\s+['"]@deepseek-ai\//)
      expect(source, name).not.toMatch(/from\s+['"][^'"]*\.\.\/\.\.\/lib\/index\.js['"]/)
      expect(source, name).not.toMatch(/from\s+['"]\.\/lib\/harness\.mjs['"]/)
      // Host selection is owned by the shared loader; no script may pin a
      // bundle path of its own.
      expect(source, name).not.toMatch(/DSH_FS_SEARCH_ENTRY/)
      // The corpus copy must go through the shared, manifest-verified mount, and
      // a registry must be torn down through the cordis fiber (`ctx.dispose` is
      // not a real method, so a bare call silently leaks the host).
      expect(source, name).not.toMatch(/\bcp\s*\(\s*CORPUS_ROOT/)
      expect(source, name).not.toMatch(/workspaceRegistry['"]\)\.create\(/)
      expect(source, name).not.toMatch(/\bctx\.dispose\s*\(/)
    }
    const harness = await readFile(join(packageRoot, 'eval/m5/harness.mjs'), 'utf8')
    expect(harness).not.toMatch(/^import[^\n]*from\s+['"]@deepseek-ai\//m)
  })

  it('scores Phase 1 relation identity instead of asserting it', async () => {
    const packageRoot = fileURLToPath(new URL('..', import.meta.url))
    const grep = await readFile(join(packageRoot, 'eval/m5/grep-baseline.mjs'), 'utf8')
    // `contains` edges carry only symbolIds, so the harness must resolve them
    // through the product lookup and score member names, not edge count.
    expect(grep).toMatch(/context_symbol_query/)
    expect(grep).toMatch(/deferredSymbolResolveBytes/)
    expect(grep).toMatch(/symmetric-target-coverage-v4/)
    expect(grep).not.toMatch(/Math\.min\(relationships\.length, want\.length\)/)

    const probe = await readFile(join(packageRoot, 'eval/m5/semantic-probe.mjs'), 'utf8')
    // Diagnostic verdicts must be computed from the data, never hardcoded.
    expect(probe).toMatch(/heuristicOnly\.length === 0 && semanticOnly\.length === 0/)
    expect(probe).toMatch(/nameMatches: semanticName !== null/)
    expect(probe).toMatch(/joinableCallEdges: callEdgesJoinable/)
    expect(probe).not.toMatch(/joinableCallEdges: 0/)

    const audit = await readFile(join(packageRoot, 'eval/m5/audit-tool-surface.mjs'), 'utf8')
    // `pluginInjectsOwnPrompt` must mean a forwarded prompt section, not merely
    // "context tools are exposed".
    expect(audit).toMatch(/structuredPromptSections\.length > 0/)
    expect(audit).toMatch(/structuredToolsExposed/)
  })

  it('derives the same target-token requirement for both Phase 1 arms', () => {
    expect(expectedTargetTokens({
      category: 'declaration',
      expectedTargets: [{ name: 'a' }, { name: 'b' }],
    })).toEqual(['a', 'b'])
    expect(expectedTargetTokens({
      category: 'relation', relationKind: 'symbol', expected: { targets: [{ name: 'Red' }] },
    })).toEqual(['Red'])
    expect(expectedTargetTokens({
      category: 'relation',
      expected: [
        { target: { specifier: 'vitest' } },
        { target: { name: 'z' } },
        { target: { path: 'v4/x.ts' } },
        { target: { kind: 'symbol', symbolId: 'ignored' } },
      ],
    })).toEqual(['vitest', 'z', 'v4/x.ts'])
    expect(expectedTargetTokens({ category: 'source', expected: { text: 'x' } })).toEqual([])
  })

  it('extracts only comparable target tokens from structured relations', () => {
    expect(relationTargetTokens([
      { target: { kind: 'unresolved', specifier: 'zod/v4' } },
      { target: { kind: 'unresolved', name: 'config' } },
      { target: { kind: 'symbol', symbolId: 'sha256:abc' } },
      { target: { kind: 'file', path: 'v4/y.ts' } },
    ])).toEqual(['zod/v4', 'config', 'v4/y.ts'])
    expect(relationTargetTokens(undefined)).toEqual([])
  })

  it('requires identifier boundaries for name tokens but literal specifiers', () => {
    // Same predicate for both arms: `en` must not score inside `then`, and
    // `Red` must not score inside `Redux`...
    expect(textSurfacesToken('if (then) config(en())', 'en')).toBe(true)
    expect(textSurfacesToken('if (then) other()', 'en')).toBe(false)
    expect(textSurfacesToken('const Redux = 1', 'Red')).toBe(false)
    expect(textSurfacesToken('enum X { Red = 1 }', 'Red')).toBe(true)
    // ...while punctuation-bearing specifiers/paths are matched literally.
    expect(textSurfacesToken('from "zod/v4"', 'zod/v4')).toBe(true)
    expect(textSurfacesToken('from "./config.js"', './config.js')).toBe(true)
    expect(textSurfacesToken('from "./other.js"', './config.js')).toBe(false)
    expect(textSurfacesToken('anything', '')).toBe(false)
    expect(tokensSurfaced('config(en())', ['config', 'en', 'missing'])).toEqual(['config', 'en'])
  })

  it('aggregates the preregistered endpoint by per-task majority, not run pooling', () => {
    const runs = [
      { taskId: 'a', ok: true }, { taskId: 'a', ok: true }, { taskId: 'a', ok: false },
      { taskId: 'b', ok: true }, { taskId: 'b', ok: false }, { taskId: 'b', ok: false },
      { taskId: 'c', ok: false, stopReason: 'harness-error' },
    ]
    const neutral = summarizeTaskMajority(runs)
    expect(neutral.evaluated).toBe(2)
    expect(neutral.excluded).toBe(1)
    expect(neutral.correct).toBe(1)
    expect(neutral.correctRate).toBe(0.5)
    expect(neutral.perTask.find(task => task.taskId === 'a').majority).toBe(true)
    expect(neutral.perTask.find(task => task.taskId === 'b').majority).toBe(false)
  })

  it('does not award a task on an even split and filters by task id set', () => {
    const runs = [
      { taskId: 'x', ok: true }, { taskId: 'x', ok: false },
      { taskId: 'y', ok: true }, { taskId: 'y', ok: true },
    ]
    const onlyX = summarizeTaskMajority(runs, new Set(['x']))
    expect(onlyX.correct).toBe(0)
    expect(onlyX.correctRate).toBe(0)
    expect(summarizeTaskMajority(runs).correct).toBe(1)
  })

  it('verifies exact corpus bytes and rejects changed or added files', async () => {
    const root = await fixture()
    await expect(verifyCorpusTree(root, manifest)).resolves.toMatchObject({ fileCount: 2, totalBytes: 38 })
    // The check compares by path, not by the manifest's traversal order.
    const reversed = { ...manifest, files: [...manifest.files].reverse() }
    await expect(verifyCorpusTree(root, reversed)).resolves.toMatchObject({ fileCount: 2, totalBytes: 38 })

    await writeFile(join(root, 'a.ts'), 'changed\n')
    await expect(verifyCorpusTree(root, manifest)).rejects.toThrow('corpus manifest mismatch')

    await writeFile(join(root, 'a.ts'), 'export const a = 1\n')
    await writeFile(join(root, 'extra.ts'), '')
    await expect(verifyCorpusTree(root, manifest)).rejects.toThrow('added=1')
  })
})

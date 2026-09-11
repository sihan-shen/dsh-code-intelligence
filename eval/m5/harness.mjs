// Shared M5 baseline-harness plumbing.
//
// Both Phase 1 (`grep-baseline.mjs`) and the Phase 2 agent comparison
// (`agent-baseline.mjs`) mount the REAL product tools into one real
// ToolRuntime over a temp copy of the frozen corpus. Everything in this module
// is harness scaffolding, not product code:
//
//   * the subprocess seam shim (real `node:child_process` behind the
//     documented `ctx.subprocess.spawn` contract),
//   * an in-memory storage backend + session/workspace wiring,
//   * the frozen corpus/gold paths and small byte-level helpers.
//
// The one deliberate seam is the subprocess process boundary; ripgrep argv
// construction, execution, parsing, caps, retention and rendering remain the
// real `@deepseek-ai/dsh-tool-fs-search` code, and the `context_*` tools remain
// the real built `lib/index.js` of this package.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, readdir, readFile, realpath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, join, relative, sep, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Package root of `dsh-code-intelligence` (this file lives in `eval/m5/`). */
export const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url))
/** Monorepo root (`DS-Plugins/`). */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
export const COMMIT = '1fb56a5c18c27102dbc92260a4007c7732a0ccca'
export const CORPUS_ROOT = join(PKG_ROOT, `node_modules/.cache/m5-eval/corpus/zod-${COMMIT}/packages/zod/src`)
export const REPORT_DIR = join(PKG_ROOT, 'node_modules/.cache/m5-eval/reports')
export const GOLD_PATH = fileURLToPath(new URL('./gold.json', import.meta.url))
export const CORPUS_LOCK_PATH = fileURLToPath(new URL('./corpus.lock.json', import.meta.url))
export const DSH_PROFILE_MODULES = join(REPO_ROOT, '.dsh/profiles/node_modules/@deepseek-ai')
const HOST_REQUIRE = createRequire(import.meta.url)
const HOST_ANCHORS = ['cordis', 'dsh-tools', 'dsh-session', 'dsh-llm']
const HOST_PACKAGES = [
  ...HOST_ANCHORS,
  'dsh-storage',
  'dsh-storage-domain',
  'dsh-workspace',
  'dsh-sandbox-local',
  'dsh-sandbox-policy',
  'dsh-fs-sandbox',
  'dsh-fs-observation-policy',
  'dsh-tool-fs',
  'dsh-tool-fs-search',
]
let evaluationHostPromise

/**
 * The comparison deliberately shares one structured index within an arm, but
 * retrieval tasks are independent observations rather than one conversational
 * Session. Disable the product's cumulative Session source-output allowance so
 * an earlier task cannot consume capacity needed by a later task.
 */
export const EVALUATION_CODE_INTELLIGENCE_CONFIG = Object.freeze({
  deploymentRoot: '.',
  revision: COMMIT,
  sessionSourceBytes: null,
})

export const GREP_TOOL_NAMES = ['grep', 'glob']
export const STRUCTURED_TOOL_NAMES = [
  'context_repo_map',
  'context_symbol_query',
  'context_relation_query',
  'context_expand_source',
  'context_refresh_snapshot',
]

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
/** Frozen default for reproducible Phase 2 arm/task scheduling. */
export const DEFAULT_AGENT_RUN_SEED = 'm5-phase2-counterbalance-v1'

function seededRandom(seed) {
  const bytes = createHash('sha256').update(seed).digest()
  let state = bytes.readUInt32LE(0)
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

/** Deterministic Fisher-Yates shuffle; the input is never mutated. */
export function deterministicShuffle(values, seed) {
  const shuffled = [...values]
  const random = seededRandom(seed)
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1))
    ;[shuffled[index], shuffled[selected]] = [shuffled[selected], shuffled[index]]
  }
  return shuffled
}

/**
 * Build the provider-call schedule. Full comparisons rotate arms once per
 * repeat (a Latin square over each three-repeat cycle); every arm receives the
 * same seeded task permutation within a repeat.
 */
export function createAgentRunSchedule({ armNames, taskIds, repeats, seed = DEFAULT_AGENT_RUN_SEED }) {
  if (!Array.isArray(armNames) || armNames.length === 0) throw new TypeError('armNames must not be empty')
  if (!Array.isArray(taskIds) || taskIds.length === 0) throw new TypeError('taskIds must not be empty')
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new TypeError('repeats must be a positive safe integer')
  if (typeof seed !== 'string' || seed.length === 0) throw new TypeError('run seed must not be empty')
  return Object.freeze(Array.from({ length: repeats }, (_, zeroBasedRepeat) => {
    const offset = zeroBasedRepeat % armNames.length
    const armOrder = [...armNames.slice(offset), ...armNames.slice(0, offset)]
    const repeat = zeroBasedRepeat + 1
    const taskOrder = deterministicShuffle(taskIds, `${seed}:repeat:${repeat}:tasks`)
    return Object.freeze({ repeat, armOrder: Object.freeze(armOrder), taskOrder: Object.freeze(taskOrder) })
  }))
}

/** Rough model-facing token estimate; NOT a provider tokenizer. */
export const tokensEst = (bytes) => Math.ceil(bytes / 4)
export const exists = (path) => readFile(path).then(() => true, () => false)

/** Failure classes are intentionally stable report vocabulary, not Error names. */
export const FAILURE_CLASSES = Object.freeze(['provider', 'timeout', 'budget', 'tool', 'format', 'harness'])

/**
 * Verify that evaluation inputs cannot be mounted as provider-visible files.
 * Gold is grading-only: it must not be the corpus, a child of the corpus, or a
 * path mentioned in a provider request. This is a fail-closed guard rather
 * than a claim that an external provider cannot already know a public answer.
 */
export function assertGoldIsolation({ corpusRoot, goldPath, providerMessages = [], goldBytes = null, goldHash = null }) {
  const corpus = resolve(String(corpusRoot ?? ''))
  const gold = resolve(String(goldPath ?? ''))
  if (!corpus || !gold) throw new TypeError('corpusRoot and goldPath are required')
  const corpusPrefix = corpus.endsWith(sep) ? corpus : `${corpus}${sep}`
  if (gold === corpus || gold.startsWith(corpusPrefix)) throw new Error('gold path must not be inside the provider-visible corpus')
  const aliases = new Set([gold, GOLD_PATH, gold.replaceAll(sep, '/'), GOLD_PATH.replaceAll(sep, '/')])
  for (const candidate of [gold, GOLD_PATH]) {
    try { aliases.add(realpathSync.native(candidate)) } catch { /* path may be synthetic in unit tests */ }
  }
  const serialized = JSON.stringify(providerMessages)
  const canonicalSerialized = serialized.replaceAll('\\\\', '/').replaceAll('%2F', '/').replaceAll('%2f', '/')
  if ([...aliases].some(alias => canonicalSerialized.includes(alias))) throw new Error('provider request contains the grading-only gold path')
  const digest = goldHash ?? (goldBytes === null ? null : sha256(goldBytes))
  if (digest && canonicalSerialized.includes(digest)) throw new Error('provider request contains the grading-only gold fingerprint')
  if (goldBytes !== null && canonicalSerialized.includes(Buffer.from(goldBytes).toString('utf8'))) throw new Error('provider request contains grading-only gold content')
  return true
}

/** A formal cross-corpus claim requires independent corpus identities. */
export function assertGeneralizationEligible(corpora) {
  if (!Array.isArray(corpora) || corpora.length < 2) {
    throw new Error('formal generalization requires at least two independent corpora')
  }
  const identities = new Set()
  const families = new Set()
  for (const corpus of corpora) {
    if (!corpus || typeof corpus.id !== 'string' || typeof corpus.commit !== 'string' || typeof corpus.language !== 'string' || typeof corpus.framework !== 'string') {
      throw new Error('each corpus requires id, commit, language, and framework')
    }
    const identity = `${corpus.id}:${corpus.commit}`
    if (identities.has(identity)) throw new Error(`duplicate corpus identity: ${identity}`)
    identities.add(identity)
    families.add(`${corpus.language}:${corpus.framework}`)
    if (corpus.deduplicated !== true || corpus.independenceVerified !== true) {
      throw new Error(`corpus ${corpus.id} lacks deduplication/independence verification`)
    }
  }
  if (families.size < 2) throw new Error('formal generalization requires multiple language/framework families')
  return Object.freeze({ corpusCount: corpora.length, families: [...families].sort(), eligible: true })
}

export function isProtocolCompleted(run) {
  // Reports produced before schemaVersion 2 have no explicit status. Preserve
  // their historical denominator while making all new records fail closed.
  if (run?.completionStatus === undefined && run?.protocolEligible === undefined) {
    return !['harness-error', 'provider-error', 'provider-timeout', 'timeout'].includes(run?.stopReason)
  }
  return run?.completionStatus === 'completed' && run?.protocolEligible === true
}

/** Protocol-aware summary; explicit completion/protocol eligibility is required. */
export function summarizeRunOutcomes(runs, taskIds) {
  const selected = taskIds === undefined ? runs : runs.filter(run => taskIds.has(run.taskId))
  const completed = selected.filter(isProtocolCompleted)
  const byFailure = Object.fromEntries(FAILURE_CLASSES.map(kind => [kind, selected.filter(run => run.failureClass === kind).length]))
  const correct = selected.filter(run => run.ok).length
  const protocolCorrect = completed.filter(run => run.ok).length
  return {
    intentionToTreat: { attempts: selected.length, correct, correctRate: selected.length ? Number((correct / selected.length).toFixed(4)) : null },
    completed: { attempts: completed.length, correct: protocolCorrect, correctRate: completed.length ? Number((protocolCorrect / completed.length).toFixed(4)) : null },
    perProtocol: { attempts: completed.length, correct: protocolCorrect, correctRate: completed.length ? Number((protocolCorrect / completed.length).toFixed(4)) : null },
    failures: byFailure,
  }
}

export function medianIqr(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return { count: 0, median: null, q1: null, q3: null, iqr: null }
  const quantile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
  return { count: sorted.length, median: quantile(0.5), q1: quantile(0.25), q3: quantile(0.75), iqr: quantile(0.75) - quantile(0.25) }
}

export function summarizeCategoryMetrics(runs) {
  const categories = [...new Set(runs.map(run => run.category).filter(Boolean))].sort()
  const byCategory = Object.fromEntries(categories.map(category => {
    const subset = runs.filter(run => run.category === category)
    const outcome = summarizeRunOutcomes(subset)
    return [category, { ...outcome, taskMajority: summarizeTaskMajority(subset), tokens: medianIqr(subset.map(run => run.totalTokens)) }]
  }))
  const rates = Object.values(byCategory).map(value => value.perProtocol.correctRate).filter(value => value !== null)
  return { byCategory, macroAverage: rates.length ? Number((rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(4)) : null }
}

/** Deterministic cluster bootstrap over task-level paired differences. */
export function pairedBootstrap(runsByArm, treatment, baseline = 'default', { iterations = 1000, seed = 'm5-bootstrap-v1' } = {}) {
  const leftRuns = runsByArm[treatment] ?? []
  const rightRuns = runsByArm[baseline] ?? []
  const taskIds = [...new Set([...leftRuns, ...rightRuns].map(run => run.taskId))].sort()
  const mean = (runs, id) => { const values = runs.filter(run => run.taskId === id && run.protocolEligible !== false).map(run => run.ok ? 1 : 0); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null }
  const differences = taskIds.map(id => [mean(leftRuns, id), mean(rightRuns, id)]).filter(([a, b]) => a !== null && b !== null).map(([a, b]) => a - b)
  if (!differences.length) return { treatment, baseline, direction: 'treatment-minus-baseline', tasks: 0, iterations: 0, difference: null, ci95: [null, null] }
  const random = seededRandom(seed)
  const estimates = Array.from({ length: iterations }, () => {
    let total = 0
    for (let i = 0; i < differences.length; i += 1) total += differences[Math.floor(random() * differences.length)]
    return total / differences.length
  }).sort((a, b) => a - b)
  const at = (p) => estimates[Math.min(estimates.length - 1, Math.floor(p * estimates.length))]
  return { treatment, baseline, direction: 'treatment-minus-baseline', tasks: differences.length, iterations, difference: Number((differences.reduce((a, b) => a + b, 0) / differences.length).toFixed(4)), ci95: [Number(at(0.025).toFixed(4)), Number(at(0.975).toFixed(4))] }
}

async function manifestFiles(root) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) {
        const bytes = await readFile(absolute)
        files.push({
          path: relative(root, absolute).split(sep).join('/'),
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
        })
      } else {
        throw new Error(`corpus contains unsupported non-regular entry: ${absolute}`)
      }
    }
  }
  await visit(root)
  return files
}

/** Verify a source tree against the frozen per-file manifest, including extras. */
export async function verifyCorpusTree(root, manifest) {
  const expected = manifest?.files
  if (!Array.isArray(expected)) throw new TypeError('corpus manifest must contain files[]')
  const actual = await manifestFiles(root)
  // Compare by path key, not by array order: the manifest's own traversal order
  // (depth-first per directory) is not the global lexicographic order its
  // `manifestAlgorithm` string advertises, so an order-sensitive diff would fail
  // or pass for the wrong reason if the manifest were ever regenerated.
  const expectedByPath = new Map(expected.map(file => [file.path, file]))
  const actualByPath = new Map(actual.map(file => [file.path, file]))
  const added = actual.filter(file => !expectedByPath.has(file.path)).map(file => file.path)
  const removed = expected.filter(file => !actualByPath.has(file.path)).map(file => file.path)
  const changed = actual.filter(file => {
    const wanted = expectedByPath.get(file.path)
    return wanted !== undefined && (wanted.bytes !== file.bytes || wanted.sha256 !== file.sha256)
  }).map(file => file.path)
  if (added.length > 0 || removed.length > 0 || changed.length > 0) {
    throw new Error(`corpus manifest mismatch (added=${added.length}, removed=${removed.length}, changed=${changed.length})`)
  }
  const totalBytes = actual.reduce((sum, file) => sum + file.bytes, 0)
  if (manifest.fileCount !== actual.length || manifest.totalBytes !== totalBytes) {
    throw new Error(`corpus manifest totals mismatch (files=${actual.length}, bytes=${totalBytes})`)
  }
  return Object.freeze({
    fileCount: actual.length,
    totalBytes,
    manifestSha256: sha256(canonicalManifest(manifest)),
  })
}

function canonicalManifest(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
}

/** Load and cross-check the lock and prepared manifest before an evaluation. */
export async function loadCorpusManifest() {
  const lockBytes = await readFile(CORPUS_LOCK_PATH)
  const lock = JSON.parse(lockBytes)
  if (lock.repository?.commit !== COMMIT) throw new Error('corpus lock commit does not match evaluation commit')
  if (typeof lock.corpus?.manifestFile !== 'string' || lock.corpus.manifestFile.length === 0) {
    throw new Error('corpus lock must name a manifest file')
  }
  const manifestPath = join(PKG_ROOT, lock.corpus.manifestFile)
  const manifestBytes = await readFile(manifestPath)
  const manifest = JSON.parse(manifestBytes)
  if (manifest.commit !== COMMIT || manifest.scanRoot !== lock.corpus?.scanRoot) {
    throw new Error('corpus manifest identity does not match corpus lock')
  }
  return {
    lock,
    manifest,
    lockSha256: sha256(lockBytes),
    manifestSha256: sha256(manifestBytes),
  }
}

/** Accuracy summary that excludes infrastructure/provider failures. */
export function summarizeCompletedRuns(runs, taskIds) {
  const selected = taskIds === undefined ? runs : runs.filter(run => taskIds.has(run.taskId))
  const completed = selected.filter(isProtocolCompleted)
  const failed = selected.length - completed.length
  const correct = completed.filter(run => run.ok).length
  return {
    attempts: selected.length,
    completed: completed.length,
    failed,
    correct,
    correctRate: completed.length ? Number((correct / completed.length).toFixed(4)) : null,
  }
}

/**
 * Preregistered Phase 2b primary endpoint: per-task majority vote across
 * repeats, then average over tasks (cluster-aware). Run-level pooling would let
 * one task's repeats outweigh another task, which the preregistration forbids.
 * Harness errors never enter the denominator; a task with no completed run is
 * reported as excluded instead of silently counted wrong.
 */
export function summarizeTaskMajority(runs, taskIds) {
  const selected = taskIds === undefined ? runs : runs.filter((run) => taskIds.has(run.taskId))
  const byTask = new Map()
  for (const run of selected) {
    const bucket = byTask.get(run.taskId) ?? { taskId: run.taskId, completed: 0, correct: 0 }
    if (isProtocolCompleted(run)) {
      bucket.completed += 1
      if (run.ok) bucket.correct += 1
    }
    byTask.set(run.taskId, bucket)
  }
  const evaluated = [...byTask.values()].filter((task) => task.completed > 0)
  const perTask = evaluated.map((task) => ({
    taskId: task.taskId,
    correct: task.correct,
    completed: task.completed,
    majority: task.correct * 2 > task.completed,
  }))
  const correct = perTask.filter((task) => task.majority).length
  return {
    tasks: byTask.size,
    evaluated: evaluated.length,
    excluded: byTask.size - evaluated.length,
    correct,
    correctRate: evaluated.length ? Number((correct / evaluated.length).toFixed(4)) : null,
    perTask,
  }
}

/**
 * Target tokens a gold sample requires an arm to surface, derived only from the
 * expected answer of the frozen gold. Shared so Phase 1 scores both arms with
 * the exact same requirement instead of two ad-hoc checks.
 *
 *   * declaration -> target names
 *   * relation/symbol -> contained target names
 *   * relation/file -> edge target specifier, name or path
 *   * source -> [] (grep cannot express a range; cost is compared separately)
 */
export function expectedTargetTokens(sample) {
  if (sample.category === 'declaration') return sample.expectedTargets.map((target) => target.name)
  if (sample.category !== 'relation') return []
  if (sample.relationKind === 'symbol') return sample.expected.targets.map((target) => target.name)
  return sample.expected
    .map((edge) => edge.target?.specifier ?? edge.target?.name ?? edge.target?.path)
    .filter((value) => typeof value === 'string')
}

/**
 * The target tokens a structured relation result actually surfaces. `contains`
 * edges carry only a `symbolId`, so they stay out of token comparison and are
 * scored by count instead (the harness never resolves IDs to names here).
 */
export function relationTargetTokens(relationships) {
  return (relationships ?? [])
    .map((relationship) => relationship?.target?.specifier ?? relationship?.target?.name ?? relationship?.target?.path)
    .filter((value) => typeof value === 'string')
}

const IDENTIFIER_TOKEN = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const REGEXP_METACHARS = /[.*+?^${}()|[\]\\]/g

/**
 * Whether raw retrieval text surfaces an expected target token.
 *
 * Identifier-like tokens must appear on an identifier boundary, so `en` no
 * longer scores a hit inside `then`/a path segment and `Red` no longer scores
 * inside `Redux`. Specifiers and paths (`zod/v4`, `./config.js`) contain
 * punctuation, where a word boundary is meaningless, so those are matched
 * literally. Both Phase 1 arms are scored through this one predicate, which
 * keeps grep from passing on a substring the structured arm must return exactly.
 */
export function textSurfacesToken(haystack, token) {
  if (typeof haystack !== 'string' || typeof token !== 'string' || token.length === 0) return false
  if (!IDENTIFIER_TOKEN.test(token)) return haystack.includes(token)
  const boundary = `(?:^|[^A-Za-z0-9_$])${token.replace(REGEXP_METACHARS, '\\$&')}(?:$|[^A-Za-z0-9_$])`
  return new RegExp(boundary).test(haystack)
}

/** All target tokens a raw retrieval payload actually surfaces. */
export function tokensSurfaced(haystack, tokens) {
  return tokens.filter((token) => textSurfacesToken(haystack, token))
}

export function requestCarriesToolSchemas(body) {
  return Array.isArray(body?.tools) && body.tools.length > 0
}

/** Build a format-only repair request with the ordinary schema context intact. */
export function jsonRepairRequest({ model, messages, wireTools, maxOutputTokens }) {
  return {
    model,
    messages,
    tools: wireTools,
    tool_choice: 'none',
    temperature: 0,
    max_tokens: maxOutputTokens,
    stream: false,
  }
}

// ---------------------------------------------------------------------------
// One coherent evaluation-host dependency graph.
//
// Context, ToolRuntime, SessionStore, ToolCallId, storage and FS/sandbox all
// come from one installed DSH profile. The built context_* bundle is loaded
// from its exact bytes with DSH externals remapped in memory to that profile.
// Merely sharing version strings is insufficient for Cordis service identity,
// so canonical peer package identities are asserted before any provider work.
// ---------------------------------------------------------------------------

// Resolve a package to the file Node's ESM loader would pick for it, so a
// shared library is loaded once even when `main` points at a CJS build.
async function esmEntryOf(packageJson) {
  const metadata = JSON.parse(await readFile(packageJson, 'utf8'))
  const dir = dirname(packageJson)
  const root = metadata.exports?.['.'] ?? metadata.exports
  if (root !== null && typeof root === 'object' && typeof root.import === 'string') return realpath(join(dir, root.import))
  if (typeof metadata.module === 'string') return realpath(join(dir, metadata.module))
  return realpath(join(dir, metadata.main ?? 'lib/index.js'))
}

async function packageRecord(packageJson, source) {
  const canonicalPackageJson = await realpath(packageJson)
  const metadata = JSON.parse(await readFile(canonicalPackageJson, 'utf8'))
  const entry = await realpath(join(dirname(canonicalPackageJson), metadata.main ?? 'lib/index.js'))
  const request = createRequire(canonicalPackageJson)
  const declared = { ...metadata.dependencies, ...metadata.peerDependencies }
  const peerIdentities = {}
  for (const peer of HOST_ANCHORS) {
    const fullName = `@deepseek-ai/${peer}`
    if (metadata.name === fullName) peerIdentities[peer] = canonicalPackageJson
    else if (declared[fullName] !== undefined) {
      try { peerIdentities[peer] = await realpath(request.resolve(`${fullName}/package.json`)) }
      catch { peerIdentities[peer] = null }
    } else peerIdentities[peer] = null
  }
  return {
    name: metadata.name,
    version: metadata.version,
    source,
    packageRoot: dirname(canonicalPackageJson),
    packageJson: canonicalPackageJson,
    entry,
    peerIdentities,
  }
}

/** Pure fail-closed check, exported so mismatch behavior has no-network tests. */
export function assertEvaluationHostConsistency(records) {
  const byName = new Map(records.map(record => [record.name, record]))
  const tools = byName.get('@deepseek-ai/dsh-tools')
  if (tools === undefined) throw new Error('evaluation host is missing @deepseek-ai/dsh-tools')
  const generation = tools.version
  for (const name of HOST_PACKAGES) {
    const fullName = `@deepseek-ai/${name}`
    const record = byName.get(fullName)
    if (record === undefined) throw new Error(`evaluation host is missing ${fullName}`)
    if (name !== 'cordis' && record.version !== generation) {
      throw new Error(`evaluation host version mismatch: ${fullName}@${record.version} != dsh-tools@${generation}`)
    }
  }
  const anchors = Object.fromEntries(HOST_ANCHORS.map(name => {
    const record = byName.get(`@deepseek-ai/${name}`)
    return [name, record.packageJson]
  }))
  for (const record of records) {
    for (const [peer, identity] of Object.entries(record.peerIdentities)) {
      if (identity !== null && identity !== anchors[peer]) {
        throw new Error(`evaluation host peer identity mismatch: ${record.name} resolves ${peer} outside the host graph`)
      }
    }
  }
  return Object.freeze({ generation, anchors: Object.freeze(anchors) })
}

/** Resolve and assert every core module before any corpus or provider work. */
export async function resolveEvaluationHost() {
  evaluationHostPromise ??= (async () => {
    const records = await Promise.all(HOST_PACKAGES.map(name => packageRecord(
      join(DSH_PROFILE_MODULES, name, 'package.json'),
      'dsh-profile',
    )))
    const consistency = assertEvaluationHostConsistency(records)
    const byShortName = Object.fromEntries(records.map(record => [record.name.slice('@deepseek-ai/'.length), record]))
    const codeIntelEntry = await realpath(join(PKG_ROOT, 'lib/index.js'))
    const source = await readFile(codeIntelEntry, 'utf8')
    const externalSpecifiers = [...new Set([...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\1/g)].map(match => match[2]))]
      .filter(specifier => !specifier.startsWith('node:'))
    const codeIntelRequire = createRequire(codeIntelEntry)
    const hostRequire = createRequire(join(DSH_PROFILE_MODULES, 'dsh-tools', 'package.json'))
    const externalMappings = {}
    const externalResolution = {}
    for (const specifier of externalSpecifiers) {
      const hostName = specifier.startsWith('@deepseek-ai/') ? specifier.slice('@deepseek-ai/'.length) : null
      let target
      if (hostName !== null && byShortName[hostName] !== undefined) {
        target = byShortName[hostName].entry
        externalResolution[specifier] = 'profile-host'
      } else if (specifier.startsWith('@deepseek-ai/')) {
        // A DSH-scoped library that is not itself a host package (e.g.
        // `@deepseek-ai/schemastery`): prefer the copy the host graph already
        // loads, so the library is not instantiated twice in one process.
        let packageJson = null
        for (const [origin, resolveFrom] of [['host-graph', hostRequire], ['own-tree', codeIntelRequire]]) {
          try { packageJson = await realpath(resolveFrom.resolve(`${specifier}/package.json`)); externalResolution[specifier] = origin; break } catch { /* try next */ }
        }
        target = packageJson !== null ? await esmEntryOf(packageJson) : await realpath(codeIntelRequire.resolve(specifier))
        if (packageJson === null) externalResolution[specifier] = 'own-tree-main'
      } else {
        // The bundle's own non-DSH dependency (workspace package, typescript,
        // picomatch): resolve from its tree exactly as before.
        target = await realpath(codeIntelRequire.resolve(specifier))
        externalResolution[specifier] = 'own-tree-main'
      }
      externalMappings[specifier] = pathToFileURL(target).href
    }
    // Remap only real import/export specifier positions. A naive global replace
    // would also rewrite identical text inside comments or string literals.
    const importSpecifier = /(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\1/g
    const consumed = new Set()
    const bridgedSource = source.replace(importSpecifier, (full, quote, specifier) => {
      const target = externalMappings[specifier]
      if (target === undefined) return full
      consumed.add(specifier)
      return full.replace(`${quote}${specifier}${quote}`, `${quote}${target}${quote}`)
    })
    const missed = externalSpecifiers.filter(specifier => !consumed.has(specifier))
    if (missed.length > 0) throw new Error(`evaluation bridge failed to remap: ${missed.join(', ')}`)
    const codeIntelligence = Object.freeze({
      entry: codeIntelEntry,
      sha256: sha256(source),
      loadingPolicy: 'in-memory-external-remap-to-profile-v2',
      externalMappings: Object.freeze(externalMappings),
      externalResolution: Object.freeze(externalResolution),
      moduleUrl: `data:text/javascript;base64,${Buffer.from(bridgedSource).toString('base64')}`,
    })
    const provenance = Object.freeze({
      policy: 'single-dsh-profile-peer-identity-v1',
      generation: consistency.generation,
      codeIntelligence: {
        entry: codeIntelEntry,
        sha256: codeIntelligence.sha256,
        loadingPolicy: codeIntelligence.loadingPolicy,
        externalMappings,
        externalResolution,
      },
      modules: Object.fromEntries(Object.entries(byShortName).map(([name, record]) => [name, {
        version: record.version,
        source: record.source,
        entry: record.entry,
        packageRoot: record.packageRoot,
        packageJson: record.packageJson,
        peerIdentities: record.peerIdentities,
      }])),
    })
    const [cordis, session, llm, tools] = await Promise.all([
      import(pathToFileURL(byShortName.cordis.entry).href),
      import(pathToFileURL(byShortName['dsh-session'].entry).href),
      import(pathToFileURL(byShortName['dsh-llm'].entry).href),
      import(pathToFileURL(byShortName['dsh-tools'].entry).href),
    ])
    return Object.freeze({
      generation: consistency.generation,
      modules: Object.freeze(byShortName),
      codeIntelligence,
      provenance,
      apis: Object.freeze({ Context: cordis.Context, SessionStore: session.default, SessionId: session.SessionId, ToolCallId: llm.ToolCallId ?? llm.CallId, ToolRuntime: tools.default }),
    })
  })()
  return evaluationHostPromise
}

/** Load the built product bundle with its DSH externals remapped to the host. */
export async function loadCodeIntelligence() {
  const host = await resolveEvaluationHost()
  return import(host.codeIntelligence.moduleUrl)
}


export async function loadEvaluationModule(name) {
  const host = await resolveEvaluationHost()
  const record = host.modules[name]
  if (record === undefined) throw new Error(`module is not part of the asserted evaluation host: ${name}`)
  return import(pathToFileURL(record.entry).href)
}

export async function loadFsSearch() {
  const host = await resolveEvaluationHost()
  const record = host.modules['dsh-tool-fs-search']
  return { entry: record.entry, module: await import(pathToFileURL(record.entry).href), provenance: host.provenance }
}

/** The frozen fs-search caps, read from the real bundle so they cannot drift. */
export function fsSearchConfig(fsSearch) {
  return {
    sampleOverCapGlobResults: false,
    globMaxResults: fsSearch.GLOB_MAX_RESULTS,
    grepMaxMatches: fsSearch.GREP_MAX_MATCHES,
    grepMaxLineBytes: fsSearch.GREP_MAX_LINE_BYTES,
    searchMetaMaxBytes: fsSearch.SEARCH_META_MAX_BYTES,
    rawOutputMaxBytes: fsSearch.RAW_OUTPUT_MAX_BYTES,
    graceMs: fsSearch.SEARCH_GRACE_MS,
    stderrMaxBytes: fsSearch.SEARCH_STDERR_MAX_BYTES,
    timeoutMs: fsSearch.SEARCH_TIMEOUT_MS,
  }
}

// ---------------------------------------------------------------------------
// Real DSH default retrieval tools (`read` + `grep`/`glob`).
//
// Product packages are loaded from the asserted package-local pnpm peer graph.
// `dsh-base` also mounts bash/subagent/web/workflow tools; those are deliberately
// excluded because they widen the action space far beyond retrieval.
// ---------------------------------------------------------------------------

const TOOL_FS_DEFAULTS = {
  readLimit: 2_000,
  readMaxLineLength: 2_000,
  readMaxBytes: 50 * 1024,
  readStreamMinSize: 10 * 1024 * 1024,
}

/**
 * Mount the real, read-only default retrieval surface into `ctx`.
 *
 * @param ctx - the cordis context from {@link makeRegistry}.
 * @param root - the workspace root already registered via {@link mountCorpus}.
 * @param options.includeSearch - mount `grep`/`glob` (default true).
 * @param options.fsSearch - an already-loaded `@deepseek-ai/dsh-tool-fs-search` module.
 * @returns provenance about the exact product packages that were mounted.
 */
export async function mountRetrievalTools(ctx, root, { includeSearch = true, fsSearch } = {}) {
  const sandboxLocal = await loadEvaluationModule('dsh-sandbox-local')
  await ctx.plugin(sandboxLocal.LocalSandboxProvider, {})

  const sandboxPolicy = await loadEvaluationModule('dsh-sandbox-policy')
  await ctx.plugin(sandboxPolicy.SandboxPolicyService, { mode: 'read-only', workspaceRoot: root })

  // `SandboxedFileSystem` is mounted INSTEAD OF `dsh-fs-local`; it extends the
  // local backend and adds containment, exactly as the shipped profile does.
  const fsSandbox = await loadEvaluationModule('dsh-fs-sandbox')
  await ctx.plugin(fsSandbox.SandboxedFileSystem, {})

  const observation = await loadEvaluationModule('dsh-fs-observation-policy')
  if (observation.apply) await ctx.plugin(observation.apply, {})

  const toolFs = await loadEvaluationModule('dsh-tool-fs')
  await ctx.plugin(
    { name: toolFs.name, inject: toolFs.inject, Config: toolFs.Config, apply: toolFs.apply },
    TOOL_FS_DEFAULTS,
  )

  const host = await resolveEvaluationHost()
  const provenance = host.provenance

  if (includeSearch) {
    const search = fsSearch ?? (await loadFsSearch()).module
    await ctx.plugin(search, fsSearchConfig(search))
  }
  // The shipped plugins register their own system-prompt sections. Returns them
  // so the comparison can forward the real prompt text (see
  // `systemPromptForTools`) instead of silently dropping it.
  return { provenance, promptSections: ctx.systemPromptSections ?? [] }
}

export function forwardedPromptSections(promptSections, exposedToolNames) {
  const exposed = new Set(exposedToolNames)
  return (promptSections ?? [])
    .filter((section) => typeof section?.text === 'string' && section.text.length > 0)
    .filter((section) => {
      const name = String(section.name ?? '')
      return name.startsWith('tool:') && exposed.has(name.slice('tool:'.length))
    })
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/**
 * Compose the model-facing system prompt the way the real harness would: the
 * caller's own preamble, then the product's registered sections for exactly the
 * tools that are actually exposed, ordered by `order`.
 *
 * The section name convention is `tool:<toolName>`, so a section is kept only
 * when its tool survived arm filtering. That keeps a surface without
 * `write`/`edit` from telling the model to use a tool it cannot see.
 */
export function systemPromptForTools(preamble, promptSections, exposedToolNames) {
  return [preamble, ...forwardedPromptSections(promptSections, exposedToolNames).map((s) => s.text)].join('\n\n')
}

/** Tools the read-only comparison arms may call. */
export const READ_TOOLS = ['read']
export const SEARCH_TOOLS = ['grep', 'glob']

// ---------------------------------------------------------------------------
// Provider credential resolution.
//
// The API key is read into process memory only. It is never written to any
// report, log, or artifact: callers record `apiKeySource`, never the value.
// ---------------------------------------------------------------------------

export const CREDENTIALS_PATH =
  process.env.DSH_CREDENTIALS_FILE ?? join(REPO_ROOT, '.dsh/.credentials.yaml')

/**
 * Resolve the DeepSeek API key from the environment, falling back to the
 * project credential store's `refs.DEEPSEEK_API_KEY`.
 *
 * @returns `{ key, source }`; `key` is `''` when nothing was found.
 */
export async function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) {
    return { key: process.env.DEEPSEEK_API_KEY, source: 'env:DEEPSEEK_API_KEY' }
  }
  try {
    const text = await readFile(CREDENTIALS_PATH, 'utf8')
    const match = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m)
    if (match) return { key: match[1], source: `credentials:${CREDENTIALS_PATH}` }
  } catch {
    // fall through: no readable credential store
  }
  return { key: '', source: null }
}

// ---------------------------------------------------------------------------
// Subprocess seam shim (real spawn; only capture/termination is reimplemented).
// ---------------------------------------------------------------------------

function makeRetainer(maxBytes) {
  const chunks = []
  let size = 0
  let lossy = false
  return {
    push(buf) {
      if (size >= maxBytes) { lossy = true; return }
      const remain = maxBytes - size
      if (buf.length > remain) { chunks.push(buf.subarray(0, remain)); size += remain; lossy = true }
      else { chunks.push(buf); size += buf.length }
    },
    readFrom() { return { text: Buffer.concat(chunks).toString('utf8'), lossy, bytes: size } },
  }
}

export function makeSubprocessShim() {
  return {
    spawn({ argv, cwd, stdio, signal }) {
      const [command, ...args] = argv
      const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      const out = makeRetainer(stdio?.stdout?.maxBytes ?? 1 << 30)
      const err = makeRetainer(stdio?.stderr?.maxBytes ?? 1 << 20)
      child.stdout.on('data', (b) => out.push(b))
      child.stderr.on('data', (b) => err.push(b))
      signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
      const done = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, sig) => resolve({ exitCode, signal: sig }))
      })
      return { done, collected: { stdout: out, stderr: err } }
    },
  }
}

// ---------------------------------------------------------------------------
// Real ToolRuntime + Storage + Workspace + SessionStore (mirrors acceptance).
// ---------------------------------------------------------------------------

function memoryBackend() {
  const units = new Map()
  return {
    kv: {
      async open(descriptor) {
        let state = units.get(descriptor.name)
        if (!state) {
          state = { tables: new Map(descriptor.tables.map((t) => [t, new Map()])), global: null }
          units.set(descriptor.name, state)
        }
        return {
          async loadAll() {
            return {
              tables: Object.fromEntries([...state.tables].map(([n, r]) => [n, Object.fromEntries(r)])),
              global: state.global,
            }
          },
          async putRecord(table, key, value) { state.tables.get(table).set(key, value) },
          async deleteRecord(table, key) { state.tables.get(table).delete(key) },
          async setGlobal(value) { state.global = value },
          async close() {},
        }
      },
    },
    async close() {},
  }
}

export async function makeRegistry() {
  const host = await resolveEvaluationHost()
  const { Context, SessionStore, ToolRuntime } = host.apis
  const ctx = new Context()
  ctx.provide('typert', { lookups: { register() { return () => {} } } })
  // Collected rather than dropped: the comparison forwards the product's own
  // system-prompt sections for the tools each arm actually exposes.
  const systemPromptSections = []
  ctx.provide('systemPrompt', {
    tools() { return () => {} },
    section(spec) { systemPromptSections.push(spec); return () => {} },
    getSectionOrder() { return 0 },
  })
  ctx.systemPromptSections = systemPromptSections
  ctx.provide('subprocess', makeSubprocessShim())
  await ctx.plugin(SessionStore)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const storage = await loadEvaluationModule('dsh-storage')
  const domain = await loadEvaluationModule('dsh-storage-domain')
  const workspace = await loadEvaluationModule('dsh-workspace')
  await ctx.plugin(storage.Storage)
  const backend = memoryBackend()
  ctx.storage.backend.register('memory', backend)
  ctx.provide('storage.backend.memory', backend)
  await ctx.plugin(
    { name: domain.name, inject: [...domain.inject, 'storage.backend.memory'], Config: domain.Config, apply: domain.apply },
    { backend: 'memory' },
  )
  ctx.provide('sessionPersistence', { async list() { return [] } })
  await ctx.plugin(workspace.WorkspaceRegistry)
  ctx.evaluationHostProvenance = host.provenance
  ctx.evaluationHostApis = host.apis
  return ctx
}

// ---------------------------------------------------------------------------
// Corpus + payload helpers.
// ---------------------------------------------------------------------------

/** Copy the frozen corpus into a scratch root, verify the copy, and register it. */
export async function mountCorpus(ctx, root, manifest) {
  await cp(CORPUS_ROOT, root, { recursive: true })
  if (manifest !== undefined) await verifyCorpusTree(root, manifest)
  const workspaces = ctx.get('workspaceRegistry')
  await workspaces.create(root)
  return root
}

export function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

/** UTF-8 bytes of the model-facing content blocks (what the model would receive). */
export function contentBytes(result) {
  return result.content.reduce((n, block) => n + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0)
}

export function contentText(result) {
  return result.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

/** Build the `call(name, args, agent)` helper bound to one session. */
export function makeCaller(ctx, session) {
  const { ToolCallId } = ctx.evaluationHostApis
  return (name, args, agent) => ctx.tools.execute({
    callId: ToolCallId(`${name}-${agent}-${Math.random().toString(36).slice(2, 8)}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: agent, session },
  })
}


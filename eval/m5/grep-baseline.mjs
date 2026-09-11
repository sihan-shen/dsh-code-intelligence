// M5 Phase 1 — DSH default-retrieval (grep) baseline.
//
// Runs the REAL product grep tool (`@deepseek-ai/dsh-tool-fs-search` over the
// packaged ripgrep binary) and the code-intelligence `context_*` tools through
// one real ToolRuntime over the frozen Zod corpus, on the same preregistered
// probes, and records retrieval + cost metrics for both arms.
//
// This is a benefit-evaluation pilot. It NEVER reads gold to build a probe and
// NEVER writes gold. Probes are frozen in `baseline-grep.patterns.json`; their
// sha256 is recorded in the report. Run:  node eval/m5/grep-baseline.mjs
//
// The subprocess seam is the one documented seam replaced here: ripgrep argv
// construction, execution, parsing, caps, retention, and model-facing rendering
// are all the real `dsh-tool-fs-search` code.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as codeIntelligenceApply } from '../../lib/index.js'

const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

// This harness AUTHORS no dependency edge on the measured tool: it imports the
// real `@deepseek-ai/dsh-tool-fs-search` bundle as it is already installed in
// this workspace (it is a transitive dependency of the DSH base profile). That
// keeps the baseline run from rewriting the shared root lockfile. Set
// `DSH_FS_SEARCH_ENTRY` to override the located bundle.
async function findFsSearchEntry() {
  const candidates = [
    process.env.DSH_FS_SEARCH_ENTRY,
    join(PKG_ROOT, 'node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js'),
    join(REPO_ROOT, '.dsh/profiles/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js'),
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    if (await readFile(candidate).then(() => true, () => false)) return candidate
  }
  const store = join(REPO_ROOT, 'node_modules/.pnpm')
  const dirs = await readdir(store).catch(() => [])
  for (const dir of dirs.filter((d) => d.startsWith('@deepseek-ai+dsh-tool-fs-search@')).sort()) {
    const entry = join(store, dir, 'node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js')
    if (await readFile(entry).then(() => true, () => false)) return entry
  }
  throw new Error('cannot locate @deepseek-ai/dsh-tool-fs-search; set DSH_FS_SEARCH_ENTRY to its lib/index.js')
}

const FS_SEARCH_ENTRY = await findFsSearchEntry()
const fsSearch = await import(pathToFileURL(FS_SEARCH_ENTRY).href)

const CORPUS_ROOT = join(PKG_ROOT, 'node_modules/.cache/m5-eval/corpus/zod-1fb56a5c18c27102dbc92260a4007c7732a0ccca/packages/zod/src')
const COMMIT = '1fb56a5c18c27102dbc92260a4007c7732a0ccca'
const GOLD_PATH = fileURLToPath(new URL('./gold.json', import.meta.url))
const PROBES_PATH = fileURLToPath(new URL('./baseline-grep.patterns.json', import.meta.url))
const REPORT_DIR = join(PKG_ROOT, 'node_modules/.cache/m5-eval/reports')
const REPORT_PATH = join(REPORT_DIR, 'baseline-grep.json')
const GREP_TOOL_NAMES = ['grep', 'glob']
const STRUCTURED_TOOL_NAMES = ['context_repo_map', 'context_symbol_query', 'context_relation_query', 'context_expand_source', 'context_refresh_snapshot']

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const tokensEst = (bytes) => Math.ceil(bytes / 4)
const exists = (path) => readFile(path).then(() => true, () => false)

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

function makeSubprocessShim() {
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
  return { kv: { async open(descriptor) {
    let state = units.get(descriptor.name)
    if (!state) { state = { tables: new Map(descriptor.tables.map((t) => [t, new Map()])), global: null }; units.set(descriptor.name, state) }
    return {
      async loadAll() { return { tables: Object.fromEntries([...state.tables].map(([n, r]) => [n, Object.fromEntries(r)])), global: state.global } },
      async putRecord(table, key, value) { state.tables.get(table).set(key, value) },
      async deleteRecord(table, key) { state.tables.get(table).delete(key) },
      async setGlobal(value) { state.global = value },
      async close() {},
    }
  } }, async close() {} }
}

async function makeRegistry() {
  const ctx = new Context()
  ctx.provide('typert', { lookups: { register() { return () => {} } } })
  ctx.provide('systemPrompt', { tools() { return () => {} }, section() { return () => {} }, getSectionOrder() { return 0 } })
  ctx.provide('subprocess', makeSubprocessShim())
  await ctx.plugin(SessionStore)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const storage = await import('@deepseek-ai/dsh-storage')
  const domain = await import('@deepseek-ai/dsh-storage-domain')
  const workspace = await import('@deepseek-ai/dsh-workspace')
  await ctx.plugin(storage.Storage)
  const backend = memoryBackend()
  ctx.storage.backend.register('memory', backend)
  ctx.provide('storage.backend.memory', backend)
  await ctx.plugin({ name: domain.name, inject: [...domain.inject, 'storage.backend.memory'], Config: domain.Config, apply: domain.apply }, { backend: 'memory' })
  ctx.provide('sessionPersistence', { async list() { return [] } })
  await ctx.plugin(workspace.WorkspaceRegistry)
  return ctx
}

// ---------------------------------------------------------------------------
// Scoring helpers.
// ---------------------------------------------------------------------------

function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

// grep matches are line-granular: a hit counts as inside a span when the hit
// line's [start,end) overlaps the span's [startOffset,endOffset).
function matchOverlapsSpan(match, span, lines) {
  const start = lines[match.lineNumber - 1]
  if (start === undefined) return false
  const lineEnd = lines[match.lineNumber] ?? Number.MAX_SAFE_INTEGER
  return start < span.endOffset && lineEnd > span.startOffset
}

function expectedTokens(sample) {
  if (sample.category === 'declaration') return sample.expectedTargets.map((t) => t.name)
  if (sample.category !== 'relation') return []
  if (sample.relationKind === 'symbol') return sample.expected.targets.map((t) => t.name)
  return sample.expected.map((edge) => edge.target?.specifier ?? edge.target?.name ?? edge.target?.path).filter((v) => typeof v === 'string')
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

const report = {
  schemaVersion: 1,
  kind: 'grep-retrieval-baseline',
  phase: 'M5 Phase 1 (static retrieval comparison, no model in the loop)',
  startedAt: new Date().toISOString(),
  node: process.version,
  corpusCommit: COMMIT,
  corpusRoot: CORPUS_ROOT,
  goldSha256: sha256(await readFile(GOLD_PATH)),
  probesSha256: sha256(await readFile(PROBES_PATH)),
  grepTool: {
    package: fsSearch.name,
    entry: FS_SEARCH_ENTRY,
    version: JSON.parse(await readFile(join(dirname(FS_SEARCH_ENTRY), '..', 'package.json'), 'utf8')).version,
    inject: fsSearch.inject,
    engine: '@vscode/ripgrep',
  },
  definitions: {
    located: 'grep arm: at least one returned match overlaps a gold target span (declaration), the named file (source), or the relation endpoint span/file (relation). structured arm: the context_* tool returned a non-error result whose content matches the gold expectation shape.',
    cost: 'model-facing content bytes = UTF-8 bytes of the ToolRuntime ContentBlock text the model would receive.',
    tokens: 'estimated as ceil(contentBytes / 4); not a provider tokenizer.',
    sourceArm: 'grep cannot return a range; the source arm must also read the whole named file, so fileBytes is reported alongside grep bytes.',
  },
  samples: [],
  summary: {},
  failures: [],
  notes: [],
}

const cleanup = []
const tempDirs = []

try {
  const gold = JSON.parse(await readFile(GOLD_PATH, 'utf8'))
  const probes = JSON.parse(await readFile(PROBES_PATH, 'utf8'))
  const goldById = new Map(gold.samples.map((s) => [s.id, s]))
  const probeIds = probes.probes.map((p) => p.id)
  const goldIds = gold.samples.map((s) => s.id)
  if (probeIds.length !== goldIds.length || goldIds.some((id) => !probeIds.includes(id))) {
    throw new Error(`probe/gold id mismatch: probes=${probeIds.length} gold=${goldIds.length}`)
  }

  const ctx = await makeRegistry()
  cleanup.push(() => ctx.dispose())
  const parent = await mkdtemp(join(tmpdir(), 'm5-grepbase-'))
  tempDirs.push(parent)
  const root = join(parent, 'src')
  await cp(CORPUS_ROOT, root, { recursive: true })

  const workspaces = ctx.get('workspaceRegistry')
  await workspaces.create(root)

  const grepStartup = performance.now()
  await ctx.plugin(fsSearch, {
    sampleOverCapGlobResults: false,
    globMaxResults: fsSearch.GLOB_MAX_RESULTS,
    grepMaxMatches: fsSearch.GREP_MAX_MATCHES,
    grepMaxLineBytes: fsSearch.GREP_MAX_LINE_BYTES,
    searchMetaMaxBytes: fsSearch.SEARCH_META_MAX_BYTES,
    rawOutputMaxBytes: fsSearch.RAW_OUTPUT_MAX_BYTES,
    graceMs: fsSearch.SEARCH_GRACE_MS,
    stderrMaxBytes: fsSearch.SEARCH_STDERR_MAX_BYTES,
    timeoutMs: fsSearch.SEARCH_TIMEOUT_MS,
  })
  // grep indexes nothing up front; it pays per call.
  report.grepStartupMs = Math.round(performance.now() - grepStartup)
  const structuredStartup = performance.now()
  await ctx.plugin(codeIntelligenceApply, { deploymentRoot: '.', revision: COMMIT })
  // The structured plugin loads lazily; the whole-corpus index is built on the
  // first query, so report the plugin load separately from the cold query.
  report.structuredPluginLoadMs = Math.round(performance.now() - structuredStartup)

  for (const name of [...GREP_TOOL_NAMES, ...STRUCTURED_TOOL_NAMES]) {
    if (!ctx.tools.get(name)) throw new Error(`tool not registered: ${name}`)
  }

  const session = ctx.sessions.prepare(SessionId('m5-grep-baseline'), { meta: { cwd: root } })
  const detach = ctx.sessions.enter(session)
  cleanup.push(detach)
  ctx.sessions.announce(session)

  const call = (name, args, agent) => ctx.tools.execute({
    callId: ToolCallId(`${name}-${agent}`), name, arguments: args, signal: new AbortController().signal,
    agent: { id: agent, session },
  })

  const contentBytes = (result) => result.content.reduce((n, block) => n + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0)
  const contentText = (result) => result.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')

  const linesCache = new Map()
  const linesFor = async (path) => {
    if (!linesCache.has(path)) linesCache.set(path, lineStarts(await readFile(join(root, ...path.split('/')), 'utf8')))
    return linesCache.get(path)
  }

  // Pull the active snapshot id + every per-file receipt hash from the real repo-map tool.
  const repoMapStart = performance.now()
  const sourceHashes = new Map()
  let snapshotId
  let repomapCursor
  do {
    const page = await call('context_repo_map', repomapCursor ? { cursor: repomapCursor } : {}, 'baseline')
    if (page.isError) throw new Error(`repo_map failed: ${page.error.message}`)
    snapshotId = page.value.snapshotId
    for (const item of page.value.items) sourceHashes.set(item.path, item.sourceHash)
    repomapCursor = page.value.nextCursor ?? undefined
  } while (repomapCursor)
  report.snapshotId = snapshotId
  report.repoMapFiles = sourceHashes.size
  report.coldRepoMapMs = Math.round(performance.now() - repoMapStart)
  const warmStart = performance.now()
  await call('context_repo_map', {}, 'baseline-warm')
  report.warmRepoMapMs = Math.round(performance.now() - warmStart)

  const totals = { grep: { located: 0, bytes: 0, ms: 0 }, structured: { located: 0, bytes: 0, ms: 0 } }
  const byCategory = {}

  for (const probe of probes.probes) {
    const sample = goldById.get(probe.id)
    const entry = { id: probe.id, category: sample.category, probe: probe.grep, basis: probe.basis }

    // ---- grep arm ----
    const grepStart = performance.now()
    const grepResult = await call('grep', probe.grep, `grep-${probe.id}`)
    const grepMs = Math.round(performance.now() - grepStart)
    if (grepResult.isError) throw new Error(`grep failed for ${probe.id}: ${grepResult.error.message}`)
    const matches = grepResult.value.matches ?? []
    const grepText = contentText(grepResult)
    const grepBytes = contentBytes(grepResult)

    let located = false
    let targetsHit = 0
    let targetsTotal = 0
    let firstMatchIsTarget = null
    let sortedFirstIsTarget = null
    let fileBytes
    if (sample.category === 'declaration') {
      targetsTotal = sample.expectedTargets.length
      const overlapsAny = async (match) => {
        for (const target of sample.expectedTargets) {
          if (match.path !== target.path) continue
          if (matchOverlapsSpan(match, target, await linesFor(target.path))) return true
        }
        return false
      }
      for (const target of sample.expectedTargets) {
        const lines = await linesFor(target.path)
        if (matches.some((m) => m.path === target.path && matchOverlapsSpan(m, target, lines))) targetsHit += 1
      }
      located = targetsHit === targetsTotal
      firstMatchIsTarget = matches.length > 0 ? await overlapsAny(matches[0]) : null
      const sorted = [...matches].sort((a, b) => (a.path === b.path ? a.lineNumber - b.lineNumber : a.path < b.path ? -1 : 1))
      sortedFirstIsTarget = sorted.length > 0 ? await overlapsAny(sorted[0]) : null
    } else if (sample.category === 'source') {
      const path = sample.request.path
      fileBytes = Buffer.byteLength(await readFile(join(root, ...path.split('/')), 'utf8'), 'utf8')
      targetsTotal = 1
      targetsHit = matches.some((m) => m.path === path) ? 1 : 0
      located = targetsHit === 1
    } else if (sample.relationKind === 'symbol') {
      const span = sample.expected.source
      const lines = await linesFor(span.path)
      targetsTotal = sample.expected.targets.length
      located = matches.some((m) => m.path === span.path && matchOverlapsSpan(m, span, lines))
      targetsHit = located ? 1 : 0
      firstMatchIsTarget = matches.length > 0 ? (matches[0].path === span.path && matchOverlapsSpan(matches[0], span, lines)) : null
    } else {
      const path = sample.request.from.path
      targetsTotal = sample.expected.length
      // A zero-edge relation is answered correctly by finding no matches.
      located = targetsTotal === 0 ? matches.length === 0 : matches.some((m) => m.path === path)
      targetsHit = targetsTotal === 0 ? (located ? 1 : 0) : (located ? 1 : 0)
    }

    const want = expectedTokens(sample)
    const found = want.filter((token) => grepText.includes(token))

    entry.grep = {
      pattern: probe.grep.pattern, path: probe.grep.path ?? null,
      matches: matches.length, contentBytes: grepBytes, tokensEst: tokensEst(grepBytes), ms: grepMs,
      located, targetsHit, targetsTotal, fileBytes: fileBytes ?? null, firstMatchIsTarget, sortedFirstIsTarget,
      precision: matches.length > 0 ? Number((targetsHit / matches.length).toFixed(3)) : null,
      expectedTokensFound: found.length, expectedTokensTotal: want.length,
      truncated: /^Found \d+ of \d+ matches/.test(grepText),
    }

    // ---- structured arm ----
    let structuredArgs
    let structuredPrecallMs = 0
    if (sample.category === 'declaration') structuredArgs = { name: 'context_symbol_query', args: { snapshotId, ...sample.request } }
    else if (sample.category === 'relation') {
      let from = sample.request.from
      if (sample.relationKind === 'symbol') {
        // The public relation tool takes a symbolId or a path; the task input names
        // the symbol, so the structured arm must first resolve it like an agent would.
        const lookupStart = performance.now()
        const lookup = await call('context_symbol_query', {
          snapshotId, name: from.symbolName, mode: 'exact', kind: from.symbolKind, pathPrefix: from.symbolPrefix,
        }, `ctx-lookup-${probe.id}`)
        structuredPrecallMs = performance.now() - lookupStart
        if (lookup.isError) throw new Error(`symbol lookup failed for ${probe.id}: ${lookup.error.message}`)
        from = { symbolId: lookup.value.matches[0].symbolId }
      }
      structuredArgs = { name: 'context_relation_query', args: { snapshotId, from, types: sample.request.types } }
    } else {
      const path = sample.request.path
      const args = { snapshotId, path, sourceHash: sourceHashes.get(path) }
      if (sample.request.wholeFile) args.wholeFile = true
      if (sample.request.offsetRange) args.offsetRange = sample.request.offsetRange
      if (sample.request.lineRange) args.lineRange = sample.request.lineRange
      if (sample.request.paddingLines !== undefined) args.paddingLines = sample.request.paddingLines
      structuredArgs = { name: 'context_expand_source', args }
    }
    const structuredStart = performance.now()
    const structuredResult = await call(structuredArgs.name, structuredArgs.args, `ctx-${probe.id}`)
    const structuredMs = Math.round(performance.now() - structuredStart + structuredPrecallMs)
    const structuredBytes = contentBytes(structuredResult)

    let structuredOk = !structuredResult.isError
    if (structuredOk && sample.category === 'declaration') structuredOk = structuredResult.value.matches.length === sample.expectedTargets.length
    if (structuredOk && sample.category === 'source') structuredOk = structuredResult.value.text === sample.expected.text
    if (structuredOk && sample.category === 'relation' && sample.relationKind === 'symbol') structuredOk = structuredResult.value.relationships.length === sample.expected.targets.length

    entry.structured = {
      tool: structuredArgs.name, ok: structuredOk, contentBytes: structuredBytes,
      tokensEst: tokensEst(structuredBytes), ms: structuredMs,
      error: structuredResult.isError ? structuredResult.error.message : null,
    }

    totals.grep.bytes += grepBytes
    totals.grep.ms += grepMs
    totals.structured.bytes += structuredBytes
    totals.structured.ms += structuredMs
    if (located) totals.grep.located += 1
    if (structuredOk) totals.structured.located += 1

    const cat = (byCategory[sample.category] ??= { total: 0, grepLocated: 0, structuredOk: 0, grepBytes: 0, structuredBytes: 0 })
    cat.total += 1
    if (located) cat.grepLocated += 1
    if (structuredOk) cat.structuredOk += 1
    cat.grepBytes += grepBytes
    cat.structuredBytes += structuredBytes

    report.samples.push(entry)
  }

  const n = probes.probes.length
  const declSamples = report.samples.filter((s) => s.category === 'declaration')
  const srcSamples = report.samples.filter((s) => s.category === 'source')
  report.summary = {
    samples: n,
    grep: { located: totals.grep.located, total: n, meanContentBytes: Math.round(totals.grep.bytes / n), meanTokensEst: tokensEst(Math.round(totals.grep.bytes / n)), meanMs: Math.round(totals.grep.ms / n) },
    structured: { located: totals.structured.located, total: n, meanContentBytes: Math.round(totals.structured.bytes / n), meanTokensEst: tokensEst(Math.round(totals.structured.bytes / n)), meanMs: Math.round(totals.structured.ms / n) },
    byCategory,
    declaration: {
      grepTop1: declSamples.filter((s) => s.grep.firstMatchIsTarget === true).length,
      grepSortedTop1: declSamples.filter((s) => s.grep.sortedFirstIsTarget === true).length,
      total: declSamples.length,
      returnedMatches: declSamples.reduce((a, s) => a + s.grep.matches, 0),
      goldTargets: declSamples.reduce((a, s) => a + s.grep.targetsTotal, 0),
      grepContentBytes: declSamples.reduce((a, s) => a + s.grep.contentBytes, 0),
      structuredContentBytes: declSamples.reduce((a, s) => a + s.structured.contentBytes, 0),
    },
    source: {
      grepContentBytes: srcSamples.reduce((a, s) => a + s.grep.contentBytes, 0),
      deferredWholeFileReadBytes: srcSamples.reduce((a, s) => a + (s.grep.fileBytes ?? 0), 0),
      structuredContentBytes: srcSamples.reduce((a, s) => a + s.structured.contentBytes, 0),
    },
  }

  report.notes.push(
    'Both arms ran through the same real ToolRuntime over the same temp corpus copy.',
    'grep is line-oriented and reports path+lineNumber+line; it cannot express kind, semantic relation, or an exact byte range, so declaration/source/relation success here is a retrieval-surfacing signal, not a structural-equivalence result.',
    'Declaration grepSortedTop1 sorts matches by (path, lineNumber) and checks the first; raw ripgrep ordering is not a documented contract and was observed to vary between runs (grepTop1 5 or 6 of 8), so grepTop1 is reported for transparency only.',
    'Source-arm baseline cost excludes the mandatory follow-up whole-file read; deferredWholeFileReadBytes records that additional cost.',
    'Probes were frozen before any run; see probesSha256. Gold was never read to build a probe.',
  )
} catch (error) {
  report.failures.push(`${error?.stack ?? error}`)
} finally {
  for (const dispose of cleanup.splice(0).reverse()) { try { await dispose() } catch {} }
  for (const dir of tempDirs) { try { await rm(dir, { recursive: true, force: true }) } catch {} }
  report.finishedAt = new Date().toISOString()
  report.ok = report.failures.length === 0
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
}

if (!report.ok) {
  console.error(report.failures.join('\n'))
  process.exitCode = 1
} else {
  const { summary } = report
  console.log(`samples=${summary.samples}`)
  console.log(`grep       located ${summary.grep.located}/${summary.grep.total}  meanBytes=${summary.grep.meanContentBytes}  meanMs=${summary.grep.meanMs}`)
  console.log(`structured located ${summary.structured.located}/${summary.structured.total}  meanBytes=${summary.structured.meanContentBytes}  meanMs=${summary.structured.meanMs}`)
  for (const [cat, v] of Object.entries(summary.byCategory)) {
    console.log(`  ${cat.padEnd(12)} grep ${v.grepLocated}/${v.total} bytes=${v.grepBytes}  structured ${v.structuredOk}/${v.total} bytes=${v.structuredBytes}`)
  }
  console.log(`declaration: grepSortedTop1 ${summary.declaration.grepSortedTop1}/${summary.declaration.total}, matches ${summary.declaration.returnedMatches} for ${summary.declaration.goldTargets} targets`)
  console.log(`startup: grep ${report.grepStartupMs}ms vs structured plugin load ${report.structuredPluginLoadMs}ms; cold repo-map (index build + walk) ${report.coldRepoMapMs}ms, warm ${report.warmRepoMapMs}ms`)
  console.log(`source: grep ${summary.source.grepContentBytes}B + deferred read ${summary.source.deferredWholeFileReadBytes}B vs structured ${summary.source.structuredContentBytes}B`)
  console.log(`report: ${REPORT_PATH}`)
}

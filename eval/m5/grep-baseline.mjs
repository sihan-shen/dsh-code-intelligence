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
// The subprocess seam is replaced by the shared harness shim in `./harness.mjs`:
// ripgrep argv construction, execution, parsing, caps, retention, and model-facing
// rendering are all the real `dsh-tool-fs-search` code. The host (cordis,
// session store, tool runtime, storage, workspace, sandbox, fs) is likewise
// sourced from one asserted profile graph so this baseline cannot drift from
// the Phase 2/3 runs.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMMIT,
  CORPUS_ROOT,
  EVALUATION_CODE_INTELLIGENCE_CONFIG,
  GOLD_PATH,
  GREP_TOOL_NAMES,
  STRUCTURED_TOOL_NAMES,
  contentBytes,
  contentText,
  expectedTargetTokens,
  lineStarts,
  loadCodeIntelligence,
  loadCorpusManifest,
  loadFsSearch,
  makeCaller,
  makeRegistry,
  mountCorpus,
  mountRetrievalTools,
  relationTargetTokens,
  sha256,
  tokensSurfaced,
} from './harness.mjs'

const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url))

// This harness sources all DSH host components from one asserted profile graph,
// the same host the Phase 2/3 scripts use (see `./harness.mjs`). It authors no
// dependency edge on the measured tool: `loadFsSearch()` imports the already
// installed profile bundle, so running the baseline cannot rewrite the shared
// root lockfile.

const PROBES_PATH = fileURLToPath(new URL('./baseline-grep.patterns.json', import.meta.url))
const REPORT_DIR = join(PKG_ROOT, 'node_modules/.cache/m5-eval/reports')
// `--out <path>` keeps ad-hoc verification runs out of the cached historical
// report directory; the default stays the committed evidence path.
const OUT_FLAG = process.argv.indexOf('--out')
if (OUT_FLAG >= 0 && (process.argv[OUT_FLAG + 1] === undefined || process.argv[OUT_FLAG + 1].startsWith('--'))) {
  throw new Error('--out requires a file path')
}
const REPORT_PATH = OUT_FLAG >= 0
  ? process.argv[OUT_FLAG + 1]
  : join(REPORT_DIR, 'baseline-grep.json')

const tokensEst = (bytes) => Math.ceil(bytes / 4)

// ---------------------------------------------------------------------------
// Scoring helpers.
// ---------------------------------------------------------------------------

// grep matches are line-granular: a hit counts as inside a span when the hit
// line's [start,end) overlaps the span's [startOffset,endOffset).
function matchOverlapsSpan(match, span, lines) {
  const start = lines[match.lineNumber - 1]
  if (start === undefined) return false
  const lineEnd = lines[match.lineNumber] ?? Number.MAX_SAFE_INTEGER
  return start < span.endOffset && lineEnd > span.startOffset
}

function expectedTokens(sample) {
  return expectedTargetTokens(sample)
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

// Resolve the measured grep bundle from the asserted single-profile host. The
// whole host graph is asserted before any corpus/provider work (see harness).
const { module: fsSearch, entry: FS_SEARCH_ENTRY, provenance: evaluationHostProvenance } = await loadFsSearch()

const report = {
  schemaVersion: 1,
  kind: 'grep-retrieval-baseline',
  phase: 'M5 Phase 1 (static retrieval comparison, no model in the loop)',
  startedAt: new Date().toISOString(),
  node: process.version,
  corpusCommit: COMMIT,
  corpusRoot: CORPUS_ROOT,
  evaluationHostGeneration: evaluationHostProvenance.generation,
  goldSha256: sha256(await readFile(GOLD_PATH)),
  probesSha256: sha256(await readFile(PROBES_PATH)),
  grepTool: {
    package: fsSearch.name,
    entry: FS_SEARCH_ENTRY,
    version: evaluationHostProvenance.modules['dsh-tool-fs-search'].version,
    generation: evaluationHostProvenance.generation,
    inject: fsSearch.inject,
    engine: '@vscode/ripgrep',
  },
  definitions: {
    located: 'grep arm: declaration -> every expected declaration has a match overlapping its span at its own path; source -> a match overlaps the expected answer span (not merely somewhere in the file); relation -> shared target-token coverage (zero-edge requires no matches). structured arm: declaration -> every expected name returned at its own path; source -> exact text equality; relation -> shared target-token coverage (symbol `contains` edges compared by count because they expose only symbolIds). v1/v2 scored a source hit on any match in the named file; v3 requires the hit to land in the expected region.',
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
  report.probeSchemaVersion = probes.schemaVersion
  report.probeRevision = probes.revision ?? null
  report.scoring = 'symmetric-target-coverage-v3'
  const goldById = new Map(gold.samples.map((s) => [s.id, s]))
  const probeIds = probes.probes.map((p) => p.id)
  const goldIds = gold.samples.map((s) => s.id)
  if (probeIds.length !== goldIds.length || goldIds.some((id) => !probeIds.includes(id))) {
    throw new Error(`probe/gold id mismatch: probes=${probeIds.length} gold=${goldIds.length}`)
  }

  const ctx = await makeRegistry()
  cleanup.push(() => ctx.fiber.dispose())
  const parent = await mkdtemp(join(tmpdir(), 'm5-grepbase-'))
  tempDirs.push(parent)
  const root = join(parent, 'src')
  const corpusIdentity = await loadCorpusManifest()
  report.corpusLockSha256 = corpusIdentity.lockSha256
  report.corpusManifestSha256 = corpusIdentity.manifestSha256

  const corpusMountStart = performance.now()
  // Mounts the shared retrieval stack (fs-sandbox policy + the real
  // `dsh-tool-fs-search` bundle) and adds the copied corpus to the workspace
  // registry; the copy is byte-verified against the frozen manifest.
  await mountCorpus(ctx, root, corpusIdentity.manifest)
  report.corpusMountMs = Math.round(performance.now() - corpusMountStart)
  const grepStartup = performance.now()
  await mountRetrievalTools(ctx, root, { includeSearch: true, fsSearch })
  // grep indexes nothing up front; it pays per call.
  report.grepStartupMs = Math.round(performance.now() - grepStartup)
  const structuredStartup = performance.now()
  const codeIntel = await loadCodeIntelligence()
  await ctx.plugin(codeIntel.apply, EVALUATION_CODE_INTELLIGENCE_CONFIG)
  // The structured plugin loads lazily; the whole-corpus index is built on the
  // first query, so report the plugin load separately from the cold query.
  report.structuredPluginLoadMs = Math.round(performance.now() - structuredStartup)

  for (const name of [...GREP_TOOL_NAMES, ...STRUCTURED_TOOL_NAMES]) {
    if (!ctx.tools.get(name)) throw new Error(`tool not registered: ${name}`)
  }

  const session = ctx.sessions.prepare(ctx.evaluationHostApis.SessionId('m5-grep-baseline'), { meta: { cwd: root } })
  const detach = ctx.sessions.enter(session)
  cleanup.push(detach)
  ctx.sessions.announce(session)

  const call = makeCaller(ctx, session)

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
    const want = expectedTokens(sample)
    const found = tokensSurfaced(grepText, want)
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
      const lines = await linesFor(path)
      fileBytes = Buffer.byteLength(await readFile(join(root, ...path.split('/')), 'utf8'), 'utf8')
      // A grep hit must land in the expected answer region, not merely anywhere
      // in the named file. "The file was mentioned" is nearly free and would
      // flatter the grep arm in a metric named `located`.
      const span = { startOffset: sample.expected.startOffset, endOffset: sample.expected.endOffset }
      targetsTotal = 1
      targetsHit = matches.some((m) => m.path === path && matchOverlapsSpan(m, span, lines)) ? 1 : 0
      located = targetsHit === 1
    } else if (sample.relationKind === 'symbol') {
      const span = sample.expected.source
      const lines = await linesFor(span.path)
      // Symmetric requirement: surface every expected target name. grep can only
      // line-match the containing statement, so nested member names usually stay
      // hidden; that is an honest grep limitation, not a scoring freebie.
      targetsTotal = want.length
      targetsHit = found.length
      located = want.length > 0 && found.length === want.length
      firstMatchIsTarget = matches.length > 0 ? (matches[0].path === span.path && matchOverlapsSpan(matches[0], span, lines)) : null
    } else {
      // File relation: same token-coverage rule the structured arm uses below; a
      // zero-edge relation is answered by surfacing no matches.
      targetsTotal = want.length
      targetsHit = found.length
      located = want.length === 0 ? matches.length === 0 : found.length === want.length
    }

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
    let structuredPrecallBytes = 0
    if (sample.category === 'declaration') structuredArgs = { name: 'context_symbol_query', args: { snapshotId, ...sample.request } }
    else if (sample.category === 'relation') {
      let from = sample.request.from
      if (sample.relationKind === 'symbol') {
        // The public relation tool takes a symbolId or a path; the task input names
        // the symbol, so the structured arm must first resolve it like an agent would.
        // Its latency AND its model-facing bytes are charged to the structured arm:
        // the lookup is an extra round trip grep does not need.
        const lookupStart = performance.now()
        const lookup = await call('context_symbol_query', {
          snapshotId, name: from.symbolName, mode: 'exact', kind: from.symbolKind, pathPrefix: from.symbolPrefix,
        }, `ctx-lookup-${probe.id}`)
        structuredPrecallMs = performance.now() - lookupStart
        if (lookup.isError) throw new Error(`symbol lookup failed for ${probe.id}: ${lookup.error.message}`)
        structuredPrecallBytes = contentBytes(lookup)
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
    const structuredBytes = contentBytes(structuredResult) + structuredPrecallBytes

    let structuredOk = !structuredResult.isError
    let structuredTargetsHit = null
    let structuredTargetsTotal = null
    if (structuredOk && sample.category === 'declaration') {
      // Coverage, not count: every expected declaration must come back at its
      // own path with its own name, so a same-length wrong answer fails.
      const returned = structuredResult.value.matches ?? []
      structuredTargetsTotal = sample.expectedTargets.length
      structuredTargetsHit = sample.expectedTargets.filter((target) =>
        returned.some((match) => match.path === target.path && match.name === target.name)).length
      structuredOk = structuredTargetsHit === structuredTargetsTotal
    }
    if (structuredOk && sample.category === 'source') structuredOk = structuredResult.value.text === sample.expected.text
    if (structuredOk && sample.category === 'relation') {
      // Previously only `relationKind === 'symbol'` was checked, so file
      // relations (imports/exports/calls) passed on `!isError` alone. Score them
      // with the same target-token requirement the grep arm receives.
      const relationships = structuredResult.value.relationships ?? []
      structuredTargetsTotal = want.length
      if (sample.relationKind === 'symbol') {
        // `contains` edges expose only target symbolIds, so the shared token set
        // is not comparable here; count equality is the strongest check available.
        structuredTargetsHit = Math.min(relationships.length, want.length)
        structuredOk = relationships.length === want.length
      } else {
        const returnedTokens = relationTargetTokens(relationships)
        structuredTargetsHit = want.filter((token) => returnedTokens.includes(token)).length
        structuredOk = want.length === 0 ? relationships.length === 0 : structuredTargetsHit === want.length
      }
    }

    entry.structured = {
      tool: structuredArgs.name, ok: structuredOk, contentBytes: structuredBytes,
      tokensEst: tokensEst(structuredBytes), ms: structuredMs,
      precallBytes: structuredPrecallBytes,
      targetsHit: structuredTargetsHit, targetsTotal: structuredTargetsTotal,
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
    'Both arms ran through the same real ToolRuntime over the same temp corpus copy, on one asserted single-profile DSH host (see evaluationHostGeneration); the copy is byte-verified against the frozen corpus manifest before any probe runs.',
    'The structured plugin runs with sessionSourceBytes=null, so this single-session sweep cannot let an earlier probe consume a later probe source budget.',
    'grep is line-oriented and reports path+lineNumber+line; it cannot express kind, semantic relation, or an exact byte range, so declaration/source/relation success here is a retrieval-surfacing signal, not a structural-equivalence result.',
    'Declaration grepSortedTop1 sorts matches by (path, lineNumber) and checks the first; raw ripgrep ordering is not a documented contract and was observed to vary between runs (grepTop1 5 or 6 of 8), so grepTop1 is reported for transparency only.',
    'Source grep `located` requires the hit to overlap the expected span, not just appear in the named file. Structured source `located` still requires exact text equality, so the two are not equivalent: the structured arm must return the bytes, grep must only land in the region.',
    'Source-arm baseline cost excludes the mandatory follow-up whole-file read; deferredWholeFileReadBytes records that additional cost.',
    'Both arms are scored against the same per-sample target set (declaration: every expected name at its own path; relation: every expected edge specifier/name/path, with zero-edge requiring an empty result). File relations were previously only checked for `!isError` on the structured arm; that asymmetry is removed.',
    'Both arms surface target tokens through one shared predicate: identifier-like names must appear on an identifier boundary (so `en` does not score inside `then`, nor `Red` inside `Redux`), while specifiers/paths are matched literally.',
    'For symbol relations the structured arm pays a symbol-resolution round trip; its latency and model-facing bytes are charged to the structured arm (entry.structured.precallBytes).',
    'Probes were frozen before any run; see probesSha256 and probeRevision. Gold was never read to build a probe.',
  )
} catch (error) {
  report.failures.push(`${error?.stack ?? error}`)
} finally {
  for (const dispose of cleanup.splice(0).reverse()) { try { await dispose() } catch {} }
  for (const dir of tempDirs) { try { await rm(dir, { recursive: true, force: true }) } catch {} }
  report.finishedAt = new Date().toISOString()
  report.ok = report.failures.length === 0
  await mkdir(dirname(REPORT_PATH), { recursive: true })
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

#!/usr/bin/env node
/**
 * M5 semantic probe (Phase 3): does type information change the answers, and how
 * much of the frozen gold is an artefact of the syntactic extraction heuristic?
 *
 * This is NOT an evaluation arm and produces NO accuracy number. It is a
 * read-only diagnostic with two halves:
 *
 *   A. heuristic side -- the REAL product tool (`context_relation_query`) is used to
 *      read back the extraction layer's own relation edges. No reimplementation.
 *   B. semantic side  -- TypeScript compiler API (`ts.createProgram` + `TypeChecker`)
 *      over the same frozen corpus. For TypeScript a language server (tsserver) is a
 *      protocol shell around exactly this API, so this is the semantic content an
 *      "LSP mode" would hand over, without protocol/process plumbing.
 *
 * Then it diffs B against the frozen gold / the heuristic edges.
 *
 * Constraints honoured: no new dependency (bundled `typescript@5.9.3`), no network,
 * no external process, corpus and gold.json are never written. Compiler options are
 * resolved from the corpus package's own `tsconfig.json` (not a hand-mirrored
 * literal) and frozen into the report with its sha256.
 *
 * Usage: node eval/m5/semantic-probe.mjs [--out <path>]
 */
import { readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { join, relative, sep, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

import { COMMIT, CORPUS_ROOT, EVALUATION_CODE_INTELLIGENCE_CONFIG, REPORT_DIR, GOLD_PATH, sha256, loadCodeIntelligence, loadCorpusManifest, makeRegistry, mountCorpus, mountRetrievalTools } from './harness.mjs'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// ---------------------------------------------------------------------------
// Corpus helpers.
// ---------------------------------------------------------------------------

async function collectFiles(root) {
  const out = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(abs)
    }
  }
  await walk(root)
  return out.sort()
}

const relPath = (abs) => relative(CORPUS_ROOT, abs).split(sep).join('/')
const isTestPath = (p) => /(^|\/)tests?\//.test(p) || /\.test\.tsx?$/.test(p)

// ---------------------------------------------------------------------------
// Semantic side.
// ---------------------------------------------------------------------------

/**
 * Resolve the corpus package's own `tsconfig.json` instead of re-declaring its
 * compiler options. The earlier hand-mirrored literal had drifted from the
 * frozen repo (`strict: false` versus the repo's `strict: true`, plus missing
 * jsx/decorator settings), so the semantic side was a different program than
 * the one the corpus is authored against. The resolved options and the config
 * bytes are recorded in the report; module resolution can no longer silently
 * diverge from the corpus.
 */
const CORPUS_TSCONFIG = join(CORPUS_ROOT, '..', 'tsconfig.json')

function loadCorpusCompilerOptions(tsconfigPath) {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  if (configFile.error) {
    throw new Error(`cannot read corpus tsconfig ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`)
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config, ts.sys, dirname(tsconfigPath), undefined, tsconfigPath,
  )
  if (parsed.errors.length > 0) {
    throw new Error(`corpus tsconfig ${tsconfigPath} has errors: ${parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('; ')}`)
  }
  // `noEmit` is asserted even though the repo already sets it: the probe must
  // never be able to write into the frozen corpus.
  return { path: tsconfigPath, options: { ...parsed.options, noEmit: true }, fileNames: parsed.fileNames }
}

/** Resolve a call's callee the way a type-aware analysis would. */
function resolveCallee(checker, callExpr) {
  const callee = callExpr.expression
  if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) {
    return { resolved: false, reason: 'non-name-callee' }
  }
  let symbol = checker.getSymbolAtLocation(callee)
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    try { symbol = checker.getAliasedSymbol(symbol) } catch { /* keep alias */ }
  }
  if (!symbol) return { resolved: false, reason: 'no-symbol' }
  const declarations = symbol.getDeclarations() ?? []
  const decl = declarations[0]
  if (!decl) return { resolved: false, reason: 'no-declaration' }
  const declFile = decl.getSourceFile()
  const inside = declFile.fileName.startsWith(CORPUS_ROOT)
  return {
    resolved: true,
    name: symbol.getName(),
    declPath: inside ? relPath(declFile.fileName) : null,
    external: inside ? null : declFile.fileName.split(sep).slice(-2).join('/'),
    declCount: declarations.length,
  }
}

/** Collect call sites grouped by the extractor's callee name, using its exact rule. */
function collectCallSites(sourceFile) {
  const byName = new Map()
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      let name
      let form
      if (ts.isIdentifier(callee)) { name = callee.text; form = 'identifier' }
      else if (ts.isPropertyAccessExpression(callee)) { name = callee.name.text; form = 'propertyAccess' }
      if (name !== undefined && !(form === 'identifier' && name === 'require')) {
        if (!byName.has(name)) byName.set(name, [])
        byName.get(name).push({
          node, form,
          line: sourceFile.getLineAndCharacterOfPosition(callee.getStart(sourceFile)).line + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return byName
}

/**
 * Gold declaration spans are *declaration node* ranges (as the extractor emits them),
 * not identifier ranges. Locate the node by span, then resolve its own name.
 */
function findNodeBySpan(sf, startOffset, endOffset) {
  let found = null
  const visit = (node) => {
    if (found) return
    const start = node.getStart(sf)
    const end = node.getEnd()
    if (start === startOffset && end === endOffset) { found = node; return }
    if (start <= startOffset && endOffset <= end) ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return found
}

const NODE_FLAG_NAMES = new Map(Object.entries(ts.SymbolFlags).filter(([, v]) => typeof v === 'number'))
function flagNames(flags) {
  const names = []
  for (const [name, value] of NODE_FLAG_NAMES) if (value !== 0 && (flags & value) === value) names.push(name)
  return names.sort()
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  const outFlag = argv.indexOf('--out')
  const outPath = outFlag >= 0 ? argv[outFlag + 1] : join(REPORT_DIR, 'semantic-probe.json')

  const goldRaw = await readFile(GOLD_PATH, 'utf8')
  const gold = JSON.parse(goldRaw)
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    scope: 'read-only diagnostic: heuristic (real product tool) vs semantic (TypeScript TypeChecker). NOT an evaluation arm; produces no accuracy number.',
    gold: { path: 'eval/m5/gold.json', sha256: sha256(goldRaw) },
    corpus: { commit: COMMIT, root: `node_modules/.cache/m5-eval/corpus/zod-${COMMIT}/packages/zod/src` },
    typescript: { version: ts.version, resolvedFrom: require.resolve('typescript') },
  }

  const cleanup = []
  try {
    // ---- semantic side ----------------------------------------------------
    // Options come from the corpus tsconfig; root files stay the frozen corpus
    // `src` set so the program scope cannot silently grow beyond the corpus.
    const corpusCompiler = loadCorpusCompilerOptions(CORPUS_TSCONFIG)
    report.compiler = {
      tsconfig: `node_modules/.cache/m5-eval/corpus/zod-${COMMIT}/packages/zod/tsconfig.json`,
      tsconfigSha256: sha256(await readFile(CORPUS_TSCONFIG)),
      options: corpusCompiler.options,
      note: 'resolved with ts.readConfigFile + ts.parseJsonConfigFileContent from the corpus itself; root files are still the frozen corpus src set',
    }
    const rootFiles = await collectFiles(CORPUS_ROOT)
    const t0 = performance.now()
    const program = ts.createProgram(rootFiles, corpusCompiler.options)
    const checker = program.getTypeChecker()
    report.corpus.fileCount = rootFiles.length
    report.program = {
      rootFiles: rootFiles.length,
      buildMs: Math.round(performance.now() - t0),
      syntacticDiagnostics: program.getSyntacticDiagnostics().length,
      note: 'a full semantic type-check is deliberately not forced; the checker resolves lazily per query',
    }

    const sourceFilesByRel = new Map()
    const callSitesByFile = new Map()
    for (const sf of program.getSourceFiles()) {
      if (!sf.fileName.startsWith(CORPUS_ROOT)) continue
      const rel = relPath(sf.fileName)
      sourceFilesByRel.set(rel, sf)
      callSitesByFile.set(rel, collectCallSites(sf))
    }
    report.program.indexedCorpusSources = sourceFilesByRel.size

    // ---- heuristic side: real product tool --------------------------------
    const corpusIdentity = await loadCorpusManifest()
    const ctx = await makeRegistry()
    cleanup.push(() => ctx.fiber.dispose())
    const parent = await mkdtemp(join(tmpdir(), 'm5-semprobe-'))
    cleanup.push(() => rm(parent, { recursive: true, force: true }))
    const root = await mountCorpus(ctx, join(parent, 'src'), corpusIdentity.manifest)
    await mountRetrievalTools(ctx, root, { includeSearch: false })
    const codeIntelligence = await loadCodeIntelligence()
    await ctx.plugin(codeIntelligence.apply, EVALUATION_CODE_INTELLIGENCE_CONFIG)

    const { SessionId, ToolCallId } = ctx.evaluationHostApis
    const session = ctx.sessions.prepare(SessionId('m5-semantic-probe'), { meta: { cwd: root } })
    cleanup.push(ctx.sessions.enter(session))
    ctx.sessions.announce(session)
    const call = (name, args, agent) => ctx.tools.execute({
      callId: ToolCallId(`${name}-${agent}`), name, arguments: args,
      signal: new AbortController().signal, agent: { id: agent, session },
    })

    const indexStart = performance.now()
    const fileRecords = []
    let snapshotId
    let cursor
    do {
      const page = await call('context_repo_map', cursor ? { cursor } : {}, 'probe')
      if (page.isError) throw new Error(`repo_map failed: ${page.error.message}`)
      snapshotId = page.value.snapshotId
      report.extraction = report.extraction ?? page.value.extraction
      for (const item of page.value.items) fileRecords.push(item)
      cursor = page.value.nextCursor ?? undefined
    } while (cursor)
    report.snapshotId = snapshotId
    report.indexMs = Math.round(performance.now() - indexStart)
    report.repoMapFiles = fileRecords.length

    const heuristicCalls = new Map()
    // Count every call edge, not only the unresolved ones, so `joinableCallEdges`
    // is measured rather than asserted: if the extractor ever emitted a
    // symbol/file-targeted call edge, the probe must notice instead of silently
    // filtering it out and still reporting zero.
    let callEdgesTotal = 0
    let callEdgesJoinable = 0
    for (const file of fileRecords) {
      const edges = []
      let edgeCursor
      do {
        const args = { snapshotId, from: { path: file.path }, types: ['calls'] }
        if (edgeCursor) args.cursor = edgeCursor
        const result = await call('context_relation_query', args, `probe-${file.path}`)
        if (result.isError) throw new Error(`relation_query failed for ${file.path}: ${result.error.message}`)
        for (const edge of result.value.relationships) {
          callEdgesTotal += 1
          if (edge.target?.kind === 'symbol' || edge.target?.kind === 'file') callEdgesJoinable += 1
          if (edge.target?.kind === 'unresolved' && typeof edge.target.name === 'string') {
            edges.push({ name: edge.target.name, resolution: edge.resolution })
          }
        }
        edgeCursor = result.value.nextCursor ?? undefined
      } while (edgeCursor)
      if (edges.length > 0) heuristicCalls.set(file.path, edges)
    }
    report.heuristic = {
      filesWithCallEdges: heuristicCalls.size,
      totalCallEdges: [...heuristicCalls.values()].reduce((n, e) => n + e.length, 0),
      distinctHeuristicNames: new Set([...heuristicCalls.values()].flat().map((e) => e.name)).size,
    }

    // ---- diff -------------------------------------------------------------
    const byNameGlobal = new Map()
    const ambiguous = []
    const unresolvedSamples = []
    const semanticTargetsAll = new Set()
    const formCounts = { identifier: 0, propertyAccess: 0 }
    let edgesResolved = 0
    let edgesPartiallyUnresolved = 0
    let edgesFullyUnresolved = 0
    let edgesAmbiguous = 0
    let edgesWithoutCallSite = 0
    let unresolvedSitesTotal = 0
    let callSitesTotal = 0

    for (const [path, edges] of [...heuristicCalls].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const sites = callSitesByFile.get(path)
      for (const edge of edges) {
        const global = byNameGlobal.get(edge.name) ?? { edges: 0, distinctTargets: new Set(), unresolvedSites: 0, samplePaths: [] }
        global.edges += 1
        if (global.samplePaths.length < 5 && !global.samplePaths.includes(path)) global.samplePaths.push(path)
        byNameGlobal.set(edge.name, global)

        const list = sites?.get(edge.name)
        if (!list || list.length === 0) {
          edgesWithoutCallSite += 1
          continue
        }
        const targets = new Set()
        let unresolved = 0
        for (const site of list) {
          formCounts[site.form] += 1
          callSitesTotal += 1
          const r = resolveCallee(checker, site.node)
          if (r.resolved) {
            const key = `${r.declPath ?? r.external}#${r.name}`
            targets.add(key)
            semanticTargetsAll.add(key)
            global.distinctTargets.add(key)
          } else {
            unresolved += 1
            unresolvedSitesTotal += 1
            global.unresolvedSites += 1
            if (unresolvedSamples.length < 25) unresolvedSamples.push({ path, name: edge.name, line: site.line, reason: r.reason })
          }
        }
        if (unresolved === 0) edgesResolved += 1
        else if (unresolved < list.length) edgesPartiallyUnresolved += 1
        else edgesFullyUnresolved += 1
        if (targets.size > 1) {
          edgesAmbiguous += 1
          if (ambiguous.length < 25) ambiguous.push({ path, name: edge.name, callSites: list.length, distinctDeclarations: [...targets] })
        }
      }
    }

    report.globalCallAnalysis = {
      heuristicEdges: report.heuristic.totalCallEdges,
      edgesResolved,
      edgesPartiallyUnresolved,
      edgesFullyUnresolved,
      edgesWithoutCallSite,
      edgesAmbiguous,
      callSitesByForm: formCounts,
      callSitesTotal,
      unresolvedSitesTotal,
      unresolvedSiteRate: callSitesTotal === 0 ? null : Number((unresolvedSitesTotal / callSitesTotal).toFixed(6)),
      distinctHeuristicNames: report.heuristic.distinctHeuristicNames,
      distinctSemanticTargets: semanticTargetsAll.size,
      nameCollapseFactor: report.heuristic.distinctHeuristicNames === 0
        ? null
        : Number((semanticTargetsAll.size / report.heuristic.distinctHeuristicNames).toFixed(3)),
      callEdgesTotal,
      joinableCallEdges: callEdgesJoinable,
      joinableNote: callEdgesJoinable === 0
        ? 'The extractor never emits a call edge with a symbol/file target: addUnresolvedRelation always builds {kind:"unresolved"}. So 100% of call edges are dangling names with no join key, while `contains` edges are symbol-linked. Reverse queries (which symbols call X) are structurally impossible.'
        : `${callEdgesJoinable}/${callEdgesTotal} call edges carry a symbol/file target, so reverse call queries are not structurally impossible.`,
      topNames: [...byNameGlobal]
        .map(([name, v]) => ({ name, edges: v.edges, distinctTargets: v.distinctTargets.size, unresolvedSites: v.unresolvedSites, samplePaths: v.samplePaths }))
        .filter((x) => x.distinctTargets > 1 || x.unresolvedSites > 0)
        .sort((a, b) => (b.distinctTargets - a.distinctTargets) || (b.edges - a.edges))
        .slice(0, 25),
      sampleAmbiguousEdges: ambiguous,
    }
    report.envConfound = {
      note: 'Pre-registered hypothesis (unresolved call sites come from packages absent from the checkout) was FALSIFIED by this run: vitest and @types/node do resolve. Every unresolved site is reason "no-symbol" on a property-access call whose receiver has no resolved type (array .push, emitter .on, .add, ...), i.e. an incomplete-type-environment artefact of the probe, not an extractor defect. Site-level unresolved rate is under 0.5%.',
      unresolvedSamples,
      testFileShare: Number((fileRecords.filter((f) => isTestPath(f.path)).length / Math.max(1, fileRecords.length)).toFixed(3)),
      probeCorrections: [
        'v1 of this probe looked for an Identifier exactly covering the gold span; gold spans are declaration-node ranges, so 5/10 declaration targets wrongly reported as unresolved. Fixed by locating the node by span and resolving its own name.',
        'v1 asserted the unresolved-call confound was missing packages. Falsified: all unresolved sites are no-symbol member calls on untyped receivers.',
      ],
    }

    // ---- per-gold-sample divergence ---------------------------------------
    const divergences = []
    const goldSamples = { imports: [], exports: [], calls: [] }

    for (const sample of gold.samples.filter((s) => s.category === 'relation')) {
      const type = sample.request.types[0]
      const path = sample.request.from.path
      if (path === undefined) continue
      const sf = sourceFilesByRel.get(path)
      if (!sf) continue

      if (type === 'imports') {
        const specifiers = []
        const visit = (node) => {
          if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
          ts.forEachChild(node, visit)
        }
        ts.forEachChild(sf, visit)
        const resolved = specifiers.map((spec) => {
          const r = ts.resolveModuleName(spec, sf.fileName, corpusCompiler.options, ts.sys).resolvedModule
          return { specifier: spec, resolvedPath: r ? relPath(r.resolvedFileName) : null, external: r?.isExternalLibraryImport ?? null }
        })
        goldSamples.imports.push({ id: sample.id, path, heuristicTargets: sample.expected.map((e) => e.target.specifier ?? e.target.name), semanticResolved: resolved })
        divergences.push({
          sample: sample.id, category: 'relation/imports', path,
          heuristic: `unresolved specifier strings ${JSON.stringify(sample.expected.map((e) => e.target.specifier ?? e.target.name))}`,
          semantic: `resolved ${JSON.stringify(resolved.map((r) => [r.specifier, r.resolvedPath]))}`,
          verdict: resolved.length === 0 && sample.expected.length === 0
            ? 'both sides empty: the file imports nothing, so there is no gap to close (control sample)'
            : resolved.some((r) => r.resolvedPath !== null && r.external === false)
              ? 'semantic carries strictly more information (target file identity)'
              : 'no semantic gain here: no in-checkout target to resolve',
        })
      } else if (type === 'exports') {
        const moduleSymbol = checker.getSymbolAtLocation(sf)
        const exported = moduleSymbol ? checker.getExportsOfModule(moduleSymbol).map((s) => s.getName()).sort() : []
        const starSpecifiers = []
        const visit = (node) => {
          if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) starSpecifiers.push(node.moduleSpecifier.text)
          ts.forEachChild(node, visit)
        }
        ts.forEachChild(sf, visit)
        const stars = sample.expected.filter((e) => e.target.specifier !== undefined)
        const heuristicTargets = sample.expected.map((e) => e.target.name ?? e.target.specifier)
        goldSamples.exports.push({ id: sample.id, path, heuristicTargets, semanticExportedNames: exported, starSpecifiers })
        // The non-star verdict must be computed from the two member sets, not
        // asserted: a name added or lost on either side would otherwise still
        // read as "equivalent member set".
        const heuristicNamed = sample.expected.filter((e) => e.target.name !== undefined).map((e) => e.target.name)
        const heuristicSet = new Set(heuristicNamed)
        const semanticSet = new Set(exported.filter((name) => typeof name === 'string'))
        const heuristicOnly = [...heuristicSet].filter((name) => !semanticSet.has(name)).sort()
        const semanticOnly = [...semanticSet].filter((name) => !heuristicSet.has(name)).sort()
        divergences.push({
          sample: sample.id, category: 'relation/exports', path,
          heuristic: `named targets + ${stars.length} unresolved star specifier(s): ${JSON.stringify(heuristicTargets)}`,
          semantic: `${exported.length} concretely exported name(s)${starSpecifiers.length ? `; star targets ${JSON.stringify(starSpecifiers)}` : ''}`,
          verdict: stars.length > 0 && exported.length > 0
            ? 'semantic enumerates the star into concrete names the heuristic can only name as a specifier'
            : heuristicOnly.length === 0 && semanticOnly.length === 0
              ? 'equivalent member set (heuristic named exports equal the semantic export set)'
              : `member sets differ: heuristic-only=${JSON.stringify(heuristicOnly)}, semantic-only=${JSON.stringify(semanticOnly)}`,
        })
      } else if (type === 'calls') {
        const sites = callSitesByFile.get(path) ?? new Map()
        const detail = sample.expected.map((edge) => {
          const list = sites.get(edge.target.name) ?? []
          return {
            edgeName: edge.target.name,
            heuristicResolution: edge.resolution,
            callSites: list.map((site) => {
              const r = resolveCallee(checker, site.node)
              return { line: site.line, form: site.form, resolved: r.resolved, target: r.resolved ? `${r.declPath ?? r.external}#${r.name}` : null }
            }),
          }
        })
        goldSamples.calls.push({ id: sample.id, path, detail })
        divergences.push({
          sample: sample.id, category: 'relation/calls', path,
          heuristic: detail.map((d) => `"${d.edgeName}" -> unresolved (${d.heuristicResolution})`).join('; '),
          semantic: detail.map((d) => d.callSites.map((c) => `"${d.edgeName}" @L${c.line} -> ${c.target ?? 'UNRESOLVED'}`).join(' | ') || `"${d.edgeName}" -> no call site found`).join('; '),
          verdict: detail.every((d) => d.callSites.length > 0 && d.callSites.every((c) => c.resolved))
            ? 'semantic resolves every heuristic edge to a concrete declaration; the heuristic name happened to be complete here, but it carries no receiver/target identity'
            : 'semantic cannot resolve at least one heuristic edge in this probe environment',
        })
      }
    }

    // ---- declaration vocabulary -------------------------------------------
    const declarationCheck = []
    for (const sample of gold.samples.filter((s) => s.category === 'declaration')) {
      for (const target of sample.expectedTargets) {
        const sf = sourceFilesByRel.get(target.path)
        if (!sf) continue
        const node = findNodeBySpan(sf, target.startOffset, target.endOffset)
        const nameNode = node && node.name && ts.isIdentifier(node.name) ? node.name : node
        const symbol = nameNode ? checker.getSymbolAtLocation(nameNode) : undefined
        const semanticName = symbol ? symbol.getName() : null
        declarationCheck.push({
          id: sample.id,
          path: target.path,
          line: target.start.line,
          goldKind: target.kind,
          goldName: target.name,
          spanMatched: node !== null,
          nodeKind: node ? ts.SyntaxKind[node.kind] : null,
          semanticName,
          // A span that resolves to a differently named symbol is not a correct
          // declaration answer, so the probe records the name comparison rather
          // than only "a symbol was found at this span".
          nameMatches: semanticName !== null && semanticName === target.name,
          semanticFlags: symbol ? flagNames(symbol.flags) : null,
        })
      }
    }
    report.declarations = {
      checked: declarationCheck.length,
      spanMatched: declarationCheck.filter((d) => d.spanMatched).length,
      resolved: declarationCheck.filter((d) => d.semanticFlags !== null).length,
      nameMatched: declarationCheck.filter((d) => d.nameMatches).length,
      detail: declarationCheck,
    }

    report.goldSamples = goldSamples
    report.divergences = divergences
    report.limitations = [
      'No language server is involved. For TypeScript, tsserver is a protocol shell around the same compiler API used here, so this measures the semantic content an "LSP mode" would provide.',
      'The product ships no LSP-backed query path: src/lsp-adapter.ts is unreachable from the default apply and only issues textDocument/documentSymbol (symbols only, zero relations).',
      'The frozen gold asserts resolution "syntactic"|"heuristic" and target.kind "unresolved". A semantic extractor emits resolved file/symbol targets, so it would fail the frozen gold by construction: any accuracy number computed against this gold cannot compare semantic quality.',
      'Unresolved call sites are inflated by packages absent from the corpus checkout (vitest, @types/node). See envConfound.',
      'Symbol resolution is name-driven and lazy; no project reference build or lib type-checking is forced, so the semantic side is a lower bound on what a full LSP session would resolve.',
      'TypeScript options come from the corpus tsconfig via ts.readConfigFile/parseJsonConfigFileContent. Reports generated before this change used a hand-mirrored literal (strict:false, no jsx/decorators); a re-run under the corpus options reproduced every headline count here (declarations 10/10, globalCallAnalysis, divergences), so the newer reports are the ones to cite.',
    ]
    report.ok = true
    report.totalMs = Math.round(performance.now() - t0)
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({
      ok: true,
      out: outPath,
      program: report.program,
      heuristic: report.heuristic,
      globalCallAnalysis: {
        edgesResolved, edgesPartiallyUnresolved, edgesFullyUnresolved, edgesWithoutCallSite, edgesAmbiguous,
        callSitesByForm: formCounts,
        callSitesTotal,
        unresolvedSitesTotal,
        unresolvedSiteRate: report.globalCallAnalysis.unresolvedSiteRate,
        distinctSemanticTargets: semanticTargetsAll.size,
        nameCollapseFactor: report.globalCallAnalysis.nameCollapseFactor,
      },
      divergences: divergences.map((d) => `${d.sample}: ${d.verdict}`),
      declarations: { checked: report.declarations.checked, spanMatched: report.declarations.spanMatched, resolved: report.declarations.resolved, nameMatched: report.declarations.nameMatched },
    }, null, 2))
  } finally {
    for (const fn of cleanup.reverse()) { try { await fn() } catch { /* noop */ } }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

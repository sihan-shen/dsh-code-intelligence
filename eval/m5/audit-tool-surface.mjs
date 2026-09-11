#!/usr/bin/env node
/**
 * Tool-surface audit for the Phase 2 arms.
 *
 * Answers three questions with evidence instead of prose:
 *   1. What does each arm ACTUALLY expose to the model? (mount the real plugins
 *      and read `ctx.tools.schemas()` back, rather than trusting the label.)
 *   2. Does the product prescribe a preference for the `context_*` tools? (Any
 *      prompt/priority directive would show up as a systemPrompt section or in a
 *      tool description; this script prints both.)
 *   3. How large is the model-facing prompt surface of each arm? The chat
 *      completions API re-sends every tool schema on every request, so this is a
 *      fixed token overhead that is independent of retrieval quality.
 *
 * It also records which product systemPrompt sections each arm actually
 * forwards. The harness now collects those sections instead of stubbing the
 * service, and forwards only the ones whose tool survived arm filtering; this
 * script is the independent record of that composition.
 *
 * Read-only: it mounts the corpus into a temp dir and removes it afterwards.
 * Writes `reports/tool-surface.json`.
 *
 *   node eval/m5/audit-tool-surface.mjs
 *   node eval/m5/audit-tool-surface.mjs --json   # machine-readable, stdout only
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMMIT,
  DSH_PROFILE_MODULES,
  REPORT_DIR,
  forwardedPromptSections,
  loadFsSearch,
  makeRegistry,
  mountCorpus,
  mountRetrievalTools,
  sha256,
  systemPromptForTools,
} from './lib/harness.mjs'

const AS_JSON = process.argv.includes('--json')
const OUT_PATH = join(REPORT_DIR, 'tool-surface.json')

// Mirrors agent-baseline.mjs so the audit reports the same surface the runs saw.
const ARMS = {
  default: { search: true, structured: false },
  additive: { search: true, structured: true },
  replacement: { search: false, structured: true },
}
// Must match agent-baseline.mjs: the arm-neutral preamble, no tool categories.
const SYSTEM_PREAMBLE = [
  'You are a precise code-retrieval assistant working inside a repository.',
  'You have tools for inspecting the repository; use them as you see fit.',
  'Base every answer on evidence you actually retrieved, never on a guess.',
  'When you are done, reply with ONLY the JSON object the user asked for, with no prose and no code fence.',
].join(' ')

const excluded = (n) => n === 'write' || n === 'edit'
const surfaceOf = (schema) => (schema.description ?? '').length + JSON.stringify(schema.parameters ?? {}).length

// The shipped plugin bundles carry these literals. Comparing the *collected*
// section text against them proves the harness forwards real product text
// rather than a paraphrase, and that the literals have not rotted.
const EXPECTED_SECTIONS = [
  { pkg: 'dsh-tool-fs', name: 'tool:read', order: 100, text: 'Use the read tool \u2014 not shell commands like cat \u2014 to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.' },
  { pkg: 'dsh-tool-fs', name: 'tool:write', order: 101, text: 'Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes.' },
  { pkg: 'dsh-tool-fs', name: 'tool:edit', order: 102, text: 'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.' },
  { pkg: 'dsh-tool-fs-search', name: 'tool:glob', order: 103, text: 'Use the glob tool \u2014 not shell find \u2014 to discover files by path pattern.' },
  { pkg: 'dsh-tool-fs-search', name: 'tool:grep', order: 104, text: 'Use the grep tool \u2014 not shell grep or rg \u2014 to search file contents. Use read on a matched file when you need surrounding context.' },
]

const report = {
  schemaVersion: 1,
  kind: 'm5-phase2-tool-surface-audit',
  generatedAt: new Date().toISOString(),
  commit: COMMIT,
  systemPromptPreambleChars: SYSTEM_PREAMBLE.length,
  expectedSections: [],
  arms: {},
  findings: {},
}

let registeredOnce = null
for (const [arm, spec] of Object.entries(ARMS)) {
  const ctx = await makeRegistry()
  const parent = await mkdtemp(join(tmpdir(), `m5-audit-${arm}-`))
  const root = await mountCorpus(ctx, join(parent, 'src'))
  const { module: fsSearch } = await loadFsSearch()
  const { provenance, promptSections } = await mountRetrievalTools(ctx, root, { includeSearch: spec.search, fsSearch })
  if (spec.structured) {
    const codeIntel = await import('../../lib/index.js')
    await ctx.plugin(codeIntel.apply, { deploymentRoot: '.', revision: COMMIT })
  }
  const schemas = ctx.tools.schemas()
  const allowed = schemas
    .filter((s) => !excluded(s.name))
    .filter((s) => !s.name.startsWith('context_') || spec.structured)
  const structuredSurface = allowed.filter((s) => s.name.startsWith('context_')).reduce((a, s) => a + surfaceOf(s), 0)
  const searchSurface = allowed.filter((s) => !s.name.startsWith('context_')).reduce((a, s) => a + surfaceOf(s), 0)
  const forwarded = forwardedPromptSections(promptSections, allowed.map((s) => s.name))
  const systemPrompt = systemPromptForTools(SYSTEM_PREAMBLE, promptSections, allowed.map((s) => s.name))
  if (!registeredOnce) registeredOnce = promptSections.map((s) => ({ name: s.name, order: s.order, chars: s.text.length }))
  report.arms[arm] = {
    provenance,
    exposedTools: allowed.map((s) => s.name).sort(),
    structuredSurfaceChars: structuredSurface,
    searchSurfaceChars: searchSurface,
    totalSurfaceChars: structuredSurface + searchSurface,
    structuredShare: Number((structuredSurface / (structuredSurface + searchSurface)).toFixed(4)),
    perTool: Object.fromEntries(allowed.map((s) => [s.name, { descriptionChars: (s.description ?? '').length, parametersChars: JSON.stringify(s.parameters ?? {}).length }])),
    promptSectionsRegistered: promptSections.map((s) => ({ name: s.name, order: s.order })),
    promptSectionsForwarded: forwarded.map((s) => ({ name: s.name, order: s.order })),
    systemPromptChars: systemPrompt.length,
    systemPrompt,
  }
  await rm(parent, { recursive: true, force: true })
}

report.registeredPromptSections = registeredOnce
for (const entry of EXPECTED_SECTIONS) {
  const source = await readFile(join(DSH_PROFILE_MODULES, entry.pkg, 'lib/index.js'), 'utf8')
  const collected = report.arms.default.promptSectionsRegistered.some((s) => s.name === entry.name && s.order === entry.order)
  report.expectedSections.push({ ...entry, presentInShippedBundle: source.includes(entry.text), collectedByHarness: collected })
}

// Which arm forward-which section, as a single auditable string.
report.findings.forwardedMatrix = Object.fromEntries(
  Object.entries(report.arms).map(([arm, d]) => [arm, d.promptSectionsForwarded.map((s) => s.name).join(',') || '(none)']),
)
report.findings.sectionsAreVerbatim = report.expectedSections
  .filter((s) => report.arms.default.promptSectionsForwarded.some((f) => f.name === s.name))
  .every((s) => report.arms.default.systemPrompt.includes(s.text))
report.findings.pluginInjectsOwnPrompt = Object.keys(report.arms.additive.perTool).filter((n) => n.startsWith('context_')).length > 0
  && report.arms.default.promptSectionsForwarded.every((s) => !s.name.startsWith('context:'))

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const [arm, data] of Object.entries(report.arms)) {
    console.log(`\n== ${arm} ==`)
    console.log(`   tools              : ${data.exposedTools.join(', ')}`)
    console.log(`   search surface     : ${data.searchSurfaceChars} chars`)
    console.log(`   structured surface : ${data.structuredSurfaceChars} chars`)
    console.log(`   structured share   : ${(data.structuredShare * 100).toFixed(1)}%`)
    console.log(`   prompt forwarded   : ${data.promptSectionsForwarded.map((s) => s.name).join(', ') || '(none)'}  (${data.systemPromptChars} chars total)`)
    for (const [n, v] of Object.entries(data.perTool)) console.log(`     ${n.padEnd(28)} desc=${String(v.descriptionChars).padStart(4)} params=${String(v.parametersChars).padStart(4)}`)
  }
  console.log('\n== product systemPrompt sections (collected and forwarded, not stubbed) ==')
  for (const sec of report.expectedSections) {
    console.log(`   ${sec.name.padEnd(12)} order=${sec.order} inShippedBundle=${sec.presentInShippedBundle} collected=${sec.collectedByHarness}`)
    console.log(`     "${sec.text.slice(0, 96)}${sec.text.length > 96 ? '\u2026' : ''}"`)
  }
  console.log(`\nforwarded per arm: ${JSON.stringify(report.findings.forwardedMatrix)}`)
  console.log(`sections verbatim in the composed prompt: ${report.findings.sectionsAreVerbatim}`)
}

await mkdir(REPORT_DIR, { recursive: true })
const { writeFile } = await import('node:fs/promises')
await writeFile(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`)
if (!AS_JSON) console.log(`report: ${OUT_PATH}`)

// M5 Phase 2 — agent comparison: real DSH default retrieval vs `context_*`.
//
// Three arms run over the same frozen corpus, the same frozen task set
// (`agent-tasks.json`), the same ToolRuntime, and the same model settings:
//
//   default      `read` + `grep` + `glob`                     (shipped DSH default)
//   additive     `read` + `grep` + `glob` + `context_*`       (default + structured)
//   replacement  `read` + `context_*`                         (structured replaces search)
//
// The model is the user's own DeepSeek official endpoint. Only `read`/`grep`/
// `glob`/`context_*` are exposed; `dsh-base` also ships bash/subagent/web/
// workflow tools, which are excluded because they widen the action space far
// beyond retrieval and would swamp any retrieval difference.
//
// Nothing here writes gold or the corpus. The task set is frozen and hashed
// before any arm runs; see `agent-tasks.json`.
//
// Env: DEEPSEEK_API_KEY (required), DEEPSEEK_BASE_URL (default https://api.deepseek.com),
//      M5_AGENT_MODEL (default deepseek-chat), M5_REPEATS (default 1),
//      M5_MAX_MODEL_CALLS (default from the task set).
//
// Usage:
//   node eval/m5/agent-baseline.mjs --dry-run          # no model calls; prints arms
//   node eval/m5/agent-baseline.mjs --arm default --task decl-02-function-unique
//   node eval/m5/agent-baseline.mjs --repeats 3

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMMIT,
  GOLD_PATH,
  REPORT_DIR,
  SessionId,
  contentBytes,
  contentText,
  loadFsSearch,
  makeCaller,
  makeRegistry,
  mountCorpus,
  mountRetrievalTools,
  resolveApiKey,
  sha256,
  forwardedPromptSections,
  systemPromptForTools,
} from './lib/harness.mjs'

const TASKS_PATH = fileURLToPath(new URL('./agent-tasks.json', import.meta.url))
const REPORT_PATH = join(REPORT_DIR, 'agent-comparison.json')
const STRUCTURED_PREFIX = 'context_'

const argv = process.argv.slice(2)
const argValue = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const hasFlag = (name) => argv.includes(`--${name}`)

const DRY_RUN = hasFlag('dry-run')
const REQUESTED_ARM = argValue('arm', null)
const REQUESTED_TASK = argValue('task', null)
const REPEATS = Number(argValue('repeats', process.env.M5_REPEATS ?? '1'))
const OUT_PATH = argValue('out', null) ?? REPORT_PATH

const MODEL = process.env.M5_AGENT_MODEL ?? 'deepseek-chat'
const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')

const { key: API_KEY, source: API_KEY_SOURCE } = await resolveApiKey()

// Arm-neutral preamble. It deliberately names no tool and no tool category, and
// makes no claim about which retrieval method is better: the v1 preamble said
// "if a tool can give you the exact text, line range, or relation, get it",
// which described the structured tools' strengths and quietly favoured them.
const SYSTEM_PREAMBLE = [
  'You are a precise code-retrieval assistant working inside a repository.',
  'You have tools for inspecting the repository; use them as you see fit.',
  'Base every answer on evidence you actually retrieved, never on a guess.',
  'When you are done, reply with ONLY the JSON object the user asked for, with no prose and no code fence.',
].join(' ')

const ARMS = {
  default: { label: 'default (read+grep+glob)', search: true, structured: false },
  additive: { label: 'additive (read+grep+glob+context_*)', search: true, structured: true },
  replacement: { label: 'replacement (read+context_*)', search: false, structured: true },
}

// ---------------------------------------------------------------------------
// Grading (deterministic, against the frozen answerSpec).
// ---------------------------------------------------------------------------

const normalizePath = (value) => String(value).trim().replace(/^\.\//, '').replace(/\\/g, '/')
const normalizeString = (value) => String(value).trim()
const toSortedSet = (values, map = normalizeString) => [...new Set(values.map(map))].sort()

function extractJson(text) {
  if (typeof text !== 'string') return { value: null, reason: 'empty-content' }
  const direct = text.trim()
  try { return { value: JSON.parse(direct), reason: null } } catch {}
  const fence = direct.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) { try { return { value: JSON.parse(fence[1].trim()), reason: null } } catch {} }
  const start = direct.indexOf('{')
  const end = direct.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return { value: JSON.parse(direct.slice(start, end + 1)), reason: null } } catch {}
  }
  return { value: null, reason: 'unparseable-json' }
}

function grade(spec, text) {
  const { value, reason } = extractJson(text)
  if (value === null) return { ok: false, reason }
  switch (spec.kind) {
    case 'pathSet': {
      if (!Array.isArray(value.paths)) return { ok: false, reason: 'missing paths[]' }
      const got = toSortedSet(value.paths, normalizePath)
      const want = toSortedSet(spec.paths, normalizePath)
      return { ok: JSON.stringify(got) === JSON.stringify(want), reason: 'path-set mismatch', got, want }
    }
    case 'declarationLocation': {
      const ok = normalizePath(value.path ?? '') === normalizePath(spec.path)
        && Number(value.startLine) === spec.startLine
        && Number(value.endLine) === spec.endLine
      return { ok, reason: 'declaration location mismatch', got: value, want: { path: spec.path, startLine: spec.startLine, endLine: spec.endLine } }
    }
    case 'sourceText': {
      const ok = typeof value.text === 'string' && value.text === spec.text
      return { ok, reason: 'source text mismatch', gotLength: typeof value.text === 'string' ? value.text.length : null, wantLength: spec.text.length }
    }
    case 'targetNameSet': {
      if (!Array.isArray(value.targets)) return { ok: false, reason: 'missing targets[]' }
      const got = toSortedSet(value.targets)
      const want = toSortedSet(spec.names)
      return { ok: JSON.stringify(got) === JSON.stringify(want), reason: 'name-set mismatch', got, want }
    }
    case 'targetStringSet': {
      if (!Array.isArray(value.targets)) return { ok: false, reason: 'missing targets[]' }
      const got = toSortedSet(value.targets)
      const want = toSortedSet(spec.targets)
      return { ok: JSON.stringify(got) === JSON.stringify(want), reason: 'target-set mismatch', got, want }
    }
    default:
      return { ok: false, reason: `unknown answerSpec kind ${spec.kind}` }
  }
}

// ---------------------------------------------------------------------------
// Provider client (OpenAI-compatible chat completions; tool calling).
// ---------------------------------------------------------------------------

async function chatCompletion(body, { attempt = 1 } = {}) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const retryable = response.status === 429 || response.status >= 500
    if (retryable && attempt < 4) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)))
      return chatCompletion(body, { attempt: attempt + 1 })
    }
    throw new Error(`provider ${response.status}: ${text.slice(0, 400)}`)
  }
  return response.json()
}

function toWireTools(schemas) {
  return schemas.map((schema) => ({
    type: 'function',
    function: { name: schema.name, description: schema.description, parameters: schema.parameters },
  }))
}

// ---------------------------------------------------------------------------
// One agent run.
// ---------------------------------------------------------------------------

async function runTask({ call, wireTools, allowed, task, systemPrompt, maxModelCalls, maxToolCalls, maxOutputTokens }) {
  const started = performance.now()
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task.question },
  ]
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const toolCounts = {}
  let toolCallCount = 0
  let modelCalls = 0
  let toolResultBytes = 0
  let finalText = ''
  let stopReason = 'unknown'

  while (modelCalls < maxModelCalls) {
    modelCalls += 1
    const body = {
      model: MODEL,
      messages,
      tools: wireTools,
      tool_choice: 'auto',
      temperature: 0,
      max_tokens: maxOutputTokens,
      stream: false,
    }
    const response = await chatCompletion(body)
    for (const key of Object.keys(usage)) usage[key] += response.usage?.[key] ?? 0
    const message = response.choices?.[0]?.message ?? {}
    const toolCalls = message.tool_calls ?? []

    if (toolCalls.length === 0) {
      finalText = typeof message.content === 'string' ? message.content : ''
      stopReason = 'answered'
      break
    }

    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls })
    for (const call_ of toolCalls) {
      const name = call_.function?.name ?? ''
      toolCounts[name] = (toolCounts[name] ?? 0) + 1
      if (!allowed.has(name)) {
        messages.push({ role: 'tool', tool_call_id: call_.id, content: `Error: tool "${name}" is not available.` })
        continue
      }
      if (toolCallCount >= maxToolCalls) {
        messages.push({ role: 'tool', tool_call_id: call_.id, content: 'Error: tool call budget exhausted. Answer with the evidence you already have.' })
        continue
      }
      toolCallCount += 1
      let args = {}
      try { args = JSON.parse(call_.function?.arguments ?? '{}') } catch {}
      try {
        const result = await call(name, args, `agent-${task.id}`)
        const text = result.isError ? `Error: ${result.error.message}` : contentText(result)
        toolResultBytes += result.isError ? 0 : contentBytes(result)
        messages.push({ role: 'tool', tool_call_id: call_.id, content: text })
      } catch (error) {
        messages.push({ role: 'tool', tool_call_id: call_.id, content: `Error: ${error?.message ?? error}` })
      }
    }
    if (toolCallCount >= maxToolCalls && modelCalls >= maxModelCalls) stopReason = 'budget-exhausted'
  }

  if (stopReason === 'unknown') stopReason = 'model-call-budget-exhausted'
  let graded = grade(task.answerSpec, finalText)
  let repairTurns = 0
  // Generic format repair, applied identically to every arm: a reply that is not
  // valid JSON gets at most two more chances. This is a robustness fix for the
  // harness, not a per-arm accommodation.
  while (!graded.ok && graded.reason === 'unparseable-json' && repairTurns < 2 && modelCalls < maxModelCalls) {
    messages.push({ role: 'assistant', content: finalText || '(empty reply)' })
    messages.push({
      role: 'user',
      content: 'That reply was not valid JSON. Reply again with ONLY the JSON object the task asked for: no prose, no explanation, no code fence.',
    })
    modelCalls += 1
    repairTurns += 1
    const response = await chatCompletion({ model: MODEL, messages, temperature: 0, max_tokens: maxOutputTokens, stream: false })
    for (const key of Object.keys(usage)) usage[key] += response.usage?.[key] ?? 0
    finalText = response.choices?.[0]?.message?.content ?? ''
    graded = grade(task.answerSpec, finalText)
  }
  return {
    taskId: task.id,
    category: task.category,
    ok: graded.ok,
    stopReason,
    gradeReason: graded.ok ? null : graded.reason,
    detail: graded.ok ? undefined : { got: graded.got, want: graded.want, gotLength: graded.gotLength, wantLength: graded.wantLength },
    modelCalls,
    toolCalls: toolCallCount,
    toolCounts,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    toolResultBytes,
    ms: Math.round(performance.now() - started),
    repairTurns,
    // Full raw answer retained so a judge can re-grade without re-running the
    // model (the preview alone is not enough to audit a near miss).
    finalText,
    finalTextPreview: finalText.slice(0, 200),
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const tasksDoc = JSON.parse(await readFile(TASKS_PATH, 'utf8'))
  const goldBytes = await readFile(GOLD_PATH)
  const goldSha256 = sha256(goldBytes)
  if (tasksDoc.sources.goldSha256 !== goldSha256) {
    throw new Error(`task set was derived from a different gold: ${tasksDoc.sources.goldSha256} != ${goldSha256}`)
  }
  const tasks = REQUESTED_TASK ? tasksDoc.tasks.filter((t) => t.id === REQUESTED_TASK) : tasksDoc.tasks
  if (tasks.length === 0) throw new Error(`no task matched ${REQUESTED_TASK}`)

  // Vocabulary partition: the primary figure uses only tool-free wording; the
  // tool-shaped remainder is reported beside it, never mixed in.
  const NEUTRAL_IDS = new Set(tasks.filter((t) => t.vocabulary !== 'tool-shaped').map((t) => t.id))
  const TOOL_SHAPED_IDS = new Set(tasks.filter((t) => t.vocabulary === 'tool-shaped').map((t) => t.id))
  const subset = (runs, ids) => {
    const sel = runs.filter((r) => ids.has(r.taskId))
    const ok = sel.filter((r) => r.ok).length
    return { tasks: ids.size, runs: sel.length, correct: ok, correctRate: sel.length ? Number((ok / sel.length).toFixed(4)) : null }
  }

  const armNames = REQUESTED_ARM ? [REQUESTED_ARM] : Object.keys(ARMS)
  for (const name of armNames) if (!ARMS[name]) throw new Error(`unknown arm ${name}`)

  const report = {
    schemaVersion: 1,
    kind: 'm5-phase2-agent-comparison',
    startedAt: new Date().toISOString(),
    node: process.version,
    corpusCommit: COMMIT,
    goldSha256,
    tasksSha256: sha256(await readFile(TASKS_PATH)),
    tasksSchemaVersion: tasksDoc.schemaVersion,
    repeats: REPEATS,
    provider: { baseUrl: BASE_URL, model: MODEL, temperature: 0, apiKeySource: API_KEY_SOURCE },
    vocabulary: { neutral: [...NEUTRAL_IDS], toolShaped: [...TOOL_SHAPED_IDS] },
    arms: {},
    failures: [],
    notes: [],
  }

  if (DRY_RUN) {
    for (const name of armNames) {
      const spec = ARMS[name]
      const ctx = await makeRegistry()
      const parent = await mkdtemp(join(tmpdir(), `m5-agent-dry-${name}-`))
      const root = await mountCorpus(ctx, join(parent, 'src'))
      const { module: fsSearch } = await loadFsSearch()
      const { provenance, promptSections } = await mountRetrievalTools(ctx, root, { includeSearch: spec.search, fsSearch })
      if (spec.structured) {
        const codeIntel = await import('../../lib/index.js')
        await ctx.plugin(codeIntel.apply, { deploymentRoot: '.', revision: COMMIT })
      }
      const names = ctx.tools.schemas().map((s) => s.name)
      const allowed = names.filter((n) => n !== 'write' && n !== 'edit' && (!n.startsWith(STRUCTURED_PREFIX) || spec.structured))
      const systemPrompt = systemPromptForTools(SYSTEM_PREAMBLE, promptSections, allowed)
      console.log(`${name.padEnd(12)} tools=[${allowed.join(', ')}]  provenance=${JSON.stringify(provenance)}`)
      console.log(`${''.padEnd(12)} promptSections=${JSON.stringify((promptSections ?? []).map((s) => `${s.name}@${s.order}`))}  systemPromptChars=${systemPrompt.length}`)
      await rm(parent, { recursive: true, force: true })
    }
    console.log(`dry run ok: ${tasks.length} task(s), ${armNames.length} arm(s)`)
    return
  }

  if (!API_KEY) throw new Error('no DeepSeek API key: set DEEPSEEK_API_KEY, or provide .dsh/.credentials.yaml with refs.DEEPSEEK_API_KEY (the key is never written to artifacts)')

  for (const name of armNames) {
    const spec = ARMS[name]
    const ctx = await makeRegistry()
    const parent = await mkdtemp(join(tmpdir(), `m5-agent-${name}-`))
    const root = await mountCorpus(ctx, join(parent, 'src'))
    const { module: fsSearch } = await loadFsSearch()
    const { provenance, promptSections } = await mountRetrievalTools(ctx, root, { includeSearch: spec.search, fsSearch })
    if (spec.structured) {
      const codeIntel = await import('../../lib/index.js')
      await ctx.plugin(codeIntel.apply, { deploymentRoot: '.', revision: COMMIT })
    }
    const schemas = ctx.tools.schemas()
    const allowed = new Set(
      schemas
        .map((s) => s.name)
        .filter((n) => n !== 'write' && n !== 'edit')
        .filter((n) => !n.startsWith(STRUCTURED_PREFIX) || spec.structured),
    )
    const wireTools = toWireTools(schemas.filter((s) => allowed.has(s.name)))
    // Forward the product's own prompt sections for the exposed tools, exactly
    // as the shipped harness would; a tool that was filtered out contributes
    // neither a tool schema nor a prompt section.
    const systemPrompt = systemPromptForTools(SYSTEM_PREAMBLE, promptSections, [...allowed])
    const session = ctx.sessions.prepare(SessionId(`m5-agent-${name}`), { meta: { cwd: root } })
    ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const call = makeCaller(ctx, session)

    const runs = []
    const coldStart = performance.now()
    if (spec.structured) {
      // Warm the structured index once per arm so cold-start is reported apart from per-task cost.
      await call('context_repo_map', {}, `warm-${name}`)
    }
    const coldMs = Math.round(performance.now() - coldStart)

    for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
      for (const task of tasks) {
        process.stdout.write(`[${name}] r${repeat} ${task.id} ... `)
        try {
          const run = await runTask({
            call,
            wireTools,
            allowed,
            task,
            systemPrompt,
            maxModelCalls: tasksDoc.budget.maxModelCalls,
            maxToolCalls: tasksDoc.budget.maxToolCalls,
            maxOutputTokens: tasksDoc.budget.maxOutputTokens,
          })
          run.repeat = repeat
          runs.push(run)
          console.log(run.ok ? `ok (${run.modelCalls}m/${run.toolCalls}t ${run.totalTokens}tok)` : `FAIL ${run.gradeReason}`)
        } catch (error) {
          console.log(`ERROR ${error?.message ?? error}`)
          report.failures.push(`${name}/${task.id}/r${repeat}: ${error?.message ?? error}`)
          runs.push({ taskId: task.id, category: task.category, repeat, ok: false, stopReason: 'harness-error', gradeReason: String(error?.message ?? error) })
        }
      }
    }

    const sum = (key) => runs.reduce((n, r) => n + (r[key] ?? 0), 0)
    const byCategory = {}
    for (const run of runs) {
      const bucket = (byCategory[run.category] ??= { runs: 0, ok: 0, tokens: 0, toolCalls: 0, modelCalls: 0 })
      bucket.runs += 1
      if (run.ok) bucket.ok += 1
      bucket.tokens += run.totalTokens ?? 0
      bucket.toolCalls += run.toolCalls ?? 0
      bucket.modelCalls += run.modelCalls ?? 0
    }
    const toolCounts = {}
    for (const run of runs) for (const [tool, n] of Object.entries(run.toolCounts ?? {})) toolCounts[tool] = (toolCounts[tool] ?? 0) + n

    report.arms[name] = {
      label: spec.label,
      search: spec.search,
      structured: spec.structured,
      provenance,
      exposedTools: [...allowed].sort(),
      coldStartMs: coldMs,
      runs: runs.length,
      correct: runs.filter((r) => r.ok).length,
      correctRate: runs.length ? Number((runs.filter((r) => r.ok).length / runs.length).toFixed(4)) : null,
      totalTokens: sum('totalTokens'),
      promptTokens: sum('promptTokens'),
      completionTokens: sum('completionTokens'),
      toolResultBytes: sum('toolResultBytes'),
      toolCalls: sum('toolCalls'),
      modelCalls: sum('modelCalls'),
      toolCounts,
      byCategory,
      byVocabulary: {
        neutral: subset(runs, NEUTRAL_IDS),
        toolShaped: subset(runs, TOOL_SHAPED_IDS),
      },
      systemPromptChars: systemPrompt.length,
      promptSectionsRegistered: (promptSections ?? []).map((s) => ({ name: s.name, order: s.order })),
      promptSectionsForwarded: forwardedPromptSections(promptSections, [...allowed]).map((s) => ({ name: s.name, order: s.order })),
      detail: runs,
    }
    await rm(parent, { recursive: true, force: true })
  }

  report.notes.push(
    'All arms share one frozen task set, one corpus copy per arm, one model, temperature 0, and identical token/tool caps.',
    '`default` is the shipped DSH read-only retrieval surface (`read`+`grep`+`glob`); `additive` adds the structured tools; `replacement` removes `grep`/`glob` and keeps only `read` plus the structured tools.',
    'Excluded from every arm: write/edit and the rest of the dsh-base surface (bash, subagent, web, workflow, todo, skill) because they are outside retrieval.',
    'Grading is programmatic against the frozen answerSpec; order-independent set comparison for path/name/target sets, exact equality for text and lines.',
    'A single repeat cannot detect small accuracy differences; token/tool-call differences are the more sensitive signal at low N.',
    'The system prompt is the arm-neutral preamble plus the product\'s own registered sections for exactly the tools that arm exposes, so no arm is told about a tool it cannot call.',
    'The primary accuracy figure is `byVocabulary.neutral`; `byVocabulary.toolShaped` covers tasks whose wording still depends on the tested tool\'s request model and is reported as a diagnostic only.',
  )

  report.finishedAt = new Date().toISOString()
  report.ok = report.failures.length === 0
  await mkdir(REPORT_DIR, { recursive: true })
  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`)

  for (const [name, arm] of Object.entries(report.arms)) {
    console.log(
      `${name.padEnd(12)} ${arm.correct}/${arm.runs} all  ` +
        `neutral ${arm.byVocabulary.neutral.correct}/${arm.byVocabulary.neutral.runs}  ` +
        `${arm.byVocabulary.toolShaped.runs ? `tool-shaped ${arm.byVocabulary.toolShaped.correct}/${arm.byVocabulary.toolShaped.runs}  ` : ''}` +
        `tokens=${arm.totalTokens}  toolCalls=${arm.toolCalls}  modelCalls=${arm.modelCalls}`,
    )
  }
  console.log(`report: ${OUT_PATH}`)
}

try {
  await main()
} catch (error) {
  console.error(error?.stack ?? error)
  process.exitCode = 1
}

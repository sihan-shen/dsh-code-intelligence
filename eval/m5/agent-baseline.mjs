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
  CORPUS_ROOT,
  DEFAULT_AGENT_RUN_SEED,
  EVALUATION_CODE_INTELLIGENCE_CONFIG,
  GOLD_PATH,
  REPORT_DIR,
  contentBytes,
  contentText,
  createAgentRunSchedule,
  jsonRepairRequest,
  loadCodeIntelligence,
  loadCorpusManifest,
  loadFsSearch,
  makeCaller,
  makeRegistry,
  mountCorpus,
  mountRetrievalTools,
  requestCarriesToolSchemas,
  resolveApiKey,
  resolveEvaluationHost,
  sha256,
  summarizeCompletedRuns,
  summarizeTaskMajority,
  verifyCorpusTree,
  forwardedPromptSections,
  systemPromptForTools,
} from './harness.mjs'

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
const RUN_SEED = argValue('seed', process.env.M5_RUN_SEED ?? DEFAULT_AGENT_RUN_SEED)
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
  const modelCallDetails = []

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
    modelCallDetails.push({
      ordinal: modelCalls,
      kind: 'agent',
      carriesToolSchemas: requestCarriesToolSchemas(body),
      toolSchemaCount: body.tools?.length ?? 0,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    })
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
    // Preserve the ordinary tool/schema context while preventing a format-only
    // repair from starting new retrieval after grading has begun.
    const repairBody = jsonRepairRequest({ model: MODEL, messages, wireTools, maxOutputTokens })
    const response = await chatCompletion(repairBody)
    modelCallDetails.push({
      ordinal: modelCalls,
      kind: 'json-repair',
      carriesToolSchemas: requestCarriesToolSchemas(repairBody),
      toolSchemaCount: repairBody.tools?.length ?? 0,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    })
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
    modelCallsWithToolSchemas: modelCallDetails.filter(call => call.carriesToolSchemas).length,
    modelCallsWithoutToolSchemas: modelCallDetails.filter(call => !call.carriesToolSchemas).length,
    modelCallDetails,
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
  // Resolve the entire host graph first: a mixed Cordis/ToolRuntime identity is
  // an invalid experiment and must fail before corpus or provider activity.
  const evaluationHost = await resolveEvaluationHost()
  const tasksDoc = JSON.parse(await readFile(TASKS_PATH, 'utf8'))
  const corpusIdentity = await loadCorpusManifest()
  const preparedCorpus = await verifyCorpusTree(CORPUS_ROOT, corpusIdentity.manifest)
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
  const subset = (runs, ids) => ({ tasks: ids.size, ...summarizeCompletedRuns(runs, ids) })
  // Preregistered primary endpoint (doc/m5-phase2b-preregistration.md §5):
  // per-task majority vote across repeats, averaged over tasks.
  const majoritySubset = (runs, ids) => ({ tasks: ids.size, ...summarizeTaskMajority(runs, ids) })

  const armNames = REQUESTED_ARM ? [REQUESTED_ARM] : Object.keys(ARMS)
  for (const name of armNames) if (!ARMS[name]) throw new Error(`unknown arm ${name}`)
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const schedule = createAgentRunSchedule({ armNames, taskIds: tasks.map(task => task.id), repeats: REPEATS, seed: RUN_SEED })

  const report = {
    schemaVersion: 2,
    kind: 'm5-phase2-agent-comparison',
    startedAt: new Date().toISOString(),
    node: process.version,
    evaluationHost: evaluationHost.provenance,
    corpusCommit: COMMIT,
    corpusVerification: {
      lockSha256: corpusIdentity.lockSha256,
      manifestSha256: corpusIdentity.manifestSha256,
      preparedRootVerification: preparedCorpus,
      copiesVerifiedAgainstManifest: true,
    },
    evaluationCodeIntelligenceConfig: EVALUATION_CODE_INTELLIGENCE_CONFIG,
    goldSha256,
    tasksSha256: sha256(await readFile(TASKS_PATH)),
    tasksSchemaVersion: tasksDoc.schemaVersion,
    repeats: REPEATS,
    schedule: {
      seed: RUN_SEED,
      strategy: 'cyclic-latin-square-arms-and-seeded-fisher-yates-tasks-v1',
      repeats: schedule.map(item => ({ repeat: item.repeat, armOrder: [...item.armOrder], taskOrder: [...item.taskOrder] })),
    },
    provider: { baseUrl: BASE_URL, model: MODEL, temperature: 0, apiKeySource: API_KEY_SOURCE },
    vocabulary: { neutral: [...NEUTRAL_IDS], toolShaped: [...TOOL_SHAPED_IDS] },
    arms: {},
    failures: [],
    notes: [],
  }

  if (DRY_RUN) {
    console.log(`evaluationHost=${JSON.stringify(evaluationHost.provenance)}`)
    for (const name of armNames) {
      const spec = ARMS[name]
      const ctx = await makeRegistry()
      const parent = await mkdtemp(join(tmpdir(), `m5-agent-dry-${name}-`))
      const root = await mountCorpus(ctx, join(parent, 'src'), corpusIdentity.manifest)
      const { module: fsSearch } = await loadFsSearch()
      const { provenance, promptSections } = await mountRetrievalTools(ctx, root, { includeSearch: spec.search, fsSearch })
      if (spec.structured) {
        const codeIntel = await loadCodeIntelligence()
        await ctx.plugin(codeIntel.apply, EVALUATION_CODE_INTELLIGENCE_CONFIG)
      }
      const names = ctx.tools.schemas().map((s) => s.name)
      const allowed = names.filter((n) => n !== 'write' && n !== 'edit' && (!n.startsWith(STRUCTURED_PREFIX) || spec.structured))
      const systemPrompt = systemPromptForTools(SYSTEM_PREAMBLE, promptSections, allowed)
      console.log(`${name.padEnd(12)} tools=[${allowed.join(', ')}]  provenance=${JSON.stringify(provenance)}`)
      console.log(`${''.padEnd(12)} promptSections=${JSON.stringify((promptSections ?? []).map((s) => `${s.name}@${s.order}`))}  systemPromptChars=${systemPrompt.length}`)
      await ctx.fiber.dispose()
      await rm(parent, { recursive: true, force: true })
    }
    console.log(`dry run ok: ${tasks.length} task(s), ${armNames.length} arm(s)`)
    return
  }

  if (!API_KEY) throw new Error('no DeepSeek API key: set DEEPSEEK_API_KEY, or provide .dsh/.credentials.yaml with refs.DEEPSEEK_API_KEY (the key is never written to artifacts)')

  const armRuntimes = new Map()
  try {
    // Initialize each arm once. The repeat-first execution schedule below
    // counterbalances provider time while preserving each arm's warm index.
    for (const name of armNames) {
      const spec = ARMS[name]
      const ctx = await makeRegistry()
      const parent = await mkdtemp(join(tmpdir(), `m5-agent-${name}-`))
      try {
        const root = await mountCorpus(ctx, join(parent, 'src'), corpusIdentity.manifest)
        const { module: fsSearch } = await loadFsSearch()
        const { provenance, promptSections } = await mountRetrievalTools(ctx, root, { includeSearch: spec.search, fsSearch })
        if (spec.structured) {
          const codeIntel = await loadCodeIntelligence()
          await ctx.plugin(codeIntel.apply, EVALUATION_CODE_INTELLIGENCE_CONFIG)
        }
        const schemas = ctx.tools.schemas()
        const allowed = new Set(
          schemas
            .map((schema) => schema.name)
            .filter((toolName) => toolName !== 'write' && toolName !== 'edit')
            .filter((toolName) => !toolName.startsWith(STRUCTURED_PREFIX) || spec.structured),
        )
        const wireTools = toWireTools(schemas.filter((schema) => allowed.has(schema.name)))
        const systemPrompt = systemPromptForTools(SYSTEM_PREAMBLE, promptSections, [...allowed])
        const session = ctx.sessions.prepare(ctx.evaluationHostApis.SessionId(`m5-agent-${name}`), { meta: { cwd: root } })
        const detach = ctx.sessions.enter(session)
        ctx.sessions.announce(session)
        const call = makeCaller(ctx, session)
        const coldStart = performance.now()
        if (spec.structured) await call('context_repo_map', {}, `warm-${name}`)
        armRuntimes.set(name, {
          spec, ctx, parent, detach, provenance, promptSections, allowed, wireTools, systemPrompt, call,
          coldMs: Math.round(performance.now() - coldStart), runs: [],
        })
      } catch (error) {
        await ctx.fiber.dispose().catch(() => undefined)
        await rm(parent, { recursive: true, force: true })
        throw error
      }
    }

    for (const scheduledRepeat of schedule) {
      for (const name of scheduledRepeat.armOrder) {
        const runtime = armRuntimes.get(name)
        for (const taskId of scheduledRepeat.taskOrder) {
          const task = taskById.get(taskId)
          if (task === undefined) throw new Error(`scheduled unknown task ${taskId}`)
          process.stdout.write(`[${name}] r${scheduledRepeat.repeat} ${task.id} ... `)
          try {
            const run = await runTask({
              call: runtime.call,
              wireTools: runtime.wireTools,
              allowed: runtime.allowed,
              task,
              systemPrompt: runtime.systemPrompt,
              maxModelCalls: tasksDoc.budget.maxModelCalls,
              maxToolCalls: tasksDoc.budget.maxToolCalls,
              maxOutputTokens: tasksDoc.budget.maxOutputTokens,
            })
            run.repeat = scheduledRepeat.repeat
            runtime.runs.push(run)
            console.log(run.ok ? `ok (${run.modelCalls}m/${run.toolCalls}t ${run.totalTokens}tok)` : `FAIL ${run.gradeReason}`)
          } catch (error) {
            console.log(`ERROR ${error?.message ?? error}`)
            report.failures.push(`${name}/${task.id}/r${scheduledRepeat.repeat}: ${error?.message ?? error}`)
            runtime.runs.push({ taskId: task.id, category: task.category, repeat: scheduledRepeat.repeat, ok: false, stopReason: 'harness-error', gradeReason: String(error?.message ?? error), modelCallDetails: [] })
          }
        }
      }
    }

    for (const name of armNames) {
      const runtime = armRuntimes.get(name)
      const { spec, provenance, promptSections, allowed, systemPrompt, coldMs, runs } = runtime
      const sum = (key) => runs.reduce((total, run) => total + (run[key] ?? 0), 0)
      const byCategory = {}
      for (const run of runs) {
        const bucket = (byCategory[run.category] ??= { attempts: 0, completed: 0, failed: 0, correct: 0, tokens: 0, toolCalls: 0, modelCalls: 0 })
        bucket.attempts += 1
        if (run.stopReason === 'harness-error') bucket.failed += 1
        else {
          bucket.completed += 1
          if (run.ok) bucket.correct += 1
        }
        bucket.tokens += run.totalTokens ?? 0
        bucket.toolCalls += run.toolCalls ?? 0
        bucket.modelCalls += run.modelCalls ?? 0
      }
      for (const bucket of Object.values(byCategory)) {
        bucket.correctRate = bucket.completed ? Number((bucket.correct / bucket.completed).toFixed(4)) : null
      }
      const toolCounts = {}
      for (const run of runs) for (const [tool, count] of Object.entries(run.toolCounts ?? {})) toolCounts[tool] = (toolCounts[tool] ?? 0) + count

      const accuracy = summarizeCompletedRuns(runs)
      report.arms[name] = {
        label: spec.label,
        search: spec.search,
        structured: spec.structured,
        provenance,
        exposedTools: [...allowed].sort(),
        coldStartMs: coldMs,
        runs: runs.length,
        attempts: accuracy.attempts,
        completed: accuracy.completed,
        failed: accuracy.failed,
        correct: accuracy.correct,
        correctRate: accuracy.correctRate,
        totalTokens: sum('totalTokens'),
        promptTokens: sum('promptTokens'),
        completionTokens: sum('completionTokens'),
        toolResultBytes: sum('toolResultBytes'),
        toolCalls: sum('toolCalls'),
        modelCalls: sum('modelCalls'),
        modelCallsWithToolSchemas: sum('modelCallsWithToolSchemas'),
        modelCallsWithoutToolSchemas: sum('modelCallsWithoutToolSchemas'),
        toolCounts,
        byCategory,
        byVocabulary: {
          neutral: subset(runs, NEUTRAL_IDS),
          neutralMajority: majoritySubset(runs, NEUTRAL_IDS),
          toolShaped: subset(runs, TOOL_SHAPED_IDS),
          toolShapedMajority: majoritySubset(runs, TOOL_SHAPED_IDS),
        },
        systemPromptChars: systemPrompt.length,
        promptSectionsRegistered: (promptSections ?? []).map((section) => ({ name: section.name, order: section.order })),
        promptSectionsForwarded: forwardedPromptSections(promptSections, [...allowed]).map((section) => ({ name: section.name, order: section.order })),
        detail: runs,
      }
    }
  } finally {
    for (const runtime of armRuntimes.values()) {
      runtime.detach?.()
      await runtime.ctx.fiber.dispose().catch(() => undefined)
      await rm(runtime.parent, { recursive: true, force: true })
    }
  }

  report.notes.push(
    'All arms share one frozen task set, one corpus copy per arm, one model, temperature 0, and identical token/tool caps.',
    'The report records the complete asserted evaluation-host module graph; startup fails before provider calls if DSH versions or Cordis/tool peer identities differ.',
    '`default` is the shipped DSH read-only retrieval surface (`read`+`grep`+`glob`); `additive` adds the structured tools; `replacement` removes `grep`/`glob` and keeps only `read` plus the structured tools.',
    'Excluded from every arm: write/edit and the rest of the dsh-base surface (bash, subagent, web, workflow, todo, skill) because they are outside retrieval.',
    'Grading is programmatic against the frozen answerSpec; order-independent set comparison for path/name/target sets, exact equality for text and lines.',
    'A single repeat cannot detect small accuracy differences; token/tool-call differences are the more sensitive signal at low N.',
    'Provider/harness errors are reported as failed attempts and excluded from completed-run accuracy denominators.',
    'Structured arms share one index per arm, while sessionSourceBytes=null prevents source reads in earlier tasks from consuming a later task\'s evaluation capacity.',
    'Every copied corpus tree is verified against the locked per-file manifest before its arm is mounted.',
    'Full comparisons use a cyclic Latin-square arm order across repeats; each repeat applies one frozen-seed deterministic task permutation shared by all arms.',
    'Each model call records whether tool schemas were sent; JSON repair preserves the same schemas with tool_choice=none.',
    'The system prompt is the arm-neutral preamble plus the product\'s own registered sections for exactly the tools that arm exposes, so no arm is told about a tool it cannot call.',
    'The primary accuracy figure is `byVocabulary.neutral`; `byVocabulary.toolShaped` covers tasks whose wording still depends on the tested tool\'s request model and is reported as a diagnostic only.',
    'The preregistered primary endpoint is `byVocabulary.neutralMajority` / `toolShapedMajority`: per-task majority vote across repeats, then averaged over tasks (doc/m5-phase2b-preregistration.md §5). `byVocabulary.neutral` is the older run-pooled figure and is kept only for continuity with already-published reports.',
  )

  report.finishedAt = new Date().toISOString()
  report.ok = report.failures.length === 0
  report.primaryEndpoint = 'byVocabulary.neutralMajority (per-task majority across repeats, averaged over tasks)'
  await mkdir(REPORT_DIR, { recursive: true })
  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`)

  for (const [name, arm] of Object.entries(report.arms)) {
    console.log(
      `${name.padEnd(12)} ${arm.correct}/${arm.completed} completed (${arm.failed} failed)  ` +
        `neutral ${arm.byVocabulary.neutral.correct}/${arm.byVocabulary.neutral.completed} pooled | ` +
        `neutral-majority ${arm.byVocabulary.neutralMajority.correct}/${arm.byVocabulary.neutralMajority.evaluated} PRIMARY  ` +
        `${arm.byVocabulary.toolShaped.attempts ? `tool-shaped ${arm.byVocabulary.toolShaped.correct}/${arm.byVocabulary.toolShaped.completed} completed  ` : ''}` +
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

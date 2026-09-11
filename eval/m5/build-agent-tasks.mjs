// M5 Phase 2 — derive the preregistered agent task set from the FROZEN gold.
//
// The task set is a deterministic projection of `eval/m5/gold.json`: every
// question is a natural-language restatement of a gold request, and every
// answer spec is the gold expectation itself. Nothing is tuned to any tool,
// and no task is invented here. Freeze the output and hash it before running
// any arm; a changed `agent-tasks.json` invalidates a comparison.
//
// Run: node eval/m5/build-agent-tasks.mjs

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { COMMIT, GOLD_PATH, sha256 } from './lib/harness.mjs'

const OUT_PATH = fileURLToPath(new URL('./agent-tasks.json', import.meta.url))

const ANSWER_SHAPE = 'Reply with exactly one JSON object and nothing else.'

// ---------------------------------------------------------------------------
// v2 wording (fairness fix).
//
// The v1 template for `source` and `relation` samples restated the gold request
// fields literally (`half-open UTF-16 code-unit range`, `padding`, `clamped`,
// ``List every `calls` relation``). Those phrases are the tested tool's own
// vocabulary, so v1 partly measured "can you reproduce our tool's request
// model" rather than "can you find the fact". The overrides below restate the
// SAME gold expectations in tool-free language.
//
// Only `question` changes. Every `answerSpec` still comes from the frozen gold
// projection below; `--verify-against <file>` asserts that byte-for-byte against
// an archived task set.
// ---------------------------------------------------------------------------

const QUESTION_V2 = {
  'src-02-offset-range-declaration':
    'In the file `v4/core/versions.ts`, return the exact source text of the declaration of the exported constant `version`, excluding the leading `export const ` and excluding the trailing semicolon. ' +
    `${ANSWER_SHAPE} Use the shape {"text": "<exact text>"}.`,
  'src-03-line-range-padding':
    'In the file `v4/core/config.ts`, return the exact source text of lines 4 through 7 (1-based, inclusive), including the line terminator of each of those lines. ' +
    `${ANSWER_SHAPE} Use the shape {"text": "<exact text>"}.`,
  'src-06-padding-clamped':
    'Return the complete source text of the file `v4/core/versions.ts`, including the final line terminator. ' +
    `${ANSWER_SHAPE} Use the shape {"text": "<exact text>"}.`,
  'rel-01-imports-external':
    'In the file `v4/classic/tests/enum.test.ts`, list the module specifier of every module that the file imports from, exactly as written in the source. ' +
    `${ANSWER_SHAPE} Use the shape {"targets": ["<module specifier>", ...]}.`,
  'rel-02-exports-named-and-star':
    'In the file `v4-mini/index.ts`, list what the file exports to its consumers: for a re-export of a whole module report the module specifier exactly as written in the source, and for a named export report the exported name. ' +
    `${ANSWER_SHAPE} Use the shape {"targets": ["<target string>", ...]}.`,
  'rel-03-contains-nesting':
    'Find the enum declaration named `Colors` under the directory `v4/classic/tests`, and list the name of every member it declares. ' +
    `${ANSWER_SHAPE} Use the shape {"targets": ["<member name>", ...]}.`,
  'rel-04-calls-heuristic':
    'In the file `v4/classic/external.ts`, ignore every import declaration and every export declaration. For the remaining executable statements, list the name of every function that is called there, exactly as written in the source (a call made inside the arguments of another call counts too). ' +
    `${ANSWER_SHAPE} Use the shape {"targets": ["<callee name>", ...]}.`,
  'rel-05-zero-edge':
    'In the file `v4/core/versions.ts`, list the module specifier of every module that the file imports from. If the file imports nothing at all, return an empty array. ' +
    `${ANSWER_SHAPE} Use the shape {"targets": []}.`,
  'rel-06-type-only-exports':
    'In the file `v3/helpers/typeAliases.ts`, list the name of every declaration that the file exports, including type-only exports. ' +
    `${ANSWER_SHAPE} Use the shape {"targets": ["<exported name>", ...]}.`,
}

// Tasks whose wording still depends on the tested tool's own request model, so
// they cannot be answered fairly by a plain reader. They are kept (dropping a
// frozen sample would be worse) but excluded from the primary accuracy figure.
const TOOL_SHAPED = {
  'src-04-empty-offset-range':
    'A zero-width UTF-16 offset range has no natural-language equivalent: "the text between the end of line 1 and the start of line 2" reads as the line terminator, while the gold expectation for the empty range is the empty string. Kept, graded only as a secondary diagnostic.',
}

function declarationQuestion(sample) {
  const { name, kind, pathPrefix } = sample.request
  const scope = pathPrefix ? ` under the directory \`${pathPrefix}\`` : ''
  if (sample.matchMode === 'same-name-set') {
    return `Find every file that declares a ${kind} named \`${name}\`${scope}. The name occurs in more than one place; report all of them. ${ANSWER_SHAPE} Use the shape {"paths": ["<repo-relative path>", ...]} with each declaring file listed exactly once.`
  }
  return `Find the ${kind} declaration named \`${name}\`${scope}. ${ANSWER_SHAPE} Use the shape {"path": "<repo-relative path>", "startLine": <first line, 1-based>, "endLine": <last line, 1-based inclusive>} of that declaration.`
}

function sourceQuestion(sample) {
  const { path, wholeFile, offsetRange, lineRange, paddingLines } = sample.request
  const pad = paddingLines ? ` plus ${paddingLines} line(s) of padding on each side, clamped to the file bounds` : ''
  if (wholeFile) {
    return `Return the complete source text of the file \`${path}\`. ${ANSWER_SHAPE} Use the shape {"text": "<file contents>"} with the exact text, no line numbers.`
  }
  if (offsetRange) {
    return `Return the exact source text that occupies the half-open UTF-16 code-unit range [${offsetRange.startOffset}, ${offsetRange.endOffset}) of the file \`${path}\`${pad}. ${ANSWER_SHAPE} Use the shape {"text": "<exact text>"}.`
  }
  return `Return the exact source text of lines ${lineRange.startLine} through ${lineRange.endLine} (1-based, inclusive; include the line terminator of line ${lineRange.endLine}) of the file \`${path}\`${pad}. ${ANSWER_SHAPE} Use the shape {"text": "<exact text>"}.`
}

function relationTargetString(target) {
  return target.specifier ?? target.name ?? target.path
}

function relationQuestion(sample) {
  const types = sample.request.types.join(', ')
  if (sample.relationKind === 'symbol') {
    const from = sample.request.from
    return `List every symbol that the ${from.symbolKind} \`${from.symbolName}\` declared under \`${from.symbolPrefix}\` contains (relation type: ${types}). ${ANSWER_SHAPE} Use the shape {"targets": ["<symbol name>", ...]}.`
  }
  const path = sample.request.from.path
  return `List every \`${types}\` relation whose source is the file \`${path}\`, and report the target string of each one (for an import/export use the module specifier or the exported name; for a call use the callee name). ${ANSWER_SHAPE} Use the shape {"targets": ["<target string>", ...]}.`
}

function answerSpecFor(sample) {
  if (sample.category === 'declaration') {
    if (sample.matchMode === 'same-name-set') {
      return {
        kind: 'pathSet',
        paths: [...new Set(sample.expectedTargets.map((t) => t.path))].sort(),
      }
    }
    const target = sample.expectedTargets[0]
    return {
      kind: 'declarationLocation',
      path: target.path,
      startLine: target.start.line,
      endLine: target.end.line,
    }
  }
  if (sample.category === 'source') {
    return { kind: 'sourceText', path: sample.request.path, text: sample.expected.text }
  }
  if (sample.relationKind === 'symbol') {
    return { kind: 'targetNameSet', names: sample.expected.targets.map((t) => t.name).sort() }
  }
  return {
    kind: 'targetStringSet',
    targets: [...new Set(sample.expected.map((edge) => relationTargetString(edge.target)))].sort(),
  }
}

function questionFor(sample) {
  if (QUESTION_V2[sample.id]) return QUESTION_V2[sample.id]
  if (sample.category === 'declaration') return declarationQuestion(sample)
  if (sample.category === 'source') return sourceQuestion(sample)
  return relationQuestion(sample)
}

const gold = JSON.parse(await readFile(GOLD_PATH, 'utf8'))
const goldBytes = await readFile(GOLD_PATH)

const tasks = gold.samples.map((sample) => ({
  id: sample.id,
  category: sample.category,
  ...(sample.relationKind ? { relationKind: sample.relationKind } : {}),
  vocabulary: TOOL_SHAPED[sample.id] ? 'tool-shaped' : 'neutral',
  ...(TOOL_SHAPED[sample.id] ? { vocabularyNote: TOOL_SHAPED[sample.id] } : {}),
  question: questionFor(sample),
  answerSpec: answerSpecFor(sample),
}))

// Set-equality of answers against an archived task set (proves wording-only edits).
const verifyIndex = process.argv.indexOf('--verify-against')
if (verifyIndex >= 0) {
  const referencePath = process.argv[verifyIndex + 1]
  if (!referencePath) throw new Error('--verify-against requires a path')
  const reference = JSON.parse(await readFile(referencePath, 'utf8'))
  const byId = new Map(reference.tasks.map((t) => [t.id, t]))
  const problems = []
  for (const task of tasks) {
    const ref = byId.get(task.id)
    if (!ref) { problems.push(`${task.id}: missing from ${referencePath}`); continue }
    if (JSON.stringify(ref.answerSpec) !== JSON.stringify(task.answerSpec)) {
      problems.push(`${task.id}: answerSpec changed\n    was ${JSON.stringify(ref.answerSpec)}\n    now ${JSON.stringify(task.answerSpec)}`)
    }
    const projection = (t) => JSON.stringify({ id: t.id, category: t.category, relationKind: t.relationKind ?? null, answerSpec: t.answerSpec })
    if (projection(ref) !== projection(task)) {
      problems.push(`${task.id}: a graded field changed (id/category/relationKind/answerSpec)`)
    }
  }
  for (const id of byId.keys()) if (!tasks.some((t) => t.id === id)) problems.push(`${id}: dropped from the task set`)
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exitCode = 1
    throw new Error(`${problems.length} answer-integrity problem(s) against ${referencePath}`)
  }
  console.log(`answer-integrity ok against ${referencePath}: ${tasks.length} answerSpec(s) identical, no task added or dropped`)
}

const document = {
  schemaVersion: 2,
  kind: 'm5-phase2-agent-tasks',
  purpose:
    'Frozen question/answer pairs for the M5 Phase 2 agent comparison between the real DSH default retrieval tools and the code-intelligence context_* tools. Deterministically derived from the frozen gold; contains no tool-specific tuning. v2 rewrites the nine source/relation questions that used the tested tool\'s own vocabulary into tool-free language, changing no answer.',
  corpus: { ...gold.corpus, commit: COMMIT },
  sources: {
    gold: 'eval/m5/gold.json',
    goldSha256: sha256(goldBytes),
    v1TaskSet: 'eval/m5/agent-tasks.v1.json',
    v1WordingChange: 'question text only; answerSpec values are byte-identical to v1',
  },
  rules: {
    questions: 'Every arm receives the byte-identical question text; the task set is frozen before any arm runs.',
    answers:
      'Grading is programmatic against answerSpec: exact string equality for text and path, exact integer equality for lines, order-independent set equality for path/name/target sets (compared after trimming and de-duplication).',
    leakage:
      'No question names a tool or a tool argument. The gold request fields (name/kind/pathPrefix/offsets/lineRange/types) are restated in plain language because they define the task, not the method. Seven v1 questions restated them in the tested tool\'s own vocabulary (UTF-16 code-unit offsets, padding/clamping, named relation types); v2 removes that vocabulary without changing any expected answer.',
    vocabulary:
      'Each task carries a `vocabulary` field. The primary accuracy figure uses only `neutral` tasks; `tool-shaped` tasks are reported as a secondary diagnostic.',
    independence:
      'This file and its generator never call the tested extractor or any tool; they only project eval/m5/gold.json.',
    scope:
      'This is a retrieval QA benchmark over a frozen corpus, not a SWE task benchmark. It measures whether an agent can obtain and report repository facts, not whether it can change code.',
  },
  vocabularyPolicy: {
    neutral: 'Question wording names no tool, no tool argument, and no retrieval strategy.',
    toolShaped: Object.keys(TOOL_SHAPED),
    rule: 'Primary accuracy is reported over the neutral subset. Tool-shaped tasks are reported separately and never mixed into the primary figure.',
  },
  budget: {
    maxModelCalls: 8,
    maxToolCalls: 16,
    maxOutputTokens: 1200,
    note: 'Identical caps for every arm. An arm that exceeds a cap fails that task.',
  },
  tasks,
}

await writeFile(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`)
console.log(`tasks=${tasks.length}`)
console.log(`byCategory=${JSON.stringify(tasks.reduce((acc, t) => ((acc[t.category] = (acc[t.category] ?? 0) + 1), acc), {}))}`)
console.log(`byVocabulary=${JSON.stringify(tasks.reduce((acc, t) => ((acc[t.vocabulary] = (acc[t.vocabulary] ?? 0) + 1), acc), {}))}`)
console.log(`rewrittenForFairness=${Object.keys(QUESTION_V2).join(',')}`)
console.log(`goldSha256=${document.sources.goldSha256}`)
console.log(`agentTasksSha256=${sha256(await readFile(OUT_PATH))}`)
console.log(`wrote ${OUT_PATH}`)

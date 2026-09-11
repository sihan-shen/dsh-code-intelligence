# M5 local environment

This directory records the fixed corpus identity for Task 1, the frozen gold
samples for Task 2, and the formal M5 acceptance runner for Task 3.

## Frozen gold

`gold.json` holds 20 samples (8 declaration-location, 6 source-read, 6
relation) over the locked Zod corpus. It was produced by a read-only
independent agent and then re-verified by the parent against the raw corpus
bytes: every offset was recomputed from source text, all 10 declaration spans
were confirmed against the TypeScript compiler AST, declaration uniqueness was
checked tree-wide, and every relation source was re-read. The package
extractor/build/query were never used to produce or adjust gold.

Frozen SHA-256 of `eval/m5/gold.json`:

```
cb9b7c90ed06cfd6a1960fdd71d77733265d21213253916d4357651c409d5237
```

If this hash changes, the acceptance result is invalid and must be regenerated
against a freshly reviewed gold file. The review is an AI independent source
review, not a human review.

Run the acceptance runner after `pnpm run build`:

```bash
./node_modules/.bin/vitest run --config eval/m5/vitest.config.ts
```

The runner refuses to run if the corpus or `gold.json` is missing, verifies the
corpus manifest through the public entry, replays every gold sample, exercises
the five public tools through a real ToolRuntime over a temporary corpus copy
(content change, line insert, file add, file remove, refresh failure, stale
handles), and writes a machine-readable report to
`node_modules/.cache/m5-eval/reports/acceptance-result.json`.

## Prepare and verify

From the package root:

```bash
node scripts/prepare-m5-env.mjs
node scripts/prepare-m5-env.mjs --verify-only
```

The first command downloads the archive named by `corpus.lock.json` when it is
not already cached, verifies its SHA-256, validates every tar member before
extraction, prepares the complete Zod tree under
`node_modules/.cache/m5-eval/corpus/`, saves the
official root `LICENSE`, and writes a deterministic SHA-256 manifest for
`packages/zod/src`. The script never resolves a tag or branch at runtime.

`--verify-only` is offline: it checks the archive and license checksums, the
prepared corpus marker, and every file in the source manifest. It exits nonzero
if a file was changed, removed, added, or if an archive checksum does not
match. Re-running preparation is idempotent and refuses to use an unmarked
existing corpus directory. A prepared corpus without its manifest is rejected
instead of being used to create a new baseline.

The archive, extracted corpus, license, manifest, reports, and local tool
probes live below `node_modules/.cache/m5-eval/`, which is already ignored by
the package's `node_modules/` rule. Do not edit the locked corpus;
copy it to a temporary directory for refresh or fault-injection work.

## Reproduce without network

After a successful prepare, run:

```bash
node scripts/prepare-m5-env.mjs --verify-only
```

This uses only the cached archive and prepared files. The lock fixes Zod
`v4.4.3` at commit
`1fb56a5c18c27102dbc92260a4007c7732a0ccca`; the archive and license checksums
are recorded in `corpus.lock.json`.

## Local Node matrix and package checks

The prepared environment keeps exact Node binaries under
`node_modules/.cache/m5-eval/tools/`
and does not change `PATH` globally:

```bash
node_modules/.cache/m5-eval/tools/v22.19.0/node/bin/node --version  # v22.19.0
node_modules/.cache/m5-eval/tools/v24.6.0/node/bin/node --version  # v24.6.0
```

For each version, use the local binary and existing package tools for the
offline corpus check, typecheck, and build:

```bash
export PATH="$PWD/node_modules/.cache/m5-eval/tools/v22.19.0/node/bin:$PWD/node_modules/.bin:$PATH"
node scripts/prepare-m5-env.mjs --verify-only
./node_modules/.bin/tsc -b --pretty false
./node_modules/.bin/tsdown --config tsdown.config.ts
```

Replace `v22.19.0` with `v24.6.0` for the second matrix row. The package
entry import check is:

```bash
node --input-type=module -e "const m = await import('./lib/index.js'); if (typeof m.buildIndexP0 !== 'function') throw new Error('missing buildIndexP0'); console.log('package-entry-import ok')"
```

The existing `tests/scripts.spec.ts` legacy smoke scans the package root, while
`node_modules/` is excluded by P0. No cache staging is needed for this test:

```bash
PATH="$PWD/node_modules/.cache/m5-eval/tools/v22.19.0/node/bin:$PWD/node_modules/.bin:$PATH" \
  node_modules/.cache/m5-eval/tools/v22.19.0/node/bin/node \
  ./node_modules/vitest/vitest.mjs run --testTimeout=30000 \
  tests/package-entry.spec.ts tests/scripts.spec.ts
```

The current host's `/usr/bin/pnpm` is present but `pnpm --version` exits with
`unable to open database file`; no global installation or package/lockfile
change was made. The isolated pnpm 11.7.0 tarball is registry-integrity
verified and can be invoked directly with either local Node:

```bash
node_modules/.cache/m5-eval/tools/v22.19.0/node/bin/node \
  node_modules/.cache/m5-eval/tools/pnpm-11.7.0/package/bin/pnpm.cjs --version
node_modules/.cache/m5-eval/tools/v24.6.0/node/bin/node \
  node_modules/.cache/m5-eval/tools/pnpm-11.7.0/package/bin/pnpm.cjs --version
```

Both commands print `11.7.0`; this is the `pnpm-ready` check. Direct `tsc`,
`tsdown`, and Vitest checks above remain reproducible.

The source root used by the later P0 runner is the prepared
`packages/zod/src` directory. The runner should pass the repository commit as
its revision and keep the existing P0 snapshot configuration contract; this
Task 1 document does not create gold samples or acceptance claims.

## Default-retrieval (grep) baseline pilot

`baseline-grep.patterns.json` holds the preregistered probes and `grep-baseline.mjs`
is the harness for the no-model static retrieval comparison between the real
DSH default retrieval tool (`grep` from `@deepseek-ai/dsh-tool-fs-search`) and
this package's `context_*` tools. Both arms run through one real `ToolRuntime`
over a temporary corpus copy; only the subprocess seam is shimmed.

The measured bundle is resolved at run time and recorded in the report as
`grepTool.{entry,version}`. Historical Phase 1 results used the installed DSH
profile's `@deepseek-ai/dsh-tool-fs-search@0.1.3-alpha.2`; that historical
number is unchanged. New shared-harness runs consistently source all DSH host
components from that profile rather than mixing them with package-local 0.1.2
runtime components.

Probes must be frozen before running. `baseline-grep.patterns.json` was frozen
at:

```
45d2bd66baaf9a6525089d6fe1905a48c96ed2d743e048f3be937e64f7e75a1f
```

That hash is the v1 probe set. Post-review, the file is at `schemaVersion: 2`:
source probes that name no symbol now use the content-independent anchor `^`
(v1 used answer-visible keywords such as `string`, the first token of the
`src-05` gold span), and arm scoring is symmetric target-token coverage
(`scoring: symmetric-target-coverage-v3`). Both arms now surface target tokens
through one shared predicate (`harness.mjs` `textSurfacesToken`): identifier-like
names must fall on an identifier boundary (so `en` cannot score inside `then`,
nor `Red` inside `Redux`), while punctuation-bearing specifiers/paths are matched
literally. For symbol relations the structured arm's symbol-resolution round trip
is charged for both latency and model-facing bytes
(`entry.structured.precallBytes`). Source grep `located` requires the hit to
overlap the expected answer span (v3), not merely appear anywhere in the named
file, while the structured source arm must still return the exact bytes — the
two are intentionally not equivalent and the asymmetry is documented. The report
records `probeSchemaVersion`, `probeRevision`, and `scoring`; v1/v2/v3 numbers
are not comparable.

Run:

```bash
node eval/m5/grep-baseline.mjs                     # writes the cached evidence path
node eval/m5/grep-baseline.mjs --out /tmp/verify.json   # ad-hoc verification only
```

The harness writes `node_modules/.cache/m5-eval/reports/baseline-grep.json` with
`probesSha256` and `goldSha256`, so a changed probe file invalidates the result.
Use `--out` to keep a throwaway verification run out of the cached report
directory. It never edits the locked corpus or `gold.json`. This pilot is
**not** M5 acceptance evidence and produces no benefit/ROI claim; see
`doc/m5-baseline-grep-pilot.md` for the findings and their limits.

The harness **authors no dependency edge** on the measured tool: it imports the
already-installed profile `@deepseek-ai/dsh-tool-fs-search` bundle, so running
the baseline does not rewrite the shared root lockfile. Since the host
unification below, Phase 1 sources its `cordis`/`dsh-session`/`dsh-tools`
runtime, sandbox and FS/search stack from the same asserted profile graph as
Phase 2/3 (the shared loader is pinned; `DSH_FS_SEARCH_ENTRY` is no longer
consulted). Historical `baseline-grep.json` was produced before that change on a
mixed host, so its numbers are annotated as such in
`doc/m5-baseline-grep-pilot.md` and require a re-run before being quoted as
current; `--out` keeps such a re-run out of the cached report directory.

## Phase 2 agent comparison

`build-agent-tasks.mjs` projects the frozen `gold.json` into
`agent-tasks.json` (sha256
`a1f359f1b60f06dbdf13592b2712fdab13da2355466e9db99c1cb4f4c07052f4`): 20
natural-language questions with programmatic `answerSpec` graders. It never
calls a tool, and a changed task set invalidates a comparison.

`agent-baseline.mjs` runs three arms against the same frozen corpus, task set,
`ToolRuntime`, model, and budget caps:

| arm | tools |
| --- | --- |
| `default` | `read`, `grep`, `glob` (the shipped DSH read-only retrieval surface) |
| `additive` | `default` + `context_*` |
| `replacement` | `read` + `context_*` (no `grep`/`glob`) |

`harness.mjs` (used by Phase 2, `semantic-probe.mjs` and
`audit-tool-surface.mjs`) sources `Context`, `SessionStore`, `ToolRuntime`, LLM
IDs, storage/domain/workspace, sandbox and FS/search from one DSH profile graph.
It does not honour `DSH_FS_SEARCH_ENTRY`: the asserted profile entry is pinned.
The built `context_*` bundle is loaded from its exact bytes through an in-memory
ESM bridge which remaps its external DSH imports to those same profile module
entries; no generated bridge is written to disk. The remap is applied only at
real import/export specifier positions, and any `@deepseek-ai/*` dependency that
is not itself a host package (currently `@deepseek-ai/schemastery`) is taken
from the copy the host graph already loads, so no shared library is instantiated
twice in one process. The chosen source for each external is recorded under
`externalResolution` (`profile-host` / `host-graph` / `own-tree-main`). Startup
requires one DSH
generation and canonical Cordis/tools/session/LLM peer identities, failing
before any provider call on a mismatch. Dry-run prints, and a formal report
stores, every core module's version, canonical entry/package root, source and
peer identities plus the context bundle hash/remap under `evaluationHost`.

```bash
node eval/m5/build-agent-tasks.mjs                      # regenerate (hash must not change)
node eval/m5/agent-baseline.mjs --dry-run               # no model calls
node eval/m5/agent-baseline.mjs --repeats 3             # confirmatory run
node eval/m5/agent-baseline.mjs --repeats 3 --seed fixed # explicit reproducible schedule seed
```

A complete three-arm run executes repeat-first rather than arm-first. Across
repeats, the arm order rotates as `default/additive/replacement`,
`additive/replacement/default`, then `replacement/default/additive`, repeating
that Latin-square cycle when more repeats are requested. Within each repeat, a
frozen-seed deterministic shuffle supplies one task order shared by all arms.
This counterbalances provider time drift without rebuilding each arm's context
or warm index. `--arm` and `--task` retain their filtering behavior. The report
records the seed and every repeat's actual arm/task order under `schedule`;
`M5_RUN_SEED` is the environment equivalent of `--seed`.

Before any model call, the harness verifies the prepared source tree and every
per-arm temporary copy against the SHA-256-per-file manifest named by
`corpus.lock.json`. Structured arms keep one shared index per arm, but are
configured with `sessionSourceBytes: null`; therefore source reads in an earlier
question cannot consume a later question's Session budget. The report records
this evaluation configuration and the verified lock/manifest hashes.

Provider or harness failures are recorded as failed attempts and excluded from
the completed-run accuracy denominator, as required by the preregistration.
Every model-call detail records whether tool schemas were actually sent. JSON
repair turns retain the ordinary schema context with `tool_choice: none`, so
they cannot launch new retrieval and schema-cost audits need not infer their
request shape from aggregate `modelCalls`.

The provider is the user's own DeepSeek official endpoint. The key is read from
`DEEPSEEK_API_KEY` or `.dsh/.credentials.yaml` (`refs.DEEPSEEK_API_KEY`) into
process memory only; the report records `provider.apiKeySource`, never the
value. Results land in
`node_modules/.cache/m5-eval/reports/agent-comparison.json`. Decision thresholds
were preregistered in `doc/m5-phase2-preregistration.md`; findings and limits are
in `doc/m5-phase2-results.md`.

## Phase 3 — semantic probe (diagnostic, not an arm)

`semantic-probe.mjs` answers a different question from Phase 1/2: **does type
information change the answers, and how much of the frozen gold is an artefact of
the syntactic extraction heuristic?** It produces no accuracy number.

- heuristic side: the REAL product tool (`context_relation_query`) is used to read
  back the extraction layer's own `calls` edges. Nothing is reimplemented.
- semantic side: `ts.createProgram` + `TypeChecker` over the same frozen corpus,
  using the bundled `typescript@5.9.3` (no new dependency, no network, no process).
  For TypeScript, tsserver is a protocol shell around exactly this API, so this is
  the semantic content an "LSP mode" would hand over — the product ships no
  LSP-backed query path (`src/lsp-adapter.ts` is unreachable from the default
  `apply` and only issues `textDocument/documentSymbol`).
- compiler options are resolved from the corpus's own
  `packages/zod/tsconfig.json` via `ts.readConfigFile` + `ts.parseJsonConfigFileContent`
  and frozen into the report (`compiler.options`, `compiler.tsconfigSha256`); root
  files stay the frozen corpus `src` set. Earlier reports used a hand-mirrored
  literal (`strict: false`); a re-run under the corpus options reproduced every
  headline count, so cite the reports that carry the `compiler` block.
- the copied corpus is mounted through the shared `mountCorpus` and byte-verified
  against the frozen manifest before any query runs (same check as Phase 1/2),
  and the evaluation registry is disposed on exit.

```bash
node eval/m5/semantic-probe.mjs                       # writes reports/semantic-probe.json
node eval/m5/semantic-probe.mjs --out /tmp/probe.json
```

Findings and limits: `doc/m5-semantic-probe.md`. Headline: the `declaration` layer
has **zero** semantic divergence (10/10 exact kind mapping), while 100% of `calls`
edges are dangling names with no join key (4,836 edges, 703 names, 1,162 distinct
declarations, 0 joinable), so reverse call queries are structurally impossible.

## Tool-surface audit

`audit-tool-surface.mjs` is a read-only cross-check of the Phase 2 arms. It mounts
the real plugins and reads `ctx.tools.schemas()` back, so the reported tool list is
evidence rather than a label.

```bash
node eval/m5/audit-tool-surface.mjs          # human-readable
node eval/m5/audit-tool-surface.mjs --json   # machine-readable
node eval/m5/audit-tool-surface.mjs --json --out /tmp/tool-surface.json
```

It mounts each corpus copy through the shared `mountCorpus` manifest check and
disposes each arm's registry; `--out` keeps ad-hoc runs out of the cached
`tool-surface.json`.

It establishes three things: the arms expose exactly `read`/`grep`/`glob` (plus
`context_*`), the shipped `grep`/`glob` are a packaged **ripgrep 15.0.0** binary
(`rg --json` / `rg --files`), and the plugin contributes **no** prompt text and
does **not** prescribe priority (its own tool description says "Host grep/read
remain valid alternatives"). It also measures the model-facing tool-definition
surface, because those schemas are re-sent on every request: `default` 1,987
chars, `additive` 8,350, `replacement` 6,755 (structured share 76.2% / 94.2%).
Full write-up: `doc/m5-tool-surface-audit.md`.

## Phase 2b — fairness re-run (v2 wording)

Phase 2 v1 asked nine `source`/`relation` questions in the tested tool's own
vocabulary (`half-open UTF-16 code-unit range`, `padding`/`clamped`,
``List every `calls` relation``), so part of what it measured was "can you
reproduce our request model". Phase 2b rewrites those questions into tool-free
language and changes **no answer**: `build-agent-tasks.mjs` asserts this with

```bash
node eval/m5/build-agent-tasks.mjs --verify-against eval/m5/agent-tasks.v1.json
```

which fails unless all 20 `answerSpec` values are byte-identical to the archived
v1 set and no task was added or dropped.

The task set now carries a `vocabulary` field (`neutral` | `tool-shaped`). The
primary accuracy figure is the `neutral` subset, reported per arm under
`byVocabulary`; the one remaining tool-shaped task (`src-04-empty-offset-range`,
a zero-width range with no plain-language equivalent) is a diagnostic only.

Two other fixes: the system prompt preamble no longer hints at the structured
tools' strengths, and the product's own `systemPrompt` sections are now
collected and forwarded for exactly the tools each arm exposes
(`promptSectionsForwarded` in the report; `findings.forwardedMatrix` in
`reports/tool-surface.json`). Full raw answers are retained as
`detail[].finalText` so a near miss can be re-graded without re-running the model.

```bash
node eval/m5/agent-baseline.mjs --repeats 3 \
  --out node_modules/.cache/m5-eval/reports/agent-comparison-v2.json
```

Results: `doc/m5-phase2b-results.md`. Preregistration: `doc/m5-phase2b-preregistration.md`.

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
`grepTool.{entry,version}`. In this workspace it resolves to
`@deepseek-ai/dsh-tool-fs-search@0.1.3-alpha.2` from the installed DSH profile
(`../../.dsh/profiles/node_modules/`), not the `0.1.2-rc.1` copy that also
exists in the root store.

Probes must be frozen before running. `baseline-grep.patterns.json` was frozen
at:

```
45d2bd66baaf9a6525089d6fe1905a48c96ed2d743e048f3be937e64f7e75a1f
```

Run:

```bash
node eval/m5/grep-baseline.mjs
```

The harness writes `node_modules/.cache/m5-eval/reports/baseline-grep.json` with
`probesSha256` and `goldSha256`, so a changed probe file invalidates the result.
It never edits the locked corpus or `gold.json`. This pilot is **not** M5
acceptance evidence and produces no benefit/ROI claim; see
`doc/m5-baseline-grep-pilot.md` for the findings and their limits.

The harness **authors no dependency edge** on the measured tool: it imports the
real `@deepseek-ai/dsh-tool-fs-search` bundle from the copy already installed in
this workspace (a transitive dependency of the DSH base profile, normally at
`../../.dsh/profiles/node_modules/`), so running the baseline does not rewrite
the shared root `pnpm-lock.yaml`. Set `DSH_FS_SEARCH_ENTRY` to an explicit
`lib/index.js` to override resolution.

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

`lib/harness.mjs` mounts the real product tools from one consistent DSH profile
install (`.dsh/profiles/node_modules/`) — `dsh-sandbox-local`,
`dsh-sandbox-policy`, `dsh-fs-sandbox`, `dsh-fs-observation-policy`,
`dsh-tool-fs` (`read`), `dsh-tool-fs-search` (`grep`/`glob`) — so nothing about
the compared surfaces is a stand-in.

```bash
node eval/m5/build-agent-tasks.mjs                      # regenerate (hash must not change)
node eval/m5/agent-baseline.mjs --dry-run               # no model calls
node eval/m5/agent-baseline.mjs --repeats 3             # confirmatory run
```

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
```

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

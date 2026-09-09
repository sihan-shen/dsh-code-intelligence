# `@han_05/dsh-code-intelligence`

Bounded repository facts and verified source reads for coding agents.

## Status and compatibility

**This branch implements M4 C1–C3 for the optional-cache P0 runtime resource model.**
Main-thread review fixed competing first builds after initialization failure,
isolated query leases from initialization deadlines, and added deterministic
queue/retry/commit/retirement regressions. A bounded injectable lifecycle event
sink is available for programmatic hosts; the default plugin intentionally does
not extend the cross-package session-event contract. See [M3 progress](doc/m3-progress.md).
The planned milestone label is `0.3.0-alpha.3`; **`package.json` remains `0.2.1`**
under the current no-version-change/no-release authorization. These breaking
branch behaviors are not a published `0.2.1` patch or a released alpha.

- Default bundle: five P0 tools, listed below. The cache is disabled by default and is opened only when `cache.enabled` is true in resolved startup settings. Cache failures degrade to the same verified query/source behavior; unconfirmed writes never expose `blockId`.
- Existing V1 programmatic APIs (`createContextCompiler`, `createContextTools`,
  `createCodeIntelligenceTools`, `mountCodeIntelligence`, V1 snapshot/query APIs)
  remain exported. They are **not** a legacy default-plugin mode. Default `apply`
  requires Cordis, ToolRuntime, a registered workspace and a live Session.
- Tested host line: DSH `0.1.2-rc.1`, Cordis `4.0.2`, TypeScript `5.9.3`;
  Node support declaration: `^22.19.0 || >=24`. Tests here ran on Linux/Node 26.
- Local development requires the built P0 `@han_05/dsh-context` contracts
  including `INDEX_POLICY_P0` v2 (M1 contract branch commit `41b5746`). The linked
  package manifest currently says `0.2.1`; this is not evidence that npm provides
  these exports. The unchanged `^0.2.0` dependency range is **not a sufficient
  standalone installation guarantee**. No dependency installation or release is
  performed by this milestone. The cache dependency remains for V1 APIs only.
- **Downstream migration is pending.** `dsh-orchestrator/src/context.ts` consumes
  V1 Context Blocks and block-authorized source; `dsh-eval/src/optimized.ts`
  expects the default plugin to provide a V1 compiler through a lightweight
  non-Cordis mounting context. Neither consumer is migrated here. Their README
  files and parent `v0.2b-readonly` / `v0.2c-context` profile READMEs record the
  required migration. Old profile/evaluator composition is not claimed compatible.

### Native failure transport only

Configure the host ToolRuntime for **Native** presentation. Business errors retain
`isError: true`, `error.info.code` / `error.message`, and the validated
`code/message/details` DTO in namespaced `meta.codeIntelligenceFailure` and model
text content, using public `tools/execute` around hooks and `finalizeContent`.
The bridge is prepended outside existing retry policies; subsequently prepending
a retry outside it is unsupported. Host cancellation, timeout, closed Session,
policy replacement and unknown exceptions keep their host channels.

PTC `run_code` reduces child failures to message-only and **does not support this
structured failure contract**. This package neither changes host transport nor
adds a per-tool Native override. Registry/Session projection/replay tests are
not a full AgentLoop/provider or unchanged-profile acceptance test.

## M3 tools

| Tool | Behavior |
| --- | --- |
| `context_repo_map` | Discover the current `snapshotId` / `indexFingerprint`; path-sorted receipt pages, or exact canonical `path` lookup including JSON/README. `snapshotId` is optional. Direct `path` excludes limit/cursor. |
| `context_symbol_query` | Explicit snapshot; nonblank name (≤256 UTF-8 bytes), exact by default, prefix or explicit fuzzy; kind and directory `pathPrefix` filters; exclusive direct `symbolId` lookup. |
| `context_relation_query` | Explicit snapshot; `from.symbolId` produces contains, `from.path` produces imports/exports/calls. `types` is a set, defaults to all four, and `[]` matches none. |
| `context_expand_source` | Direct snapshot/path/sourceHash verified read; exactly one explicit UTF-16 half-open `offsetRange`, inclusive 1-based `lineRange`, or `wholeFile: true`. No prior block needed. |
| `context_refresh_snapshot` | Queue a bounded full rebuild for the live Session. Candidate construction is isolated and atomically committed; failure/cancellation keeps the active runtime. |

Collection pages default to 20, allow 1–50, and return `truncated/nextCursor`.
Cursor bindings include normalized query, snapshot, actual index fingerprint,
limit and policy. The digest detects corruption, **not forgery**. Successful
responses are ≤65,536 UTF-8 JSON bytes including metadata; oversized pages shrink
without skipping candidates, oversized single items fail `budget-exceeded`.
Optional problem details have an independent 8,192-byte bound. Extraction
summaries cover the query's file scope, not just hits; partial result sources
stay attached to their page. No `totalMatches` estimate is returned.

Exact/prefix match raw case-sensitive names or available lexical qualified labels,
not path substrings. `pathPrefix` is a directory boundary (`src` matches `src/a.ts`,
not `src-other/a.ts`). Fuzzy uses deterministic term/name/path/contains-name scoring;
rank is not identity or semantic confidence. Old symbol handles must belong to
the captured index, even when their hash syntax is valid. IDs are snapshot-local,
not cross-edit locators. See [design](doc/code-intelligence-design.md) and
[query fixtures](tests/p0-query.spec.ts) for the reference ranking rules.

### JSON receipt → source example

```js
context_repo_map({ path: 'config.json' })
// use response.snapshotId and response.items[0].path/sourceHash:
context_expand_source({
  snapshotId: '<returned snapshotId>',
  path: 'config.json',
  sourceHash: '<returned sourceHash>',
  lineRange: { startLine: 1, endLine: 5 }
})
```

Ranges must fit the actual file; no implicit whole-file read or silent shortening.
Lines share the same map as symbol positions: CRLF, LF, CR, U+2028 and U+2029,
including an empty final line after a terminator. Empty offset windows are legal;
surrogate-pair splits are not. Optional `paddingLines` is 0–20 per side, only for
range modes, expanding to full touched lines and clipping padding at file edges.
Explicit `blockId` is checked against the captured workspace/snapshot/index boundary when cache is enabled: missing or corrupt records return `not-found`, stale boundaries return `stale-block`, and unavailable storage returns `cache-unavailable`. Without a block reference, source always uses verified reads and the Session budget.

All agents/root calls within one live Session share a source-success budget:
default **262,144 final JSON bytes**, including source escaping and package metadata,
not host framing. Repeated/overlapping reads count again. The tool adapter checks
and debits atomically before returning; validation/read/serialization/budget
failures do not debit, and errors are not charged. No partial source is returned
to squeeze into a budget. Host post-processing/transport cost is not measured.

## Coverage and non-goals

- TS/JS AST: `.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs`; named function/class/interface/
  type/enum/namespace declarations, variable/destructured bindings and named
  class/interface/enum members, including non-exported/nested declarations.
  Parameters/type parameters, synthetic anonymous declarations and ordinary
  object-literal members are not independent symbols. `complete` means the
  documented extraction coverage, not every language declaration or semantics.
- Contains uses actual retained ancestor IDs. Imports/exports summarize static
  top-level syntax, including type-only edges without runtime-dependency claims.
  Calls are file-level unresolved name candidates, not a call graph. No dynamic
  import/require/import-equals/export=/CommonJS module edges, local module edges,
  `new`, tagged-template or element-access call extraction. No reverse/semantic
  definition/reference/caller navigation. LSP adapter remains experimental and
  **is not invoked by the default runtime**. Host grep/read remain valid choices.
- **M3 lifecycle is implemented:** Session state is idle/initializing/active/closing/closed;
  initialization is shared, refreshes are bounded and serialized, each refresh builds
  its own candidate, and publication is atomic. Queries lease the captured immutable
  runtime, so an older query may finish while a refresh commits; new queries use the
  new snapshot and old snapshot/symbol handles are stale. Read races receive one fresh
  full-build retry; failed/canceled refresh keeps the active runtime. Initialization
  failure can be retried, one waiter can cancel without canceling the shared build,
  and initialization-time refreshes do not reuse the initial candidate. Release waits
  for queued work and leases, then permanently closes that Session. Refresh does not
  reset the Session source budget. Cancellation/deadline remain cooperative; synchronous
  TypeScript parsing cannot be hard-interrupted. `context_refresh_snapshot` is the
  only refresh path; there is no watcher.
- **M4 is not complete:** no P0 cache, block persistence, explicit stale/missing
  block classification, or migrated downstream compiler integration.
- **M5 is not complete:** no fixed real-repository independent gold/edit-refresh
  acceptance or release. No claim of retrieval savings or coding-task benefit;
  benefit status is **not-ready**.
- Workspace registration, containment, excluded paths and hash verification are
  enforced. Snapshot is a receipt view, not a transactionally frozen filesystem
  or historical source archive. Ordinary concurrent edits are supported; malicious
  ancestor-directory replacement isolation is not. This is not a DLP/secret scanner.
- Ignore rules remain bounded picomatch, not full gitignore; negation (`!…`) fails
  initialization explicitly. No repository scripts or Git hooks are executed.

## Configuration and local development

The bundle patch is [`cordis.patch.yml`](cordis.patch.yml). Minimal default-plugin
configuration is `{ deploymentRoot: '.', revision: 'my-revision' }`, resolved
inside each registered Session workspace. Scan limits default to shared
`SNAPSHOT_POLICY_P0`; smaller positive limits and canonical `nestedCheckoutRoots`
are accepted. `sessionSourceBytes` defaults to 262144 (`null` disables only the
cumulative limit; zero permits no source successes). `initializationTimeoutMs`
defaults to 60000, accepts 1–300000, and is cooperative, not a hard synchronous
TypeScript parse deadline. Caller cancellation does not cancel other initialization
waiters. No default filesystem-only mounting bypasses workspace registration.

With already-installed local linked dependencies (avoid workspace-wide install
side effects during this milestone):

```sh
node node_modules/typescript/bin/tsc --noEmit --incremental false --composite false --pretty false
node node_modules/tsdown/dist/run.mjs --out-dir lib --external typescript
node node_modules/vitest/vitest.mjs run
```

For programmatic `createResolverP0` use, every resolved handle must call `done()`
in `finally` so Session release can wait for in-flight cleanup; the tool adapter
already does this. `expandSourceP0` prepares verified data without debiting a
ledger; the default tool adapter owns final JSON accounting.

Package-entry tests execute the built API, not just inspect exports. See
[M3 progress and actual validation results](doc/m3-progress.md) for test commands,
and [M2 task cards and validation history](doc/m2-progress.md) for the prior milestone,
Native integration boundaries and the preserved M1/V1 regression evidence.
The [independent M2 review](doc/m2-review.md) records three reproduced and fixed
control-flow bugs, additional cursor/escaped-JSON/source-range checks, and the
200-test full-suite result. A subsequent [main-thread review](doc/m2-review-round2.md)
fixed the outer Native bridge also misclassifying caller-owned cancellation reasons,
added registry/Unicode-endpoint/reentrant-close regressions, and passed **205 tests**.
This does not certify M4–M5 or downstream migration.

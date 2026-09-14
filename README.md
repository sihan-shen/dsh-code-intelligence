# `@han_05/dsh-code-intelligence`

> Bounded repository context tools for DeepSeek Harness.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`dsh-code-intelligence` gives coding agents a verified, queryable view of a TypeScript or JavaScript repository. It exposes repository facts and targeted source reads without replacing the host agent loop or executing repository code.

## Default tools

| Tool | Purpose |
| --- | --- |
| `context_repo_map` | List repository files or look up one canonical path |
| `context_symbol_query` | Find symbols by exact, prefix, or deterministic fuzzy match |
| `context_relation_query` | Query contains, imports, exports, and file-level call relations |
| `context_expand_source` | Read a verified source range by line, offset, or whole file |
| `context_refresh_snapshot` | Build and atomically activate a fresh repository snapshot |

The default plugin requires a registered workspace and live DSH Session. An optional persistent cache can be enabled through startup settings; cache failures fall back to verified repository reads.

## Guarantees and boundaries

- Snapshot IDs, symbol IDs, paths, and source hashes are checked against the captured repository view.
- Query pages and source reads use explicit size limits; the default per-Session source-success budget is 262,144 final JSON bytes.
- Snapshot refreshes are bounded and isolated: a failed or cancelled refresh leaves the active snapshot unchanged.
- Workspace containment, excluded paths, and source hashes are validated. Repository scripts and Git hooks are never executed.
- The index covers `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, and `.cjs` files. Relations are static, file-level facts, not a semantic call graph.
- Snapshot data is a verified receipt view, not a historical source archive or a DLP scanner.

## Install

Requirements: Node.js `^22.19.0 || >=24` and a DeepSeek Harness installation.

Install the plugin directly from GitHub:

```
dsh plugin --profile web add github:sihan-shen/dsh-code-intelligence
```

Minimal plugin configuration:

```js
{ deploymentRoot: '.', revision: 'my-revision' }
```

## Local development

Requirements: Node.js `^22.19.0 || >=24` and pnpm `11.7.0`.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:package-entry
```

The package also exports programmatic P0 and V1 APIs, including `createContextCompiler`, `createContextTools`, `createCodeIntelligenceTools`, and `mountCodeIntelligence`. See the design document for lifecycle and API details.

## Documentation

- [`doc/code-intelligence-design.md`](doc/code-intelligence-design.md): architecture, contracts, lifecycle, and query semantics
- [`doc/m3-progress.md`](doc/m3-progress.md), [`doc/m4-progress.md`](doc/m4-progress.md): implementation and validation notes
- [`doc/m5-progress.md`](doc/m5-progress.md): current acceptance decisions and release evidence

## License

Distributed under the [MIT License](LICENSE).

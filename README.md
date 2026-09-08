# `@han_05/dsh-code-intelligence`

An optional DSH bundle for bounded repository snapshots, symbol indexing,
context compilation, and code-intelligence tools.

## Status and compatibility

- Version: `0.2.1`
- Parent repository: [DSH-Plugins](https://github.com/sihan-shen/DS-Plugins)
- DSH dependency line: `0.1.2-rc.1` (`@deepseek-ai/dsh-subprocess` and
  `@deepseek-ai/dsh-tools`)
- Cordis peer dependency: `4.0.2`
- DSH source availability: target packages are reviewed at upstream commit [`a66e4702047846cdaa10c66c9d3df3951f5ea70d`](https://github.com/deepseek-ai/DeepSeek-Harness/commit/a66e4702047846cdaa10c66c9d3df3951f5ea70d).
- Shared plugin dependencies: `@han_05/dsh-context` and
  `@han_05/dsh-context-cache`, both `^0.2.1`
- Availability: optional; enabled by the `v0.2b-readonly` and
  `v0.2c-context` profiles, not included in the v0.1 profile.

## Install

The plugin is published to npm as `@han_05/dsh-code-intelligence`.
Install it together with its DSH host dependencies:

```bash
pnpm add @han_05/dsh-code-intelligence
```

## Install

When published, install the plugin together with its DSH host dependencies:

```bash
pnpm add @han_05/dsh-code-intelligence
```

The bundle is loaded by the host through the included
[`cordis.patch.yml`](./cordis.patch.yml). It registers repository snapshot,
symbol, context, and LSP-backed tools. Snapshot roots and limits are supplied
by the host profile; the plugin does not grant provider access or modify files
in the analyzed repository.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm run test:package-entry
```

The standalone package depends on the versioned context contracts
`@han_05/dsh-context` and `@han_05/dsh-context-cache`, which are published to
npm as `^0.2.1`. Install them alongside the plugin outside the monorepo.

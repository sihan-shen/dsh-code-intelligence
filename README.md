# `@ds-plugins/dsh-code-intelligence`

An optional DSH bundle for bounded repository snapshots, symbol indexing,
context compilation, and code-intelligence tools.

## Status and compatibility

- Parent repository: [DSH-Plugins](https://github.com/sihan-shen/DS-Plugins)
- DSH dependency line: `0.1.1-rc.2` (`@deepseek-ai/dsh-subprocess` and
  `@deepseek-ai/dsh-tools`)
- Cordis peer dependency: `4.0.1`
- Shared plugin dependencies: `@ds-plugins/dsh-context` and
  `@ds-plugins/dsh-context-cache`, both `0.2.0`
- Availability: optional; enabled by the `v0.2b-readonly` and
  `v0.2c-context` profiles, not included in the v0.1 profile, and not yet
  published to npm. Use a local checkout or packed artifact until the
  dependency line is published.

## Install

When published, install the plugin together with its DSH host dependencies:

```bash
pnpm add @ds-plugins/dsh-code-intelligence
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

The standalone package depends on the versioned context contracts in the
parent repository. They must be published or provided from a local workspace
before installing the plugin outside the monorepo.

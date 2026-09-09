import { defineConfig } from 'tsdown'

/**
 * Package-local equivalent of the Harness client preset. The upstream preset
 * is a workspace build helper, not a publishable dependency, so this package
 * keeps only the closure-factory contract needed by the Native client loader.
 */
const clientExternals = new Set([
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-locale/client',
])

const node = {
  name: '@han_05/dsh-code-intelligence',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: true,
  clean: true,
  external: ['typescript'],
}

const client = {
  name: '@han_05/dsh-code-intelligence/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: [...clientExternals],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('@han_05/dsh-code-intelligence')}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([node, client])

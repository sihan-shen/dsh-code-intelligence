import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import * as plugin from '@han_05/dsh-code-intelligence'

it('exposes the built plugin entry and package metadata', async () => {
  expect(plugin.name).toBe('dsh-code-intelligence')
  expect(typeof plugin.apply).toBe('function')
  expect(plugin.Config).toBeDefined()

  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    exports: Record<string, unknown>
    files: string[]
  }
  expect(packageJson.exports['.']).toBeDefined()
  expect(packageJson.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
  expect(packageJson.files).toContain('README.md')
})

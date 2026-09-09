import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('emits the Native loader factory and keeps shared client modules external', async () => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  expect(bundle).toContain('window.__ModuleLoader__.load')
  expect(bundle).toContain('factory: (require)')
  expect(bundle).toContain('require("react")')
  expect(bundle).not.toContain('dsh-client-ui-settings')
  expect(bundle).not.toContain('dsh-client-ui-slots')
})

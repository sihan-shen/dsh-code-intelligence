import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const scriptUrls = [
  new URL('../scripts/smoke-m2.mjs', import.meta.url),
  new URL('../scripts/benchmark-p0-ancestor-names.mjs', import.meta.url),
]

describe('built-entry scripts', () => {
  it('reference the generated JavaScript package entry', async () => {
    const scripts = await Promise.all(scriptUrls.map(url => readFile(url, 'utf8')))
    for (const script of scripts) {
      expect(script).toContain('../lib/index.js')
      expect(script).not.toContain('../lib/index.mjs')
    }
  })

  it('runs the legacy working-tree smoke against the built entry', async () => {
    const { stdout } = await execFileAsync(process.execPath, [scriptUrls[0].pathname], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
    expect(JSON.parse(stdout)).toMatchObject({
      kind: 'local-working-tree-only',
      checks: [
        'package.json receipt/source',
        'repoMapP0 exact location/source',
        'imports',
        'contains',
      ],
    })
  }, 30_000)
})

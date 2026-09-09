import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemorySettings } from './fixtures/memory-settings.ts'
import { apply, CodeIntelligenceSettingsSchema } from '../src/plugin.ts'

async function bootSettings(doc: Record<string, unknown> = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(MemorySettings, { doc })
  return { ctx, fiber, settings: ctx.get('settings') as MemorySettings }
}

describe('code-intelligence Host settings', () => {
  it('registers the exact namespace with restart semantics and closed defaults', async () => {
    const { ctx, fiber, settings } = await bootSettings()
    const owner = await ctx.plugin({
      inject: ['settings'],
      apply: async (child: Context) => {
        const scope = child.settings.register('code-intelligence', CodeIntelligenceSettingsSchema, {
          base: { cache: { enabled: false, maxEntries: 42, maxBytes: 4096, lockTimeoutMs: 17 } },
          applies: 'restart',
        })
        expect(scope.get()).toEqual({ cache: { enabled: false, maxEntries: 42, maxBytes: 4096, lockTimeoutMs: 17 } })
      },
    })
    const descriptor = settings.describe().find(item => item.ns === 'code-intelligence')
    expect(descriptor?.applies).toBe('restart')
    expect(descriptor?.value).toEqual({ cache: { enabled: false, maxEntries: 42, maxBytes: 4096, lockTimeoutMs: 17 } })
    await owner.dispose()
    await fiber.dispose()
  })

  it('accepts the schema boundaries and rejects invalid cache limits', async () => {
    const { ctx, fiber, settings } = await bootSettings()
    const owner = await ctx.plugin({
      inject: ['settings'],
      apply: (child: Context) => {
        child.settings.register('code-intelligence', CodeIntelligenceSettingsSchema, { applies: 'restart' })
      },
    })
    const scope = settings.register('test-code-intelligence', CodeIntelligenceSettingsSchema)
    await expect(scope.update({ cache: { enabled: true, maxEntries: 0 } })).rejects.toThrow()
    await expect(scope.update({ cache: { enabled: true, maxBytes: 268_435_457 } })).rejects.toThrow()
    await expect(scope.update({ cache: { enabled: true, lockTimeoutMs: -1 } })).rejects.toThrow()
    await owner.dispose()
    await fiber.dispose()
  })
})

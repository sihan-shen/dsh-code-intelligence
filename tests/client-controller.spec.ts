import { describe, expect, it, vi } from 'vitest'
import {
  codeIntelligenceDraftValid,
  codeIntelligenceDraftEqual,
  codeIntelligenceCanReset,
  codeIntelligenceMutations,
  codeIntelligenceSavePlan,
  parseCodeIntelligenceInteger,
  type CodeIntelligenceDraft,
} from '../src/client/card.tsx'

const defaults: CodeIntelligenceDraft = {
  enabled: false,
  maxEntries: '10000',
  maxBytes: '268435456',
  lockTimeoutMs: '250',
}

describe('code-intelligence settings controller folds', () => {
  it('allows resetting saved non-default values without an unrelated edit', () => {
    const saved = { ...defaults, enabled: true }
    expect(codeIntelligenceCanReset(saved, defaults, true, false)).toBe(true)
    expect(codeIntelligenceCanReset(defaults, defaults, true, false)).toBe(false)
    expect(codeIntelligenceCanReset(saved, defaults, false, false)).toBe(false)
    expect(codeIntelligenceCanReset(saved, defaults, true, true)).toBe(false)
  })

  it('compares accepted numeric values rather than draft spelling', () => {
    expect(codeIntelligenceDraftEqual({ ...defaults, maxEntries: '0020' }, { ...defaults, maxEntries: '20' })).toBe(true)
    expect(codeIntelligenceDraftEqual({ ...defaults, maxEntries: '0020' }, defaults)).toBe(false)
    expect(codeIntelligenceDraftEqual({ ...defaults, maxEntries: '' }, { ...defaults, maxEntries: '' })).toBe(false)
  })

  it('validates whole-number drafts and refuses invalid saves', () => {
    expect(parseCodeIntelligenceInteger('0', 1)).toBeUndefined()
    expect(parseCodeIntelligenceInteger('1.5', 1)).toBeUndefined()
    expect(parseCodeIntelligenceInteger('10000', 1, 10000)).toBe(10000)
    expect(codeIntelligenceDraftValid({ ...defaults, maxBytes: '268435457' })).toBe(false)
    expect(codeIntelligenceSavePlan({ ...defaults, maxEntries: 'bad' }, defaults, 3)).toBeUndefined()
  })

  it('creates one atomic, revision-fenced mutation and unsets reset fields', () => {
    const draft = { ...defaults, enabled: true, maxEntries: '20' }
    const plan = codeIntelligenceSavePlan(draft, defaults, 11)
    expect(plan?.revision).toBe(11)
    expect(plan?.mutations).toEqual([
      { op: 'set', path: ['cache', 'enabled'], value: true },
      { op: 'set', path: ['cache', 'maxEntries'], value: 20 },
      { op: 'unset', path: ['cache', 'maxBytes'] },
      { op: 'unset', path: ['cache', 'lockTimeoutMs'] },
    ])
  })

  it('represents checkbox edits and unavailable/write failures without optimistic persistence', async () => {
    const scope = {
      getSnapshot: vi.fn(() => ({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' })),
      mutate: vi.fn(),
    }
    expect(scope.getSnapshot().writable).toBe(false)
    expect(codeIntelligenceMutations({ ...defaults, enabled: true })).toHaveLength(4)
    expect(scope.mutate).not.toHaveBeenCalled()
    await expect(Promise.reject(new Error('revision conflict'))).rejects.toThrow('revision conflict')
  })
})

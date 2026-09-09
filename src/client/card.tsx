import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
import type { CacheConfigP0 } from '../p0-runtime.js'
import type { CodeIntelligenceSettings } from '../plugin.js'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

const NS = 'code-intelligence'
const LOCALE_NS = 'code-intelligence'
const DEFAULTS = Object.freeze({
  enabled: false,
  maxEntries: 10_000,
  maxBytes: 268_435_456,
  lockTimeoutMs: 250,
}) satisfies CacheConfigP0

type CodeIntelligenceLocaleKey =
  | 'title' | 'description' | 'enabled' | 'maxEntries' | 'maxBytes' | 'lockTimeoutMs'
  | 'restartNotice' | 'save' | 'discard' | 'reset' | 'saving' | 'invalid' | 'unsaved' | 'saveFailed'

type Draft = {
  enabled: boolean
  maxEntries: string
  maxBytes: string
  lockTimeoutMs: string
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: { children?: never } }
  }
  interface LocaleNamespaceMap {
    'code-intelligence': CodeIntelligenceLocaleKey
  }
}

const en: Record<CodeIntelligenceLocaleKey, string> = {
  title: 'Code intelligence',
  description: 'Optional bounded cache for repository projections and context blocks.',
  enabled: 'Enable cache',
  maxEntries: 'Maximum entries',
  maxBytes: 'Maximum bytes',
  lockTimeoutMs: 'Lock timeout (ms)',
  restartNotice: 'Changes apply after restarting the host. Cache generation does not change at runtime.',
  save: 'Save', discard: 'Discard', reset: 'Restore defaults', saving: 'Saving…', invalid: 'Enter a valid whole number.', unsaved: 'Unsaved',
  saveFailed: 'The settings changed elsewhere or the host rejected these values.',
}
const zh: Record<CodeIntelligenceLocaleKey, string> = {
  title: '代码智能',
  description: '用于仓库投影和上下文 block 的可选有界缓存。',
  enabled: '启用缓存',
  maxEntries: '最大条目数',
  maxBytes: '最大字节数',
  lockTimeoutMs: '锁超时（毫秒）',
  restartNotice: '修改将在重启宿主后生效。运行期间不会切换 cache generation。',
  save: '保存', discard: '放弃修改', reset: '恢复默认', saving: '保存中…', invalid: '请输入有效的整数。', unsaved: '未保存',
  saveFailed: '设置已在其他位置变更，或宿主拒绝了这些值。',
}

function cacheOf(scope: SettingsScope<CodeIntelligenceSettings>): CacheConfigP0 | undefined {
  return scope.getSnapshot().value?.cache
}

function draftOf(scope: SettingsScope<CodeIntelligenceSettings>): Draft {
  const cache = cacheOf(scope) ?? DEFAULTS
  return {
    enabled: cache.enabled,
    maxEntries: String(cache.maxEntries),
    maxBytes: String(cache.maxBytes),
    lockTimeoutMs: String(cache.lockTimeoutMs),
  }
}

function baseDraftOf(scope: SettingsScope<CodeIntelligenceSettings>): Draft {
  const cache = (scope.getSnapshot().base as Partial<CodeIntelligenceSettings> | undefined)?.cache ?? DEFAULTS
  return {
    enabled: cache.enabled ?? DEFAULTS.enabled,
    maxEntries: String(cache.maxEntries ?? DEFAULTS.maxEntries),
    maxBytes: String(cache.maxBytes ?? DEFAULTS.maxBytes),
    lockTimeoutMs: String(cache.lockTimeoutMs ?? DEFAULTS.lockTimeoutMs),
  }
}

function integer(value: string, minimum: number, maximum?: number): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || (maximum !== undefined && parsed > maximum)) return undefined
  return parsed
}

function CodeIntelligenceCard(props: PropsRuntime<'settings.plugin.item'> & PropsLocale<typeof LOCALE_NS> & { scope: SettingsScope<CodeIntelligenceSettings> }) {
  const { t, scope } = props
  const snapshot = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
  const [draft, setDraft] = useState<Draft>(() => draftOf(scope))
  const [revision, setRevision] = useState<number | undefined>(() => snapshot.revision)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!dirty && !saving && snapshot.status === 'ready') {
      setDraft(draftOf(scope))
      setRevision(snapshot.revision)
    }
  }, [dirty, saving, scope, snapshot])

  if (snapshot.status !== 'ready') return null

  const edit = (patch: Partial<Draft>) => {
    setDraft(previous => ({ ...previous, ...patch }))
    setDirty(true)
    setFailed(false)
  }
  const values = {
    maxEntries: integer(draft.maxEntries, 1, 10_000),
    maxBytes: integer(draft.maxBytes, 1, 268_435_456),
    lockTimeoutMs: integer(draft.lockTimeoutMs, 0),
  }
  const valid = values.maxEntries !== undefined && values.maxBytes !== undefined && values.lockTimeoutMs !== undefined

  const save = async () => {
    if (!dirty || !valid || saving) return
    const maxEntries = values.maxEntries
    const maxBytes = values.maxBytes
    const lockTimeoutMs = values.lockTimeoutMs
    if (maxEntries === undefined || maxBytes === undefined || lockTimeoutMs === undefined) return
    setSaving(true)
    setFailed(false)
    try {
      await scope.mutate([
        { op: 'set', path: ['cache', 'enabled'], value: draft.enabled },
        { op: 'set', path: ['cache', 'maxEntries'], value: maxEntries },
        { op: 'set', path: ['cache', 'maxBytes'], value: maxBytes },
        { op: 'set', path: ['cache', 'lockTimeoutMs'], value: lockTimeoutMs },
      ], revision)
      const accepted = draftOf(scope)
      if (JSON.stringify(accepted) !== JSON.stringify(draft)) setFailed(true)
      else {
        setDirty(false)
        setRevision(scope.getSnapshot().revision)
      }
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const discard = () => {
    setDraft(draftOf(scope))
    setRevision(scope.getSnapshot().revision)
    setDirty(false)
    setFailed(false)
  }
  const reset = () => {
    setDraft(baseDraftOf(scope))
    setDirty(true)
    setFailed(false)
  }
  const number = (field: 'maxEntries' | 'maxBytes' | 'lockTimeoutMs', label: string) => (
    <label style={styles.field}>
      <span>{label}</span>
      <input
        type="number"
        min={field === 'lockTimeoutMs' ? 0 : 1}
        step={1}
        value={draft[field]}
        disabled={!snapshot.writable || saving}
        onChange={(event: ChangeEvent<HTMLInputElement>) => edit({ [field]: event.target.value })}
      />
    </label>
  )

  return (
    <section style={styles.card} aria-label={t('title')}>
      <h3 style={styles.title}>{t('title')}</h3>
      <p style={styles.description}>{t('description')}</p>
      <label style={styles.check}>
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={!snapshot.writable || saving}
          onChange={(event: ChangeEvent<HTMLInputElement>) => edit({ enabled: event.target.checked })}
        />
        <span>{t('enabled')}</span>
      </label>
      {number('maxEntries', t('maxEntries'))}
      {number('maxBytes', t('maxBytes'))}
      {number('lockTimeoutMs', t('lockTimeoutMs'))}
      {!valid ? <p role="alert">{t('invalid')}</p> : null}
      <p role="note">{t('restartNotice')}</p>
      {dirty ? <p role="status">{t('unsaved')}</p> : null}
      {failed ? <p role="alert">{t('saveFailed')}</p> : null}
      <div style={styles.actions}>
        <button type="button" disabled={!dirty || saving} onClick={reset}>{t('reset')}</button>
        <button type="button" disabled={!dirty || saving} onClick={discard}>{t('discard')}</button>
        <button type="button" disabled={!dirty || !valid || saving || !snapshot.writable} onClick={() => { void save() }}>{saving ? t('saving') : t('save')}</button>
      </div>
    </section>
  )
}

const styles = {
  card: { display: 'grid', gap: '8px', padding: '16px', border: '1px solid var(--dsw-color-border, #ccc)', borderRadius: '8px' },
  title: { margin: 0 }, description: { margin: 0 }, check: { display: 'flex', gap: '8px', alignItems: 'center' },
  field: { display: 'grid', gap: '4px' }, actions: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
} as const

export const inject = ['slots', 'locale', 'settingsScope']

export function apply(ctx: Context & {
  readonly slots: {
    inject: (key: 'settings.plugin.item', callback: () => unknown) => unknown
    register: (options: unknown, component: unknown) => () => void
  }
  readonly locale: {
    register: (namespace: string, dictionaries: { en: Record<string, string>; zh: Record<string, string> }) => () => void
  }
  readonly settingsScope: { bind<T>(spec: { namespace: string }): SettingsScope<T> }
}): void {
  const scope = ctx.settingsScope.bind<CodeIntelligenceSettings>({ namespace: NS })
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'code-intelligence: client locale')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NS,
    locale: LOCALE_NS,
    inject: () => ({ scope }),
  }, CodeIntelligenceCard))
}

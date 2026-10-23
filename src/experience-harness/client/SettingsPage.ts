import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ExperienceModelSettings } from '../settings.ts'
import type { MemorySettingsLocaleKey } from './locales.ts'

export interface MemorySettingsSection {
  readonly modelSettings?: ExperienceModelSettings
  readonly extractionMode?: 'harness' | 'api'
}

export interface MemorySettingsFace {
  hooks: { memorySettings: ConfigForm<MemorySettingsSection> }
  saveSettings(settings: ExperienceModelSettings, revision: number | undefined): Promise<boolean>
  describeCredential(reference: string): Promise<{ configured: boolean; writable: boolean } | undefined>
  saveCredential(reference: string, value: string): Promise<boolean>
}

/** Public slot owner props plus the page's explicitly injected observer and actions. */
type Props = PluginConfigViewProps & Omit<MemorySettingsFace, 'hooks'> & {
  t(key: MemorySettingsLocaleKey): string
  useMemorySettings<T>(selector: (snapshot: ConfigFormSnapshot<MemorySettingsSection>) => T): T
}
type Draft = { mode: ExperienceModelSettings['mode']; provider: string; model: string; reasoningEffort: string; endpoint: string; apiKeyRef: string }
const DEFAULT_REFERENCE = 'DSH_EXPERIENCE_API_KEY'
const referencePattern = /^[A-Za-z_][A-Za-z0-9_]*$/
const empty = (): Draft => ({ mode: 'inherit', provider: '', model: '', reasoningEffort: '', endpoint: '', apiKeyRef: '' })
const fromSection = (value: MemorySettingsSection | undefined): Draft => {
  const settings = value?.modelSettings
  return { mode: settings?.mode ?? 'inherit', provider: settings?.provider ?? '', model: settings?.model ?? '',
    reasoningEffort: settings?.reasoningEffort ?? '', endpoint: settings?.endpoint ?? '', apiKeyRef: settings?.apiKeyRef ?? '' }
}
const inputStyle: CSSProperties = { font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid #8886', borderRadius: 7, padding: '9px 11px', width: '100%', boxSizing: 'border-box' }
const hintStyle: CSSProperties = { margin: '5px 0 0', fontSize: 13, lineHeight: 1.5, opacity: 0.75 }
const labelStyle: CSSProperties = { display: 'grid', gap: 6, fontSize: 14 }

/** Explicit allowlist guarantees that key drafts never become settings mutations. */
export function settingsFromDraft(draft: Draft, hasNewKey: boolean): ExperienceModelSettings | undefined {
  if (draft.mode === 'inherit') return { mode: 'inherit' }
  const model = draft.model.trim()
  if (!model || /[\r\n\0]/.test(model)) return undefined
  if (draft.mode === 'harness') {
    const provider = draft.provider.trim(), reasoningEffort = draft.reasoningEffort.trim()
    if (!provider || /[\r\n\0]/.test(provider + reasoningEffort)) return undefined
    return { mode: 'harness', provider, model, ...reasoningEffort ? { reasoningEffort } : {} }
  }
  if (draft.mode !== 'api') return undefined
  const endpoint = draft.endpoint.trim(), apiKeyRef = draft.apiKeyRef.trim() || (hasNewKey ? DEFAULT_REFERENCE : '')
  try {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\r\n\0]/.test(endpoint)) return undefined
  } catch { return undefined }
  if (apiKeyRef && !referencePattern.test(apiKeyRef)) return undefined
  return { mode: 'api', endpoint, model, ...apiKeyRef ? { apiKeyRef } : {} }
}

/** Staged, revision-fenced settings with a write-only credential input. */
export function MemorySettingsPage(props: Props) {
  const { t } = props
  const state = props.useMemorySettings(snapshot => snapshot)
  const [draft, setDraft] = useState<Draft>(empty)
  const [keyDraft, setKeyDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<MemorySettingsLocaleKey>()
  const [credential, setCredential] = useState<{ configured: boolean; writable: boolean }>()
  const [credentialLoading, setCredentialLoading] = useState(false)
  const revision = useRef<number | undefined>(undefined)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!dirty && !saving && state.status === 'ready') {
      setDraft(fromSection(state.value)); revision.current = state.revision
    }
  }, [state.revision, state.status, state.value, dirty, saving])
  const reference = draft.apiKeyRef.trim() || (keyDraft ? DEFAULT_REFERENCE : '')
  useEffect(() => {
    let current = true
    setCredential(undefined)
    if (draft.mode !== 'api' || !reference || !referencePattern.test(reference)) { setCredentialLoading(false); return }
    setCredentialLoading(true)
    void props.describeCredential(reference).then(value => { if (current) setCredential(value) })
      .catch(() => { if (current) setCredential(undefined) })
      .finally(() => { if (current) setCredentialLoading(false) })
    return () => { current = false }
  }, [reference, draft.mode, props.describeCredential])
  const reload = (): void => { setDraft(fromSection(state.value)); setKeyDraft(''); setDirty(false); setNotice(undefined); revision.current = state.revision }
  const edit = (field: Exclude<keyof Draft, 'mode'>, value: string): void => { setDraft(previous => ({ ...previous, [field]: value })); setDirty(true); setNotice(undefined) }
  const save = async (): Promise<void> => {
    if (saving || !dirty || !state.writable) return
    const settings = settingsFromDraft(draft, keyDraft.length > 0)
    if (!settings) { setNotice('invalid'); return }
    if (state.revision !== revision.current) { setNotice('changed'); return }
    setSaving(true); setNotice(undefined)
    let wroteCredential = false
    try {
      if (settings.mode === 'api' && keyDraft) {
        if (!settings.apiKeyRef || !await props.saveCredential(settings.apiKeyRef, keyDraft)) { if (alive.current) setNotice('credentialFailed'); return }
        wroteCredential = true
        if (alive.current) { setKeyDraft(''); setCredential({ configured: true, writable: true }); setDraft(previous => ({ ...previous, apiKeyRef: settings.apiKeyRef! })) }
      }
      const accepted = await props.saveSettings(settings, revision.current)
      if (alive.current) {
        if (accepted) { setDirty(false); setNotice('saved') }
        else setNotice(wroteCredential ? 'credentialSaved' : 'failed')
      }
    } catch { if (alive.current) setNotice(wroteCredential ? 'credentialSaved' : 'failed') }
    finally { if (alive.current) setSaving(false) }
  }
  if (props.view === 'summary') return t('description')
  if (state.status !== 'ready') return h('p', { role: 'status' }, t(state.status === 'loading' ? 'loading' : 'unavailable'))
  const disabled = saving || !state.writable
  const field = (name: Exclude<keyof Draft, 'mode'>, label: MemorySettingsLocaleKey, hint?: MemorySettingsLocaleKey, type = 'text') => h('label', { key: name, style: labelStyle },
    h('span', {}, t(label)), h('input', { id: `experience-model-${name}`, type, value: draft[name], disabled, style: inputStyle,
      onChange: (event: ChangeEvent<HTMLInputElement>) => { edit(name, event.target.value) }, autoComplete: 'off', spellCheck: false }),
    hint ? h('span', { style: hintStyle }, t(hint)) : null)
  const controls = draft.mode === 'harness' ? [field('provider', 'provider', 'providerHint'), field('model', 'model'), field('reasoningEffort', 'reasoning', 'reasoningHint')]
    : draft.mode === 'api' ? [field('endpoint', 'endpoint', 'endpointHint', 'url'), field('model', 'model'), field('apiKeyRef', 'reference', 'referenceHint'),
      h('label', { key: 'key', style: labelStyle }, h('span', {}, t('apiKey')), h('input', { id: 'experience-model-api-key', type: 'password', value: keyDraft,
        autoComplete: 'new-password', spellCheck: false, disabled: disabled || credential?.writable === false, style: inputStyle,
        onChange: (event: ChangeEvent<HTMLInputElement>) => { setKeyDraft(event.target.value); setDirty(true); setNotice(undefined) } }),
      h('span', { style: hintStyle }, t('apiKeyHint')),
      h('span', { style: hintStyle, role: 'status' }, t(!reference ? 'anonymous' : credentialLoading ? 'checking' : credential ? credential.configured ? 'configured' : 'missing' : 'statusUnavailable')))] : []
  return h('section', { style: { display: 'grid', gap: 18, maxWidth: 700 }, 'aria-label': t('title') },
    h('div', {}, h('h3', { style: { margin: '0 0 6px' } }, t('title')), h('p', { style: hintStyle }, t('description'))),
    !state.writable ? h('p', { role: 'status' }, t('readOnly')) : null,
    h('label', { style: labelStyle }, h('span', {}, t('mode')), h('select', { id: 'experience-model-mode', value: draft.mode, disabled, style: inputStyle,
      onChange: (event: ChangeEvent<HTMLSelectElement>) => { setDraft(previous => ({ ...previous, mode: event.target.value as Draft['mode'] })); setKeyDraft(''); setDirty(true); setNotice(undefined) } },
    ...(['inherit', 'harness', 'api'] as const).map(mode => h('option', { key: mode, value: mode }, t(mode))))),
    draft.mode === 'inherit' ? h('p', { style: hintStyle }, t(state.value?.extractionMode === 'api' ? 'legacyHint' : 'inheritHint')) : null,
    ...controls,
    notice ? h('p', { role: 'status', style: { margin: 0, fontSize: 14 } }, t(notice)) : null,
    h('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
      h('button', { type: 'button', disabled: disabled || !dirty || !settingsFromDraft(draft, keyDraft.length > 0), onClick: () => { void save() }, style: { ...inputStyle, width: 'auto', cursor: 'pointer' } }, t(saving ? 'saving' : 'save')),
      dirty ? h('button', { type: 'button', disabled: saving, onClick: reload, style: { ...inputStyle, width: 'auto', cursor: 'pointer' } }, t('reload')) : null))
}

import { createElement as h, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { BrandMark } from './Brand.ts'
import type { KylinMemoryData, KylinMemoryItem } from './api.ts'
import type { KylinMemoryLocaleKey } from './locales.ts'

/** Callbacks injected by the apply closure; components never see ctx. */
export interface MemoryPanelFace {
  list(sessionId: string, signal?: AbortSignal): Promise<KylinMemoryData>
  search(sessionId: string, query: string, signal?: AbortSignal): Promise<KylinMemoryData>
}

type Props = PropsRuntime<'conversation.session.header.utilities'> & MemoryPanelFace & {
  t(key: KylinMemoryLocaleKey): string
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

const headerButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 28,
  padding: '0 10px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
}

const panelStyle: CSSProperties = {
  position: 'fixed',
  top: 64,
  right: 16,
  bottom: 24,
  width: 360,
  maxWidth: 'calc(100vw - 88px)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  zIndex: 80,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 14,
  boxShadow: 'var(--dsw-elevation-panel)',
}

const iconButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  display: 'inline-grid',
  placeItems: 'center',
  border: 0,
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 16,
}

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 32,
  boxSizing: 'border-box',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '0 10px',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-base)',
  font: 'inherit',
  fontSize: 13,
}

const smallButtonStyle: CSSProperties = {
  height: 32,
  padding: '0 11px',
  border: 0,
  borderRadius: 8,
  background: 'var(--kylin-action)',
  color: 'var(--dsw-alias-label-primary-foreground)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 13,
}

const quietButtonStyle: CSSProperties = {
  ...smallButtonStyle,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
}

const rowStyle: CSSProperties = {
  width: '100%',
  display: 'grid',
  gap: 5,
  padding: '11px 12px',
  textAlign: 'start',
  border: 0,
  borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
}

const codeStyle: CSSProperties = {
  fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
}

function statusKey(status: string): KylinMemoryLocaleKey | undefined {
  if (status === 'active') return 'statusActive'
  if (status === 'superseded') return 'statusSuperseded'
  if (status === 'retracted') return 'statusRetracted'
  if (status === 'forgotten') return 'statusForgotten'
  return undefined
}

function modeKey(mode: KylinMemoryData['mode']): KylinMemoryLocaleKey {
  if (mode === 'semantic') return 'modeSemantic'
  if (mode === 'lexical') return 'modeLexical'
  return 'modeNone'
}

function errorKey(code: string | undefined): KylinMemoryLocaleKey {
  if (code === 'session-not-found') return 'errorSession'
  if (code === 'forbidden') return 'errorForbidden'
  if (code === 'internal') return 'errorInternal'
  return 'error'
}

function formatDate(value: number | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
  } catch {
    return new Date(value).toISOString()
  }
}

/** Session-scoped launcher and read-only drawer for the current conversation. */
export function MemoryPanel(props: Props) {
  const { t, sessionId } = props
  const id = String(sessionId)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<readonly KylinMemoryItem[]>([])
  const [mode, setMode] = useState<KylinMemoryData['mode']>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<LoadStatus>('idle')
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [searched, setSearched] = useState(false)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const launcherRef = useRef<HTMLButtonElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  const read = async (kind: 'list' | 'search', text?: string): Promise<void> => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setStatus('loading')
    setError(undefined)
    try {
      const data = kind === 'search'
        ? await props.search(id, text ?? '', controller.signal)
        : await props.list(id, controller.signal)
      if (controller.signal.aborted) return
      setItems(data.items)
      setMode(data.mode)
      setSearched(kind === 'search')
      setStatus('ready')
      setSelected(undefined)
    } catch (cause: unknown) {
      if (controller.signal.aborted) return
      setStatus('error')
      setError(cause instanceof Error ? cause.name : undefined)
    }
  }

  useEffect(() => {
    if (!open) return
    void read('list')
    return () => { abortRef.current?.abort() }
  // The drawer reads once per open/session; `read` uses the latest props from this render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open])

  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : launcherRef.current
      closeRef.current?.focus()
      return
    }
    restoreRef.current?.focus()
    restoreRef.current = null
  }, [open])

  const selectedItem = items.find(item => item.id === selected)
  const submit = (event: { preventDefault(): void }): void => {
    event.preventDefault()
    const text = query.trim()
    void read(text.length > 0 ? 'search' : 'list', text)
  }
  const clear = (): void => {
    setQuery('')
    void read('list')
  }

  return h('span', { style: { display: 'inline-flex' } },
    h('button', {
      ref: launcherRef,
      type: 'button',
      style: headerButtonStyle,
      'aria-expanded': open,
      'aria-controls': 'kylin-memory-panel',
      'aria-label': t('open'),
      title: t('open'),
      onClick: () => { setOpen(value => !value) },
    }, h(BrandMark, { size: 16 }), t('open')),
    open ? h('aside', {
      id: 'kylin-memory-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('title'),
      tabIndex: -1,
      style: panelStyle,
    },
    h('header', { style: { display: 'flex', alignItems: 'center', gap: 9, padding: '13px 14px 11px' } },
      h(BrandMark, { size: 26 }),
      h('div', { style: { display: 'grid', gap: 1, minWidth: 0, flex: 1 } },
        h('strong', { style: { fontSize: 14, lineHeight: 1.3 } }, t('title')),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, t('subtitle'))),
      h('span', {
        style: {
          padding: '2px 7px',
          borderRadius: 999,
          background: 'var(--kylin-memory-soft)',
          color: 'var(--kylin-memory)',
          fontSize: 11,
          whiteSpace: 'nowrap',
        },
      }, t('readOnly')),
      h('button', {
        ref: closeRef,
        type: 'button', style: iconButtonStyle, 'aria-label': t('close'), title: t('close'),
        onClick: () => { setOpen(false) },
      }, '×')),
    h('form', { onSubmit: submit, style: { display: 'flex', gap: 7, padding: '0 14px 10px' } },
      h('input', {
        value: query,
        onChange: (event: { target: { value: string } }) => { setQuery(event.target.value) },
        placeholder: t('searchPlaceholder'),
        'aria-label': t('searchLabel'),
        style: inputStyle,
      }),
      h('button', { type: 'submit', style: smallButtonStyle, disabled: status === 'loading' }, t('search')),
      query.length > 0 ? h('button', { type: 'button', style: quietButtonStyle, onClick: clear }, t('clear')) : null),
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '0 14px 8px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)',
      },
    },
    h('span', {}, searched ? t('searchLabelResult') : t('listLabel')),
    status === 'ready' ? h('span', {}, `${String(items.length)} ${t('itemUnit')} · ${t(modeKey(mode))}`) : null),
    h('div', { style: { flex: 1, overflowY: 'auto', borderTop: '0.5px solid var(--dsw-alias-border-l1)' } },
      status === 'loading' ? h('p', { role: 'status', style: { padding: 16, margin: 0, fontSize: 13 } }, t('loading')) : null,
      status === 'error' ? h('div', { role: 'alert', style: { display: 'grid', gap: 10, padding: 16 } },
        h('p', { style: { margin: 0, fontSize: 13 } }, t(errorKey(error))),
        error !== undefined ? h('code', { style: codeStyle }, error) : null,
        h('button', { type: 'button', style: quietButtonStyle, onClick: () => { void read('list') } }, t('retry'))) : null,
      status === 'ready' && items.length === 0 ? h('div', { style: { display: 'grid', gap: 6, padding: 16 } },
        h('p', { style: { margin: 0, fontSize: 13 } }, t('empty')),
        h('p', { style: { margin: 0, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.5 } }, t('emptyHint'))) : null,
      status === 'ready' && items.length > 0 ? h('div', { 'aria-label': t('listLabel') },
        ...items.map(item => h('button', {
          key: item.id,
          type: 'button',
          'aria-pressed': selected === item.id,
          style: {
            ...rowStyle,
            background: selected === item.id ? 'var(--kylin-memory-soft)' : 'transparent',
          },
          onClick: () => { setSelected(value => value === item.id ? undefined : item.id) },
        },
        h('span', { style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 } },
          h('span', {
            style: {
              width: 6, height: 6, flex: '0 0 auto', borderRadius: 999,
              background: item.kind === 'node' ? 'var(--kylin-memory)' : 'var(--kylin-action)',
            },
          }),
          h('strong', { style: { fontSize: 13, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.label),
          h('span', { style: { marginLeft: 'auto', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' } },
            statusKey(item.status) ? t(statusKey(item.status)!) : item.status)),
        h('span', {
          style: {
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            fontSize: 12, lineHeight: 1.45, color: 'var(--dsw-alias-label-secondary)',
          },
        }, item.summary),
        h('span', { style: { ...codeStyle, display: 'flex', gap: 8 } },
          h('span', {}, t(item.kind === 'node' ? 'kindNode' : 'kindRecord')),
          h('span', {}, item.type),
          h('span', {}, `${String(item.evidenceCount)} ${t('evidenceCount')}`)))),
      ) : null,
      status === 'ready' && selectedItem !== undefined ? h('section', {
        'aria-label': t('detail'),
        style: { display: 'grid', gap: 8, padding: '13px 14px', background: 'var(--dsw-alias-bg-layer-2)' },
      },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', justifyContent: 'space-between' } },
        h('strong', { style: { fontSize: 12 } }, t('detail')),
        h('span', { style: codeStyle }, selectedItem.id)),
      h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.55 } }, selectedItem.summary),
      h('dl', {
        style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 10px', margin: 0, fontSize: 11, lineHeight: 1.45 },
      },
      h('dt', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('status')),
      h('dd', { style: { margin: 0 } }, statusKey(selectedItem.status) ? t(statusKey(selectedItem.status)!) : selectedItem.status),
      h('dt', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('scope')),
      h('dd', { style: { margin: 0, ...codeStyle } }, selectedItem.scope),
      h('dt', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('created')),
      h('dd', { style: { margin: 0 } }, formatDate(selectedItem.createdAt) ?? '—'),
      h('dt', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('updated')),
      h('dd', { style: { margin: 0 } }, formatDate(selectedItem.updatedAt) ?? '—'),
      h('dt', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('evidence')),
      h('dd', { style: { margin: 0 } }, `${String(selectedItem.evidenceCount)} ${t('evidenceCount')}`)),
      h('p', { style: { margin: 0, fontSize: 10, lineHeight: 1.45, color: 'var(--dsw-alias-label-tertiary)' } }, t('evidenceUnavailable'))) : null,
      status === 'ready' && items.length > 0 && selectedItem === undefined
        ? h('p', { style: { margin: 0, padding: '10px 14px', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } }, t('selectItem'))
        : null),
    h('footer', {
      style: {
        padding: '8px 14px', borderTop: '0.5px solid var(--dsw-alias-border-l1)',
        fontSize: 10, lineHeight: 1.45, color: 'var(--dsw-alias-label-tertiary)',
      },
    }, t('footnote'))) : null)
}

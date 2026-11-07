import { createElement as h, useState } from 'react'
import type {
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { BrandMark } from './Brand.ts'
import type { KylinMemoryLocaleKey } from './locales.ts'
export interface RecallSection {
  readonly name: string
  readonly text: string
}

/** Durable Chat payload for one injected memory snapshot. */
export interface MemoryRecallChatData {
  readonly sections: readonly RecallSection[]
  readonly text: string
  readonly time: number
}

interface MemoryRecallState extends MemoryRecallChatData {}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'memory-recall': MemoryRecallChatData
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSection(value: unknown): value is RecallSection {
  return isRecord(value) && typeof value.name === 'string' && typeof value.text === 'string'
}

function sectionsOf(source: unknown): readonly RecallSection[] {
  if (!isRecord(source) || source.kind !== 'memory-recall' || !Array.isArray(source.sections)) return []
  return source.sections.filter(isSection)
}

function textOf(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n')
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

/** Match only the injected memory snapshot; ordinary user messages stay with the shell. */
export const recallDefinition: ConversationNodeDefinition<MemoryRecallState> = {
  kind: 'memory-recall',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'user/message') return null
    if (!isRecord(event.data.source) || event.data.source.kind !== 'memory-recall') return null
    return { id: String(event.data.id), role: 'start', exclusive: true }
  },
  start: (_context, match) => {
    if (match.event.type !== 'user/message') throw new Error('memory-recall requires user/message')
    return {
      sections: sectionsOf(match.event.data.source),
      text: textOf(match.event.data.content),
      time: match.event.time,
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'memory-recall',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'visible',
      groupTree: 'turn',
      data: {
        sections: context.state.sections,
        text: context.state.text,
        time: context.state.time,
      },
    }
  },
}

/** Default-collapsed durable card for the memory snapshot actually injected this turn. */
type RecallCardProps = Omit<ChatNodeViewProps<'memory-recall'>, 't'> & {
  t(key: KylinMemoryLocaleKey): string
}

export function RecallCard({ node, t }: RecallCardProps) {
  const [open, setOpen] = useState(false)
  const { sections, text } = node.data
  const empty = sections.length === 0 && text.trim().length === 0
  return h('section', {
    style: {
      display: 'grid',
      gap: 8,
      margin: '10px 0',
      padding: '10px 12px',
      borderInlineStart: '3px solid var(--kylin-memory)',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
    },
    'aria-label': t('recallTitle'),
  },
  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
    h(BrandMark, { size: 18 }),
    h('strong', { style: { fontSize: 13, lineHeight: 1.35 } }, t('recallTitle')),
    h('span', {
      style: {
        padding: '2px 7px',
        borderRadius: 999,
        background: 'var(--kylin-memory-soft)',
        color: 'var(--kylin-memory)',
        fontSize: 10,
        whiteSpace: 'nowrap',
      },
    }, t('recallInjected')),
    h('button', {
      type: 'button',
      style: {
        marginInlineStart: 'auto',
        border: 0,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 11,
        padding: '2px 0',
      },
      'aria-expanded': open,
      onClick: () => { setOpen(value => !value) },
    }, t(open ? 'recallHide' : 'recallShow'))),
  open ? h('div', {
    style: {
      display: 'grid',
      gap: 10,
      maxHeight: 320,
      overflowY: 'auto',
      paddingBlockStart: 4,
      borderBlockStart: '0.5px solid var(--dsw-alias-border-l1)',
    },
  },
  empty ? h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('recallEmpty')) : null,
  sections.map((section, index) => h('section', { key: `${String(index)}:${section.name}`, style: { display: 'grid', gap: 4 } },
    h('span', {
      style: {
        fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
        fontSize: 10,
        color: 'var(--dsw-alias-label-tertiary)',
      },
    }, section.name),
    h('pre', {
      style: {
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1.55,
        color: 'var(--dsw-alias-label-secondary)',
      },
    }, section.text))),
  sections.length > 0 && text.trim().length > 0 ? h('details', { style: { display: 'grid', gap: 4 } },
    h('summary', {
      style: { cursor: 'pointer', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
    }, t('recallFullText')),
    h('pre', {
      style: {
        margin: '6px 0 0',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1.55,
        color: 'var(--dsw-alias-label-secondary)',
      },
    }, text)) : null,
  sections.length === 0 && text.trim().length > 0 ? h('pre', {
    style: {
      margin: 0,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      font: 'inherit',
      fontSize: 12,
      lineHeight: 1.55,
      color: 'var(--dsw-alias-label-secondary)',
    },
  }, text) : null) : null)
}

/** Locale key type consumed by {@link RecallCard}; exported for the panel dictionary pairing. */
export type RecallLocaleKey = Extract<KylinMemoryLocaleKey, 'recallTitle' | 'recallInjected' | 'recallShow' | 'recallHide' | 'recallEmpty' | 'recallFullText'>

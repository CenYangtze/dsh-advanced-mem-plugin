import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { readMemory } from './api.ts'
import { HeroBrandMark, SidebarBrandMark, SidebarBrandName } from './Brand.ts'
import { MemoryPanel, type MemoryPanelFace } from './MemoryPanel.ts'
import { RecallCard, recallDefinition } from './RecallCard.ts'
import { en, zh, type KylinMemoryLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'kylin.memoryPanel': KylinMemoryLocaleKey }
}

export const name = 'kylin-memory-ui-client'

export const inject = ['slots', 'locale', 'connection', 'theme', 'uiConversation']

/**
 * Register the 智忆麒麟 memory panel beside the conversation header controls.
 * @param ctx - browser plugin context carrying slots, locale, and connection.
 */
export function apply(ctx: Context): void {
  const locale = 'kylin.memoryPanel'
  ctx.effect(() => ctx.locale.register(locale, { en, zh }), 'kylin-memory-ui: locale')
  ctx.effect(() => ctx.theme.overrideTokens('kylin-memory-ui', {
    '--kylin-action': {
      light: 'var(--dsw-static-deepseek-500)',
      dark: 'var(--dsw-static-deepseek-400)',
    },
    '--kylin-memory': {
      light: '#6d3ad6',
      dark: '#b8a6e7',
    },
    '--kylin-memory-soft': {
      light: 'color-mix(in srgb, #6d3ad6 12%, transparent)',
      dark: 'color-mix(in srgb, #b8a6e7 18%, transparent)',
    },
  }), 'kylin-memory-ui: memory tokens')
  const face: MemoryPanelFace = {
    list: (sessionId, signal) => readMemory(ctx, 'list', { sessionId, limit: 40 }, signal),
    search: (sessionId, query, signal) => readMemory(ctx, 'search', { sessionId, query, limit: 40 }, signal),
  }
  ctx.effect(() => ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
    name: 'sidebar.brand.mark',
  }, SidebarBrandMark)), 'kylin-memory-ui: sidebar mark')
  ctx.effect(() => ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
    name: 'sidebar.brand.name',
    locale,
  }, SidebarBrandName)), 'kylin-memory-ui: sidebar name')
  ctx.effect(() => ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark',
  }, HeroBrandMark)), 'kylin-memory-ui: hero mark')
  ctx.effect(() => ctx.uiConversation.events.register(recallDefinition), 'kylin-memory-ui: recall definition')
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'memory-recall',
    locale,
  }, RecallCard)), 'kylin-memory-ui: recall card')
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'kylin-memory-panel',
    order: 30,
    locale,
    inject: () => face,
  }, MemoryPanel)), 'kylin-memory-ui: read-only memory panel')
}

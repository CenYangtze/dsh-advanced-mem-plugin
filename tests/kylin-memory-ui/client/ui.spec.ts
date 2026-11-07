import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../../../src/kylin-memory-ui/client/index.ts'
import { recallDefinition } from '../../../src/kylin-memory-ui/client/RecallCard.ts'
import { en, zh } from '../../../src/kylin-memory-ui/client/locales.ts'
import type { KylinMemoryData } from '../../../src/kylin-memory-ui/client/api.ts'

type Face = {
  list(sessionId: string, signal?: AbortSignal): Promise<KylinMemoryData>
  search(sessionId: string, query: string, signal?: AbortSignal): Promise<KylinMemoryData>
}

type Registration = {
  readonly options: {
    readonly name: string
    readonly id?: string
    readonly key?: string
    readonly locale?: string
    readonly inject?: () => Face
  }
  readonly component: unknown
}

class FakeSlots extends Service {
  readonly registrations: Registration[] = []
  readonly disposed: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(_slot: string, callback: () => (() => void) | void): () => void {
    return callback() ?? (() => {})
  }

  register(options: Registration['options'], component: unknown): () => void {
    this.registrations.push({ options, component })
    return () => { this.disposed.push(options.id ?? options.name) }
  }
}

class FakeLocale extends Service {
  readonly namespaces: string[] = []
  readonly disposed: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'locale')
  }

  register(namespace: string, _dictionary: unknown): () => void {
    this.namespaces.push(namespace)
    return () => { this.disposed.push(namespace) }
  }
}

class FakeTheme extends Service {
  readonly sources: string[] = []
  readonly tokens: Array<Record<string, unknown>> = []
  readonly disposed: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'theme')
  }

  overrideTokens(source: string, tokens: unknown): () => void {
    this.sources.push(source)
    this.tokens.push(tokens as Record<string, unknown>)
    return () => { this.disposed.push(source) }
  }
}

type RpcReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly message: string } }

class FakeConnection extends Service {
  readonly calls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
  reply: RpcReply = { ok: true, value: { ok: true, data: { items: [], mode: null } } }

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc() {
    return {
      call: async (channel: string, endpoint: string, payload: unknown): Promise<RpcReply> => {
        this.calls.push({ channel, endpoint, payload })
        return this.reply
      },
    }
  }
}

class FakeConversation extends Service {
  readonly definitions: unknown[] = []
  disposed = false

  constructor(ctx: Context) {
    super(ctx, 'uiConversation')
  }

  get events() {
    return {
      register: (definition: unknown): (() => void) => {
        this.definitions.push(definition)
        return () => { this.disposed = true }
      },
    }
  }
}

async function setup(): Promise<{
  ctx: Context
  slots: FakeSlots
  locale: FakeLocale
  theme: FakeTheme
  connection: FakeConnection
  conversation: FakeConversation
}> {
  const ctx = new Context()
  const slots = new FakeSlots(ctx)
  const locale = new FakeLocale(ctx)
  const theme = new FakeTheme(ctx)
  const connection = new FakeConnection(ctx)
  const conversation = new FakeConversation(ctx)
  await ctx.plugin({ name, inject, apply })
  return { ctx, slots, locale, theme, connection, conversation }
}

function panelFace(slots: FakeSlots): Face {
  const panel = slots.registrations.find(entry => entry.options.id === 'kylin-memory-panel')
  expect(panel).toBeDefined()
  const face = panel?.options.inject?.()
  expect(face).toBeDefined()
  return face!
}

describe('智忆麒麟 read-only memory client', () => {
  it('registers brand, theme, and one panel through effects', async () => {
    const h = await setup()
    expect(h.locale.namespaces).toEqual(['kylin.memoryPanel'])
    expect(h.theme.sources).toEqual(['kylin-memory-ui'])
    expect(Object.keys(h.theme.tokens[0] ?? {}).sort()).toEqual([
      '--kylin-action',
      '--kylin-memory',
      '--kylin-memory-soft',
    ])
    expect(h.slots.registrations.map(entry => entry.options.name).sort()).toEqual([
      'conversation.chat.node',
      'conversation.hero.brand.mark',
      'conversation.session.header.utilities',
      'sidebar.brand.mark',
      'sidebar.brand.name',
    ])
    expect(h.conversation.definitions).toEqual([recallDefinition])
    const card = h.slots.registrations.find(entry => entry.options.name === 'conversation.chat.node')
    expect(card?.options.key).toBe('memory-recall')
    expect(card?.options.locale).toBe('kylin.memoryPanel')
    const panel = h.slots.registrations.find(entry => entry.options.id === 'kylin-memory-panel')
    expect(panel?.options.locale).toBe('kylin.memoryPanel')
    expect(typeof panel?.component).toBe('function')
    await h.ctx.fiber.dispose()
    expect(h.slots.disposed.sort()).toEqual([
      'conversation.chat.node',
      'conversation.hero.brand.mark',
      'kylin-memory-panel',
      'sidebar.brand.mark',
      'sidebar.brand.name',
    ].sort())
    expect(h.locale.disposed).toEqual(['kylin.memoryPanel'])
    expect(h.theme.disposed).toEqual(['kylin-memory-ui'])
    expect(h.conversation.disposed).toBe(true)
  })

  it('lists the current session through the fixed read-only channel', async () => {
    const h = await setup()
    const data = await panelFace(h.slots).list('session-1')
    expect(data).toEqual({ items: [], mode: null })
    expect(h.connection.calls).toEqual([{
      channel: '/kylin-memory-ui',
      endpoint: 'list',
      payload: { sessionId: 'session-1', limit: 40 },
    }])
  })

  it('searches with the query and returns host mode unchanged', async () => {
    const h = await setup()
    h.connection.reply = {
      ok: true,
      value: {
        ok: true,
        data: {
          items: [{
            id: 'n1', kind: 'node', type: 'preference', label: 'Uses metric units',
            summary: 'Prefers millimeters.', status: 'active', scope: 'workspace',
            createdAt: 1, updatedAt: 2, evidenceCount: 3,
          }],
          mode: 'lexical',
        },
      },
    }
    const data = await panelFace(h.slots).search('session-1', 'units')
    expect(data.mode).toBe('lexical')
    expect(data.items).toHaveLength(1)
    expect(h.connection.calls[0]).toEqual({
      channel: '/kylin-memory-ui',
      endpoint: 'search',
      payload: { sessionId: 'session-1', query: 'units', limit: 40 },
    })
  })

  it('surfaces a fixed host error code without inventing success', async () => {
    const h = await setup()
    h.connection.reply = { ok: true, value: { ok: false, error: { code: 'forbidden', message: 'owner required' } } }
    await expect(panelFace(h.slots).list('session-1')).rejects.toMatchObject({ name: 'forbidden', message: 'owner required' })
  })

  it('treats the outer transport result as a carrier, not business success', async () => {
    const h = await setup()
    h.connection.reply = { ok: false, error: { message: 'transport closed' } }
    await expect(panelFace(h.slots).list('session-1')).rejects.toThrow('transport closed')
  })

  it('rejects a malformed wire value instead of exposing it as success data', async () => {
    const h = await setup()
    h.connection.reply = { ok: true, value: { ok: true, data: { items: [{ id: 1 }], mode: 'lexical' } } }
    await expect(panelFace(h.slots).list('session-1')).rejects.toThrow('invalid memory items')
  })

  it('claims only memory-recall user messages and keeps the durable text', () => {
    const memoryEvent = {
      type: 'user/message',
      seq: 7,
      time: 100,
      data: {
        id: 'm1',
        content: [{ type: 'text', text: '## Memory\n\nfull injected text' }],
        source: {
          kind: 'memory-recall',
          form: 'snapshot',
          sections: [{ name: 'memory-recall:profile', text: '### What memory knows' }],
        },
      },
    }
    expect(recallDefinition.match(memoryEvent as never)).toEqual({
      id: 'm1', role: 'start', exclusive: true,
    })
    const state = recallDefinition.start({} as never, { event: memoryEvent } as never, undefined as never)
    expect(state.sections).toEqual([{ name: 'memory-recall:profile', text: '### What memory knows' }])
    expect(state.text).toBe('## Memory\n\nfull injected text')
    const node = recallDefinition.buildViewNode?.({
      key: 'memory-recall:1',
      id: 'm1',
      state,
      start: { event: memoryEvent, location: { kind: 'unresolved' } },
      matches: [{ event: memoryEvent, location: { kind: 'unresolved' } }],
    } as never)
    expect(node?.kind).toBe('memory-recall')
    expect(node?.groupTree).toBe('turn')
    const data = node?.data as { sections: readonly { text: string }[]; text: string }
    expect(data.sections[0]?.text).toBe('### What memory knows')
    expect(data.text).toBe('## Memory\n\nfull injected text')
  })

  it('does not claim ordinary user messages', () => {
    expect(recallDefinition.match({
      type: 'user/message',
      seq: 8,
      time: 101,
      data: { id: 'm2', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    } as never)).toBeNull()
  })

  it('keeps English and Chinese locale keys aligned', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

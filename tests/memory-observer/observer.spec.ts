import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import MemoryRuntime from '../../src/memory/index.ts'
import type { Config as MemoryConfig, MemoryRecord, MemoryScopeKey } from '../../src/memory/index.ts'
import * as observer from '../../src/memory-observer/index.ts'
import type { Config } from '../../src/memory-observer/index.ts'

const memoryConfig: MemoryConfig = {
  recallLimit: 10,
  profileLimit: 10,
  inferredConfidence: 0.4,
  assertedConfidence: 0.9,
  inferredHalfLifeMs: 1_000_000,
  assertedHalfLifeMs: 0,
  reinforcementRate: 0.3,
  contradictionRate: 0.5,
  retirementFloor: 0.1,
  activationHops: 1,
  activationFalloff: 0.5,
  recordBudget: 100,
  supportWeight: 0,
  duplicateThreshold: 1,
  diversityThreshold: 1,
  vectorWeight: 1,
}

const baseConfig = {
  captureUserMessages: true,
  captureAssistantMessages: false,
  captureToolCalls: true,
  maxTextLength: 200,
  excludedTools: [],
  captureCodeDispatches: true,
  transportTools: ['run_code'],
  maxToolDigestLength: 80,
} satisfies Config

const WORKSPACE = 'workspace:/repo' as MemoryScopeKey

/** A store that keeps writes in memory and records them in arrival order. */
class RecordingStore {
  readonly name = 'recording'
  readonly written: MemoryRecord[] = []
  private readonly rows = new Map<string, MemoryRecord>()

  getRecord(id: string): MemoryRecord | undefined {
    return this.rows.get(id)
  }

  records(scopes: readonly MemoryScopeKey[]): Iterable<MemoryRecord> {
    return [...this.rows.values()].filter(record => scopes.includes(record.scope))
  }

  putRecord(record: MemoryRecord): Promise<void> {
    this.rows.set(record.id, record)
    this.written.push(record)
    return Promise.resolve()
  }

  getNode(): undefined {
    return undefined
  }

  nodes(): Iterable<never> {
    return []
  }

  putNode(): Promise<void> {
    return Promise.resolve()
  }

  getEdge(): undefined {
    return undefined
  }

  edges(): Iterable<never> {
    return []
  }

  putEdge(): Promise<void> {
    return Promise.resolve()
  }

  eraseRecord(id: string): Promise<boolean> {
    return Promise.resolve(this.rows.delete(id))
  }
}

/** Boot the hub, a recording store, a session store, and the observer. */
async function harness(overrides?: Partial<Config>) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(MemoryRuntime, memoryConfig)
  const store = new RecordingStore()
  ctx.memory.registerStore(store)
  await ctx.plugin(observer, { ...baseConfig, ...overrides })
  const session = ctx.sessions.create(SessionId('s-1'), { meta: { cwd: '/repo' } })
  /** Let the observer's write chain drain before asserting. */
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index++) await Promise.resolve()
  }
  return { ctx, store, session, settle }
}

/** Append one human turn to a session. */
function userTurn(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('memory-observer', () => {
  it('captures a human prompt verbatim into the session workspace scope', async () => {
    const { store, session, settle } = await harness()
    userTurn(session, 'always run the linter before pushing')
    await settle()
    expect(store.written).toHaveLength(1)
    expect(store.written[0]).toMatchObject({
      kind: 'user-message',
      text: 'always run the linter before pushing',
      fidelity: 'verbatim',
      scope: WORKSPACE,
    })
    expect(store.written[0]?.provenance).toMatchObject({ sessionId: 's-1' })
  })

  it('marks a truncated capture as a summary rather than claiming it is verbatim', async () => {
    const { store, session, settle } = await harness({ maxTextLength: 10 })
    userTurn(session, 'a prompt considerably longer than ten characters')
    await settle()
    expect(store.written[0]).toMatchObject({ fidelity: 'summary', text: 'a prompt c' })
  })

  it('keeps image locators without copying bytes into memory', async () => {
    const { store, session, settle } = await harness()
    session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: 'like this mockup' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'att-7' as never,
            mediaType: 'image/png',
            bytes: 4096,
            width: 100,
            height: 50,
            name: 'mockup.png',
          },
        },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await settle()
    expect(store.written[0]?.attachments).toEqual([{
      kind: 'image',
      uri: 'attachment:att-7',
      mediaType: 'image/png',
      bytes: 4096,
      caption: 'mockup.png',
    }])
    expect(store.written[0]?.terms).toContain('mockup')
  })

  it('captures a tool call as a short label rather than its raw arguments', async () => {
    const { store, session, settle } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('c-1'), name: 'bash', arguments: '{"command":"ls"}',
    })
    await settle()
    expect(store.written[0]).toMatchObject({
      kind: 'tool-invocation',
      fidelity: 'derived',
      text: 'bash — ls',
    })
    expect(store.written[0]?.provenance).toMatchObject({ tool: 'bash', turn: 1, callId: 'c-1' })
  })

  it('marks a tool call evidence-only, so it is never read back to the model', async () => {
    const { store, session, settle } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('c-1'), name: 'bash', arguments: '{"command":"ls"}',
    })
    userTurn(session, 'please list the files')
    await settle()
    expect(store.written.find(record => record.kind === 'tool-invocation')?.use).toBe('evidence')
    expect(store.written.find(record => record.kind === 'user-message')?.use).toBe('recallable')
  })

  it('names a call by its description when it has one, since that is what a human would call it', async () => {
    const { store, session, settle } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('c-1'),
      name: 'write',
      arguments: JSON.stringify({ description: 'Rewrite the landing page', file_path: '/repo/index.html' }),
    })
    await settle()
    expect(store.written[0]?.text).toBe('write — Rewrite the landing page')
  })

  it('keeps only the tool name when the arguments say nothing nameable', async () => {
    const { store, session, settle } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('c-1'), name: 'get_goal', arguments: '{}',
    })
    await settle()
    expect(store.written[0]?.text).toBe('get_goal')
  })

  it('skips the Code Mode transport and captures the tools the program actually used', async () => {
    const { store, session, settle } = await harness()
    session.append('turn/start', { turn: 1 })
    // What the model calls: one transport carrying a whole program.
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('c-1'),
      name: 'run_code',
      arguments: JSON.stringify({ code: 'await tools.grep({pattern:"x"})', description: 'Search the tree' }),
    })
    // What the program actually did.
    session.append('tool/code-dispatch-start', {
      rootCallId: CallId('c-1'),
      parentCallId: CallId('c-1'),
      subCallId: CallId('c-1:code:1'),
      name: 'grep',
      arguments: { pattern: 'x', description: 'Search the tree' },
    })
    await settle()
    expect(store.written.map(record => record.text)).toEqual(['grep — Search the tree'])
    expect(store.written[0]?.provenance).toMatchObject({ tool: 'grep', callId: 'c-1:code:1' })
  })

  it('leaves Code Mode dispatches uncaptured when that capture is off', async () => {
    const { store, session, settle } = await harness({ captureCodeDispatches: false })
    session.append('turn/start', { turn: 1 })
    session.append('tool/code-dispatch-start', {
      rootCallId: CallId('c-1'),
      parentCallId: CallId('c-1'),
      subCallId: CallId('c-1:code:1'),
      name: 'grep',
      arguments: { pattern: 'x' },
    })
    await settle()
    expect(store.written).toHaveLength(0)
  })

  it('never captures harness-injected context, which would feed the graph its own output', async () => {
    const { store, session, settle } = await harness()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'recalled memory block' }],
      source: { kind: 'plugin', plugin: 'memory-recall', form: 'snapshot', sections: [] },
    }), { surfaceOp: 'append' })
    await settle()
    expect(store.written).toEqual([])
  })

  it('honors the capture switches', async () => {
    const { store, session, settle } = await harness({ captureUserMessages: false, captureToolCalls: false })
    userTurn(session, 'ignored')
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c-1'), name: 'bash', arguments: '{}' })
    await settle()
    expect(store.written).toEqual([])
  })

  it('skips an excluded tool', async () => {
    const { store, session, settle } = await harness({ excludedTools: ['bash'] })
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c-1'), name: 'bash', arguments: '{}' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c-2'), name: 'fs_read', arguments: '{}' })
    await settle()
    expect(store.written.map(record => record.provenance.tool)).toEqual(['fs_read'])
  })

  it('captures nothing while no store is mounted, rather than throwing into the log', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(MemoryRuntime, memoryConfig)
    await ctx.plugin(observer, baseConfig)
    const session = ctx.sessions.create(SessionId('s-2'), { meta: { cwd: '/repo' } })
    expect(() => { userTurn(session, 'no store mounted') }).not.toThrow()
  })

  it('falls back to the user scope for a session with no workspace', async () => {
    const { ctx, store, settle } = await harness()
    const session = ctx.sessions.create(SessionId('s-3'))
    userTurn(session, 'no workspace here')
    await settle()
    expect(store.written[0]?.scope).toBe('user')
  })

  it('rejects an unusable text budget at load rather than at the first capture', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, memoryConfig)
    expect(() => { observer.apply(ctx, { ...baseConfig, maxTextLength: 0 }) })
      .toThrow(/positive safe integer/)
  })
})

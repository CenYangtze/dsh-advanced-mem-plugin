import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import MemoryRuntime from '../../src/memory/index.ts'
import type {
  Config as MemoryConfig,
  MemoryEdge,
  MemoryEdgeId,
  MemoryNode,
  MemoryNodeId,
  MemoryRecord,
  MemoryRecordId,
  MemoryScope,
  MemoryScopeKey,
  MemoryStore,
} from '../../src/memory/index.ts'
import * as recall from '../../src/memory-recall/index.ts'
import { renderCue } from '../../src/memory-recall/index.ts'

const SIGNAL = new AbortController().signal

const memoryConfig: MemoryConfig = {
  recallLimit: 10,
  profileLimit: 10,
  inferredConfidence: 0.4,
  assertedConfidence: 0.9,
  inferredHalfLifeMs: 1_000_000_000,
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
  maxCues: 5,
  minConfidence: 0,
  injectProfileOnFirstTurn: true,
  profileLimit: 5,
  maxCharacters: 4000,
} satisfies recall.Config

const workspace: MemoryScope = { kind: 'workspace', workspace: '/repo' }

/** In-process store; this package's contract is with the hub, not a medium. */
class TestStore implements MemoryStore {
  readonly name = 'test'
  private readonly recordRows = new Map<string, MemoryRecord>()
  private readonly nodeRows = new Map<string, MemoryNode>()
  private readonly edgeRows = new Map<string, MemoryEdge>()

  getRecord(id: MemoryRecordId): MemoryRecord | undefined {
    return this.recordRows.get(id)
  }

  records(scopes: readonly MemoryScopeKey[]): Iterable<MemoryRecord> {
    return [...this.recordRows.values()].filter(record => scopes.includes(record.scope))
  }

  putRecord(record: MemoryRecord): Promise<void> {
    this.recordRows.set(record.id, record)
    return Promise.resolve()
  }

  getNode(id: MemoryNodeId): MemoryNode | undefined {
    return this.nodeRows.get(id)
  }

  nodes(scopes: readonly MemoryScopeKey[]): Iterable<MemoryNode> {
    return [...this.nodeRows.values()].filter(node => scopes.includes(node.scope))
  }

  putNode(node: MemoryNode): Promise<void> {
    this.nodeRows.set(node.id, node)
    return Promise.resolve()
  }

  getEdge(id: MemoryEdgeId): MemoryEdge | undefined {
    return this.edgeRows.get(id)
  }

  edges(scopes: readonly MemoryScopeKey[]): Iterable<MemoryEdge> {
    return [...this.edgeRows.values()].filter(edge => scopes.includes(edge.scope))
  }

  putEdge(edge: MemoryEdge): Promise<void> {
    this.edgeRows.set(edge.id, edge)
    return Promise.resolve()
  }

  eraseRecord(id: MemoryRecordId): Promise<boolean> {
    return Promise.resolve(this.recordRows.delete(id))
  }
}

/** Mount the real plugin over the real hub and agent registry. */
async function setup(overrides?: Partial<recall.Config>) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MemoryRuntime, memoryConfig)
  ctx.memory.registerStore(new TestStore())
  await ctx.plugin(recall, { ...baseConfig, ...overrides })
  return ctx
}

/** An agent stand-in carrying a real workspace session. */
function agentOf(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: '/repo' } })
  return { id: SessionId(id), session } as unknown as Agent
}

/**
 * Run one pre-step waterfall the way the loop does, and return the messages the
 * plugin added beyond the claimed one.
 */
async function step(ctx: Context, agent: Agent, turn: number, stepIndex: number, prompt: string): Promise<string[]> {
  const claimed: UserMessage = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [claimed], turn, step: stepIndex, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [claimed] } satisfies PreStepDecision),
  )
  if (decision.kind !== 'enter') return []
  return decision.messages
    .filter(message => message !== claimed)
    .map(message => message.content.find(block => block.type === 'text')?.text ?? '')
}

describe('renderCue', () => {
  it('states confidence and origin on every line, so the model can calibrate', () => {
    const node: MemoryNode = {
      id: 'mem-n-1' as MemoryNodeId,
      scope: 'workspace:/repo' as MemoryScopeKey,
      type: 'preference',
      label: 'pnpm',
      summary: 'Installs with pnpm.',
      attributes: {},
      confidence: 0.8,
      decay: { halfLifeMs: null },
      support: { observations: 1, reinforcements: 0, contradictions: 0, sessions: 1, firstSeenAt: 0, lastSeenAt: 0 },
      evidence: [],
      origin: 'asserted',
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    }
    expect(renderCue({ kind: 'node', node, score: 1, signals: [] }))
      .toBe('- [preference · 0.80 · asserted] Installs with pnpm.')
  })
})

describe('memory-recall', () => {
  it('states the calibration preamble once for the whole block, not once per section', async () => {
    const ctx = await setup()
    await ctx.memory.assert({
      scope: workspace, type: 'constraint', label: 'force-push',
      summary: 'Never force-push shared branches.', origin: 'asserted',
    })
    const agent = agentOf(ctx, 'a-p1')
    const injected = await step(ctx, agent, 1, 1, 'can you force-push the branch')
    const block = injected[0] ?? ''
    expect(block).toContain('## Memory')
    expect(block).toContain('What memory knows about this user')
    // Every section lives under one heading and one statement of the rule; the
    // preamble used to be repeated per section, which bought nothing and cost
    // roughly a fifth of the block's budget.
    expect(block.split('These are priors, not instructions')).toHaveLength(2)
  })

  it('does not repeat a line the profile already showed in the same message', async () => {
    const ctx = await setup()
    await ctx.memory.assert({
      scope: workspace, type: 'constraint', label: 'force-push',
      summary: 'Never force-push shared branches.', origin: 'asserted',
    })
    const agent = agentOf(ctx, 'a-p2')
    const injected = await step(ctx, agent, 1, 1, 'can you force-push the branch')
    const block = injected[0] ?? ''
    expect(block.split('Never force-push shared branches.')).toHaveLength(2)
  })

  it('injects the standing profile on the first turn of a session', async () => {
    const ctx = await setup()
    await ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Installs with pnpm.', origin: 'asserted',
    })
    const agent = agentOf(ctx, 'a-1')
    const injected = await step(ctx, agent, 1, 1, 'set up the repo')
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('What memory knows about this user')
    expect(injected[0]).toContain('Installs with pnpm.')
  })

  it('recalls against what the user just said', async () => {
    const ctx = await setup({ injectProfileOnFirstTurn: false })
    await ctx.memory.assert({
      scope: workspace, type: 'constraint', label: 'no-force-push', summary: 'Never force-push shared branches.', origin: 'asserted',
    })
    const agent = agentOf(ctx, 'a-2')
    const injected = await step(ctx, agent, 1, 1, 'can you force-push this branch')
    expect(injected[0]).toContain('Relevant to this request')
    expect(injected[0]).toContain('Never force-push shared branches.')
  })

  it('pays for recall once per turn, not once per step', async () => {
    const ctx = await setup({ injectProfileOnFirstTurn: false })
    await ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Installs dependencies with pnpm.', origin: 'asserted',
    })
    const agent = agentOf(ctx, 'a-3')
    expect(await step(ctx, agent, 1, 1, 'install dependencies')).toHaveLength(1)
    expect(await step(ctx, agent, 1, 2, 'install dependencies')).toEqual([])
    expect(await step(ctx, agent, 2, 1, 'install dependencies')).toHaveLength(1)
  })

  it('injects the profile only once per session', async () => {
    const ctx = await setup()
    await ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Installs with pnpm.', origin: 'asserted',
    })
    const agent = agentOf(ctx, 'a-4')
    expect((await step(ctx, agent, 1, 1, 'anything'))[0]).toContain('What memory knows')
    expect((await step(ctx, agent, 2, 1, 'anything'))[0] ?? '').not.toContain('What memory knows')
  })

  it('adds nothing when memory holds nothing relevant', async () => {
    const ctx = await setup()
    const agent = agentOf(ctx, 'a-5')
    expect(await step(ctx, agent, 1, 1, 'a topic nothing was ever learned about')).toEqual([])
  })

  it('adds nothing while no store is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemoryRuntime, memoryConfig)
    await ctx.plugin(recall, baseConfig)
    const agent = agentOf(ctx, 'a-6')
    expect(await step(ctx, agent, 1, 1, 'anything')).toEqual([])
  })

  it('drops whole lines rather than truncating a remembered statement in half', async () => {
    const ctx = await setup({ injectProfileOnFirstTurn: false, maxCharacters: 900 })
    for (let index = 0; index < 5; index++) {
      await ctx.memory.assert({
        scope: workspace,
        type: 'preference',
        label: `pref-${index}`,
        summary: `Prefers the deploy approach numbered ${index} for every deploy task in this repository.`,
        origin: 'asserted',
      })
    }
    const agent = agentOf(ctx, 'a-7')
    const injected = await step(ctx, agent, 1, 1, 'deploy')
    const lines = (injected[0] ?? '').split('\n').filter(line => line.startsWith('- ['))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThan(5)
    for (const line of lines) expect(line).toMatch(/repository\.$/)
  })

  it('sources the injection as plugin context, so capture never re-ingests it', async () => {
    const ctx = await setup()
    await ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Installs with pnpm.', origin: 'asserted',
    })
    const agent = agentOf(ctx, 'a-8')
    const claimed = createUserMessage({ content: [{ type: 'text', text: 'install' }], source: { kind: 'user' } })
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [claimed], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [claimed] } satisfies PreStepDecision),
    )
    const added = decision.kind === 'enter' ? decision.messages.filter(message => message !== claimed) : []
    expect(added[0]?.source).toMatchObject({ kind: 'plugin', plugin: 'memory-recall', form: 'snapshot' })
  })

  it('leaves a rejected step rejected', async () => {
    const ctx = await setup()
    const agent = agentOf(ctx, 'a-9')
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'reject' as const, reason: 'no' } as unknown as PreStepDecision),
    )
    expect(decision.kind).toBe('reject')
  })

  it('rejects an unusable budget at load rather than at the first turn', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, memoryConfig)
    expect(() => { recall.apply(ctx, { ...baseConfig, maxCues: 0 }) }).toThrow(/positive safe integer/)
  })
})

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import MemoryRuntime from '../../src/memory/index.ts'
import type {
  Config as MemoryConfig,
  MemoryEdge,
  MemoryEdgeId,
  MemoryNode,
  MemoryNodeId,
  MemoryRecord,
  MemoryRecordId,
  MemoryScopeKey,
  MemoryStore,
} from '../../src/memory/index.ts'
import * as tool from '../../src/tool-memory/index.ts'
import { MEMORY_PROTOCOL, MEMORY_SECTION_NAME } from '../../src/tool-memory/index.ts'

const SIGNAL = new AbortController().signal

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

const toolConfig = {
  defaultSearchLimit: 5,
  maxSearchLimit: 20,
  maxSummaryLength: 200,
} satisfies tool.Config

/** In-process store; the tools' contract is with the hub, not with a medium. */
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

/** Mount the real plugin on a real tool registry, hub, and session store. */
async function setup(config: tool.Config = toolConfig) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(MemoryRuntime, memoryConfig)
  ctx.memory.registerStore(new TestStore())
  await ctx.plugin(tool, config)
  return ctx
}

let calls = 0

/** An agent stand-in carrying a real session, which is what the tools read. */
function workspaceAgent(ctx: Context, id: string, cwd: string | null = '/repo'): Agent {
  const session = ctx.sessions.create(SessionId(id), cwd === null ? undefined : { meta: { cwd } })
  return { id: SessionId(id), session } as unknown as Agent
}

/** Invoke one registered tool through the real execution pipeline. */
function invoke(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/** Concatenate a result's text blocks. */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('registration', () => {
  it('registers the three memory tools', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('memory_'))
    expect(names.sort()).toEqual(['memory_forget', 'memory_search', 'memory_write'])
  })

  it('contributes the memory protocol as a fixed prompt section', async () => {
    const ctx = await setup()
    const assembly = await ctx.systemPrompt.assemble({})
    const section = assembly.sections.find(entry => entry.name === MEMORY_SECTION_NAME)
    expect(section?.text).toBe(MEMORY_PROTOCOL)
  })

  it('withholds the affinity classes the model must not assert about itself', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'memory_write')
    const properties = (schema?.parameters as { properties?: Record<string, { enum?: string[] }> }).properties ?? {}
    expect(properties['type']?.enum).not.toContain('tool-affinity')
    expect(properties['type']?.enum).not.toContain('procedure')
  })

  it('fails loud when the default search limit exceeds the maximum', async () => {
    await expect(setup({ ...toolConfig, defaultSearchLimit: 50 })).rejects.toThrow(/exceeds maxSearchLimit/)
  })
})

describe('memory_write', () => {
  it('remembers a stated preference so it never fades', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 'w-1')
    const result = await invoke(ctx, 'memory_write', {
      type: 'preference',
      label: 'pnpm',
      summary: 'Installs dependencies with pnpm, never npm.',
      stated_by_user: true,
    }, agent)
    expect(text(result)).toContain('Remembered "pnpm" in workspace scope')
    const profile = ctx.memory.profile([{ kind: 'workspace', workspace: '/repo' }])
    expect(profile.nodes[0]).toMatchObject({ label: 'pnpm', origin: 'asserted' })
    expect(profile.nodes[0]?.decay.halfLifeMs).toBeNull()
  })

  it('marks a guess as inferred, so it erodes unless it is seen again', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 'w-2')
    await invoke(ctx, 'memory_write', {
      type: 'preference', label: 'tabs', summary: 'Seems to indent with tabs.', stated_by_user: false,
    }, agent)
    const profile = ctx.memory.profile([{ kind: 'workspace', workspace: '/repo' }])
    expect(profile.nodes[0]).toMatchObject({ origin: 'inferred' })
    expect(profile.nodes[0]?.decay.halfLifeMs).toBe(memoryConfig.inferredHalfLifeMs)
  })

  it('reinforces the same label rather than duplicating it', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 'w-3')
    const args = { type: 'preference', label: 'pnpm', summary: 'Uses pnpm.', stated_by_user: false }
    const first = await invoke(ctx, 'memory_write', args, agent)
    const second = await invoke(ctx, 'memory_write', args, agent)
    expect(ctx.memory.profile([{ kind: 'workspace', workspace: '/repo' }]).total).toBe(1)
    expect(text(second)).not.toBe(text(first))
  })

  it('links to an existing memory when asked', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 'w-4')
    await invoke(ctx, 'memory_write', {
      type: 'project', label: 'harness', summary: 'The harness repository.', stated_by_user: true,
    }, agent)
    const result = await invoke(ctx, 'memory_write', {
      type: 'preference',
      label: 'pnpm',
      summary: 'Uses pnpm here.',
      stated_by_user: true,
      related_to: 'harness',
      relation: 'uses',
      claim: 'The harness repository is worked with pnpm.',
    }, agent)
    expect(text(result)).toContain('and linked it')
  })

  it('rejects a link with no relation or claim rather than storing a nameless edge', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 'w-5')
    const result = await invoke(ctx, 'memory_write', {
      type: 'preference', label: 'x', summary: 'X.', stated_by_user: true, related_to: 'missing',
    }, agent)
    expect(text(result)).toContain('requires both `relation` and `claim`')
  })

  it('rejects a link to a label nothing holds', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 'w-6')
    const result = await invoke(ctx, 'memory_write', {
      type: 'preference',
      label: 'x',
      summary: 'X.',
      stated_by_user: true,
      related_to: 'nonexistent',
      relation: 'uses',
      claim: 'X uses nonexistent.',
    }, agent)
    expect(text(result)).toContain('no memory labelled "nonexistent"')
  })

  it('rejects an over-long summary instead of silently cutting the statement in half', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 'w-7')
    const result = await invoke(ctx, 'memory_write', {
      type: 'preference', label: 'verbose', summary: 'x'.repeat(500), stated_by_user: true,
    }, agent)
    expect(text(result)).toContain('keep it under 200')
  })

  it('refuses workspace scope when there is no workspace to mean', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 'w-8', null)
    const result = await invoke(ctx, 'memory_write', {
      type: 'preference', label: 'x', summary: 'X.', stated_by_user: true, scope: 'workspace',
    }, agent)
    expect(text(result)).toContain('no workspace')
  })

  it('accepts user scope with no agent at all', async () => {
    const ctx = await setup()
    const result = await invoke(ctx, 'memory_write', {
      type: 'preference', label: 'dark', summary: 'Prefers dark mode.', stated_by_user: true, scope: 'user',
    })
    expect(text(result)).toContain('in user scope')
  })
})

describe('memory_search', () => {
  it('finds a written belief and reports its confidence and origin', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 's-1')
    await invoke(ctx, 'memory_write', {
      type: 'preference', label: 'pnpm', summary: 'Installs dependencies with pnpm.', stated_by_user: true,
    }, agent)
    const result = await invoke(ctx, 'memory_search', { query: 'how are dependencies installed' }, agent)
    expect(text(result)).toContain('Installs dependencies with pnpm')
    expect(text(result)).toContain('asserted')
  })

  it('reads the workspace and the user scope together by default', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 's-2')
    await invoke(ctx, 'memory_write', {
      type: 'preference', label: 'dark', summary: 'Prefers dark themes.', stated_by_user: true, scope: 'user',
    }, agent)
    expect(text(await invoke(ctx, 'memory_search', { query: 'themes' }, agent))).toContain('dark themes')
    const scoped = await invoke(ctx, 'memory_search', { query: 'themes', scope: 'workspace' }, agent)
    expect(text(scoped)).toContain('No memories matched')
  })

  it('caps the limit at the configured maximum', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 's-3')
    for (let index = 0; index < 25; index++) {
      await ctx.memory.remember({
        scope: { kind: 'workspace', workspace: '/repo' },
        kind: 'note',
        text: `deploy note ${index}`,
        fidelity: 'verbatim',
      })
    }
    const result = await invoke(ctx, 'memory_search', { query: 'deploy', limit: 999 }, agent)
    expect(text(result)).toMatch(/^20 memories/)
  })

  it('says so plainly when nothing matched', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 's-4')
    expect(text(await invoke(ctx, 'memory_search', { query: 'nothing here' }, agent)))
      .toBe('No memories matched "nothing here".')
  })
})

describe('memory_forget', () => {
  it('retracts by default, keeping the item auditable but out of recall', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 'f-1')
    await invoke(ctx, 'memory_write', {
      type: 'preference', label: 'wrong', summary: 'A mistaken belief.', stated_by_user: false,
    }, agent)
    const result = await invoke(ctx, 'memory_forget', { label: 'wrong' }, agent)
    expect(text(result)).toContain('Retracted "wrong"')
    expect(text(await invoke(ctx, 'memory_search', { query: 'mistaken' }, agent))).toContain('No memories matched')
  })

  it('erases the supporting material when asked to', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 'f-2')
    const scope = { kind: 'workspace', workspace: '/repo' } as const
    const record = await ctx.memory.remember({
      scope, kind: 'user-message', text: 'a private detail', fidelity: 'verbatim',
    })
    await ctx.memory.assert({
      scope, type: 'preference', label: 'private', summary: 'Derived from a private detail.', origin: 'inferred', evidence: [record.id],
    })
    const result = await invoke(ctx, 'memory_forget', { label: 'private', mode: 'erase' }, agent)
    expect(text(result)).toContain('and 1 supporting records')
    expect(ctx.memory.store.getRecord(record.id)).toBeUndefined()
  })

  it('reports an unknown label rather than silently succeeding', async () => {
    const ctx = await setup()
    const agent = workspaceAgent(ctx, 'f-3')
    expect(text(await invoke(ctx, 'memory_forget', { label: 'never-written' }, agent)))
      .toContain('no memory labelled "never-written"')
  })
})

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import MemoryRuntime from '../../src/memory/index.ts'
import type { Config as MemoryConfig, MemoryScope } from '../../src/memory/index.ts'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandMemory from '../../src/command-memory/index.ts'
import { parseMemoryCommand } from '../../src/command-memory/index.ts'
import { FakeMemoryStore } from '../memory/helpers/fake-store.ts'

const HOUR = 3600_000

const memoryConfig = {
  recallLimit: 10,
  profileLimit: 10,
  inferredConfidence: 0.4,
  assertedConfidence: 0.9,
  inferredHalfLifeMs: 30 * 24 * HOUR,
  assertedHalfLifeMs: 0,
  reinforcementRate: 0.3,
  contradictionRate: 0.5,
  retirementFloor: 0.1,
  activationHops: 2,
  activationFalloff: 0.5,
  recordBudget: 100,
  supportWeight: 0,
  duplicateThreshold: 1,
  diversityThreshold: 1,
  vectorWeight: 1,
} satisfies MemoryConfig

const commandConfig = { profileLimit: 5, suggestLimit: 3, searchLimit: 5 } satisfies commandMemory.Config

const workspace: MemoryScope = { kind: 'workspace', workspace: '/repo' }

/** A live idle agent whose session carries the workspace the command scopes to. */
function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: '/repo' } })
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const status: AgentStatus = 'idle'
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { inbox.append('next-step', input) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

/** Mount the real command registry, memory hub, and this producer. */
async function harness(options?: { store?: boolean }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MemoryRuntime, memoryConfig)
  if (options?.store !== false) ctx.memory.registerStore(new FakeMemoryStore())
  await ctx.plugin(commandMemory, commandConfig)
  const agent = stubAgent(ctx, `command-memory-${Math.random()}`)
  ctx.agents.register(agent)
  /** Dispatch one `/memory` line and return its rendered text. */
  const run = async (input: string): Promise<string> => {
    const line = input.length === 0 ? '/memory' : `/memory ${input}`
    const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
    return execution?.result.text ?? ''
  }
  return { ctx, agent, run }
}

describe('parseMemoryCommand', () => {
  it('reads an empty line as the default view', () => {
    expect(parseMemoryCommand('   ')).toEqual({ kind: 'show' })
  })

  it('reads each subcommand', () => {
    expect(parseMemoryCommand('suggest')).toEqual({ kind: 'suggest' })
    expect(parseMemoryCommand('stats')).toEqual({ kind: 'stats' })
    expect(parseMemoryCommand('search  pnpm  install')).toEqual({ kind: 'search', query: 'pnpm install' })
    expect(parseMemoryCommand('forget pic-to-latex')).toEqual({ kind: 'forget', label: 'pic-to-latex' })
  })

  it('returns usage for a subcommand missing its argument, rather than searching for nothing', () => {
    expect(parseMemoryCommand('search')).toEqual({ kind: 'usage' })
    expect(parseMemoryCommand('forget')).toEqual({ kind: 'usage' })
  })

  it('returns usage for an unknown word instead of guessing it is a query', () => {
    expect(parseMemoryCommand('serch pnpm')).toEqual({ kind: 'usage' })
  })
})

describe('/memory', () => {
  it('says plainly that memory is empty rather than printing an empty list', async () => {
    const { run } = await harness()
    expect(await run('')).toContain('Memory holds nothing about this user yet')
  })

  it('lists what memory believes, with confidence and origin on every line', async () => {
    const { ctx, run } = await harness()
    await ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Installs with pnpm.', origin: 'asserted',
    })
    const output = await run('')
    expect(output).toContain('What memory knows about you')
    expect(output).toContain('[preference · 0.90 · asserted] Installs with pnpm.')
  })

  it('suggests the work memory holds, and never a preference', async () => {
    const { ctx, run } = await harness()
    await ctx.memory.assert({
      scope: workspace, type: 'project', label: 'pic-to-latex', summary: 'A screenshot-to-LaTeX tool.', origin: 'asserted',
    })
    await ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'pixel-art', summary: 'Prefers a pixel-art visual style.', origin: 'asserted',
    })
    const output = await run('suggest')
    expect(output).toContain('pic-to-latex')
    expect(output).not.toContain('pixel-art')
  })

  it('says nothing is worth suggesting rather than offering a preference as a starting point', async () => {
    const { ctx, run } = await harness()
    await ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'pixel-art', summary: 'Prefers a pixel-art visual style.', origin: 'asserted',
    })
    expect(await run('suggest')).toContain('Nothing to suggest yet')
  })

  it('reports how much stored material is evidence-only, so the split is visible', async () => {
    const { ctx, run } = await harness()
    await ctx.memory.remember({ scope: workspace, kind: 'user-message', text: 'redesign the page', fidelity: 'verbatim' })
    await ctx.memory.remember({ scope: workspace, kind: 'tool-invocation', text: 'grep — find it', fidelity: 'derived' })
    const output = await run('stats')
    expect(output).toContain('2 record(s) — 1 quotable, 1 evidence-only')
    expect(output).toContain('never read back to the model')
  })

  it('searches memory and reports an empty result rather than an empty list', async () => {
    const { run } = await harness()
    expect(await run('search deployment')).toContain('Nothing remembered for')
  })

  it('finds a belief by search', async () => {
    const { ctx, run } = await harness()
    await ctx.memory.assert({
      scope: workspace, type: 'constraint', label: 'force-push', summary: 'Never force-push shared branches.', origin: 'asserted',
    })
    expect(await run('search force-push branches')).toContain('Never force-push shared branches.')
  })

  it('never surfaces the agent own tool calls through search', async () => {
    const { ctx, run } = await harness()
    await ctx.memory.remember({
      scope: workspace, kind: 'tool-invocation', text: 'run_code — Parse redesigned HTML', fidelity: 'derived',
    })
    expect(await run('search parse redesigned HTML')).toContain('Nothing remembered for')
  })

  it('forgets every belief carrying a label, not just the first', async () => {
    const { ctx, run } = await harness()
    await ctx.memory.assert({
      scope: workspace, type: 'project', label: 'legacy', summary: 'The old project.', origin: 'asserted',
    })
    await ctx.memory.assert({
      scope: workspace, type: 'entity', label: 'legacy', summary: 'The legacy service.', origin: 'asserted',
    })
    expect(await run('forget legacy')).toContain('Retracted 2 memory item(s)')
    expect(await run('search legacy')).toContain('Nothing remembered for')
  })

  it('matches a label case-insensitively, since the user is typing it back', async () => {
    const { ctx, run } = await harness()
    await ctx.memory.assert({
      scope: workspace, type: 'project', label: 'Pic-To-LaTeX', summary: 'The tool.', origin: 'asserted',
    })
    expect(await run('forget pic-to-latex')).toContain('Retracted 1 memory item(s)')
  })

  it('reports an unknown label instead of silently succeeding', async () => {
    const { run } = await harness()
    expect(await run('forget nothing-like-this')).toContain('No active memory labelled')
  })

  it('answers with usage for an unparseable line', async () => {
    const { run } = await harness()
    expect(await run('wat')).toContain('Usage: /memory')
  })

  it('reports the missing store rather than throwing when no medium is mounted', async () => {
    const { run } = await harness({ store: false })
    expect(await run('')).toContain('no store is mounted')
  })
})

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import * as consolidation from '../../src/memory-consolidation/index.ts'
import type { MemoryMaintenanceReport, MemoryModelRoute } from '../../src/memory/index.ts'

const config: consolidation.Config = {
  minObservations: 3,
  observationSaturation: 6,
  maxConfidence: 0.85,
  minSequenceLength: 2,
  maxSequenceLength: 4,
  minSequenceRepeats: 3,
  minStatements: 1,
  minSubjectLength: 3,
  maxSubjectLength: 60,
  behaviorLookbackRecords: 20,
  progressMaxAttempts: 3,
  semanticEnabled: true,
  semanticMaxRecords: 6,
  semanticMaxInputCharacters: 12_000,
  semanticMaxOutputBytes: 32_768,
  semanticMaxCandidates: 8,
  semanticMaxExistingNodes: 12,
  semanticMaxTokens: 1_200,
  semanticTemperature: 0,
  semanticTimeoutMs: 30_000,
  semanticMaxFieldLength: 160,
  semanticMaxCallsPerPass: 2,
  semanticMaxConcurrentCalls: 1,
  semanticPromptVersion: 'semantic-v4',
  consolidateEveryTurns: 1,
  sweepEveryTurns: 1_000_000,
}

const report: MemoryMaintenanceReport = {
  examined: 0, nodesCreated: 0, nodesReinforced: 0, edgesCreated: 0, edgesReinforced: 0, retired: 0, evicted: 0,
}

class SchedulerContext {
  readonly handlers = new Map<string, ((...args: readonly unknown[]) => void)[]>()
  readonly effects: (() => void | Promise<void>)[] = []
  readonly injectCalls: string[][] = []
  readonly warnings: string[] = []
  readonly errors: string[] = []
  readonly calls: { scope: unknown; options?: { route?: MemoryModelRoute; sessionId?: string; signal?: AbortSignal } | undefined }[] = []
  readonly session = {
    id: 's1',
    header: { cwd: '/repo' },
    requestHeader: () => ({ config: { provider: 'session-p', model: 'session-m' }, adapterDefaults: {} }),
  } as unknown as Session
  readonly agent = { session: this.session, ctx: this }
  readonly memory = {
    ready: true,
    registerDistiller: () => () => {},
    consolidate: async (scope: unknown, options?: { route?: MemoryModelRoute; sessionId?: string; signal?: AbortSignal }) => {
      this.calls.push({ scope, options })
      return report
    },
    sweep: async () => report,
  }
  readonly agents = { get: () => this.agent }
  readonly llm = { stream: async function* (): AsyncGenerator<unknown> {} }
  readonly logger = {
    warn: (message: string) => { this.warnings.push(message) },
    info: () => {},
    error: (message: string) => { this.errors.push(message) },
  }

  constructor(private readonly optionalServices = true) {}

  get(name: string): unknown {
    if (name === 'agents') return this.optionalServices ? this.agents : undefined
    if (name === 'llm') return this.optionalServices ? this.llm : undefined
    if (name === 'sessionProjections') {
      return { snapshot: () => ({ values: { modelSelection: { next: { provider: 'projection-p', model: 'projection-m' } } } }) }
    }
    return undefined
  }

  on(event: string, handler: (...args: readonly unknown[]) => void): () => void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return () => {}
  }

  inject(deps: readonly string[], callback: (ctx: Context) => void): () => void {
    this.injectCalls.push([...deps])
    if (deps.every(name => this.get(name) !== undefined)) callback(this as unknown as Context)
    return () => {}
  }

  effect(callback: () => void | (() => void | Promise<void>)): () => void {
    const dispose = callback()
    if (typeof dispose === 'function') this.effects.push(dispose)
    return () => {}
  }

  emit(event: string, ...args: readonly unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }

  async dispose(): Promise<void> {
    for (const dispose of this.effects.reverse()) await dispose()
  }
}

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('consolidation scheduler', () => {
  it('runs the rule miners with only memory and sessions when semantic is disabled', async () => {
    const ctx = new SchedulerContext(false)
    consolidation.apply(ctx as unknown as Context, { ...config, semanticEnabled: false })
    expect(ctx.injectCalls).toEqual([])
    ctx.emit('session/event', ctx.session, { type: 'turn/end' } as SessionEvent)
    await tick()
    expect(ctx.calls).toHaveLength(1)
    expect(ctx.calls[0]?.options?.route).toBeUndefined()
    await ctx.dispose()
  })

  it('reports missing optional services when semantic is enabled', async () => {
    const ctx = new SchedulerContext(false)
    consolidation.apply(ctx as unknown as Context, config)
    expect(ctx.injectCalls).toEqual([['llm', 'agents']])
    expect(ctx.errors.some(message => message.includes('optional services are not ready'))).toBe(true)
    ctx.emit('session/event', ctx.session, { type: 'turn/end' } as SessionEvent)
    await tick()
    expect(ctx.calls).toHaveLength(1)
    expect(ctx.calls[0]?.options?.route).toBeUndefined()
    await ctx.dispose()
  })

  it('resolves the own session route at turn/end and passes session id', async () => {
    const ctx = new SchedulerContext()
    consolidation.apply(ctx as unknown as Context, config)
    ctx.emit('session/event', ctx.session, { type: 'turn/end' } as SessionEvent)
    await tick()
    expect(ctx.calls).toHaveLength(1)
    expect(ctx.calls[0]?.options).toMatchObject({
      sessionId: 's1',
      route: { provider: 'projection-p', model: 'projection-m' },
    })
    await ctx.dispose()
  })

  it('aborts an in-flight consolidation when the plugin disposes', async () => {
    const ctx = new SchedulerContext()
    let observed: AbortSignal | undefined
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    ctx.memory.consolidate = (scope: unknown, options) => {
      observed = options?.signal
      started()
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    consolidation.apply(ctx as unknown as Context, config)
    ctx.emit('session/event', ctx.session, { type: 'turn/end' } as SessionEvent)
    await startedPromise
    expect(observed?.aborted).toBe(false)
    await ctx.dispose()
    expect(observed?.aborted).toBe(true)
  })
})

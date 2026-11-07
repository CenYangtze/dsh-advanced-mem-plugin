import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryRuntime from '../../src/memory/index.ts'
import type {
  Config,
  MemoryDistiller,
  MemoryDistillation,
  MemoryRecord,
  MemoryScope,
} from '../../src/memory/index.ts'
import { BehaviorCycleDistiller } from '../../src/memory-consolidation/distiller.ts'
import type { DistillerPolicy } from '../../src/memory-consolidation/distiller.ts'
import { FakeMemoryStore } from './helpers/fake-store.ts'

const memoryConfig: Config = {
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
  safety: {
    redactPrivateKeys: true,
    redactProviderTokens: true,
    redactBearerTokens: true,
    redactSecretAssignments: true,
    rejectSensitivePatterns: false,
    blockedLiterals: [],
  },
}

const workspace: MemoryScope = { kind: 'workspace', workspace: '/repo' }
const key = 'workspace:/repo' as never

const behaviorPolicy: DistillerPolicy = {
  minObservations: 3,
  observationSaturation: 6,
  maxConfidence: 0.85,
  minSequenceLength: 2,
  maxSequenceLength: 4,
  minSequenceRepeats: 2,
  behaviorLookbackRecords: 20,
  progressMaxAttempts: 3,
}

function harness(store = new FakeMemoryStore()) {
  const ctx = new Context()
  const runtime = new MemoryRuntime(ctx, memoryConfig)
  runtime.registerStore(store)
  return { ctx, runtime, store }
}

function progressDistiller(
  distill: () => Promise<MemoryDistillation>,
  overrides: Partial<MemoryDistiller> = {},
): MemoryDistiller {
  return {
    name: 'progress-fixture',
    rank: 1,
    version: '1',
    progress: { mode: 'record', maxAttempts: 2 },
    distill,
    ...overrides,
  }
}

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

interface DeferredValue<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferredValue<T>(): DeferredValue<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** A store whose first progress write fails after the candidate has been applied. */
class FailingProgressStore extends FakeMemoryStore {
  private failOnce = true

  override async putProgress(progress: Parameters<FakeMemoryStore['putProgress']>[0]): Promise<void> {
    if (this.failOnce) {
      this.failOnce = false
      throw new Error('progress write failed')
    }
    return super.putProgress(progress)
  }
}

/** A store whose second progress write fails after the first row was consumed. */
class FailingSecondProgressStore extends FakeMemoryStore {
  private writes = 0

  override async putProgress(progress: Parameters<FakeMemoryStore['putProgress']>[0]): Promise<void> {
    this.writes++
    if (this.writes === 2) throw new Error('second progress write failed')
    return super.putProgress(progress)
  }
}

describe('durable consolidation progress', () => {
  it('advances on a successful empty check without inventing a citation', async () => {
    const { runtime, store } = harness()
    const record = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'ordinary conversation', fidelity: 'verbatim',
    })
    let calls = 0
    runtime.registerDistiller(progressDistiller(() => {
      calls++
      return Promise.resolve({ nodes: [], edges: [] })
    }))
    const diagnostics: unknown[] = []
    const first = await runtime.consolidate(workspace, { onDiagnostic: diagnostic => diagnostics.push(diagnostic) })
    expect(first.examined).toBe(1)
    expect(calls).toBe(1)
    expect(store.getRecord(record.id)?.promotedTo).toEqual([])
    expect([...store.progressRows.values()]).toMatchObject([
      { distiller: 'progress-fixture', version: '1', status: 'empty', attempts: 1 },
    ])
    expect(diagnostics[0]).toMatchObject({
      distiller: 'progress-fixture', version: '1', mode: 'record',
      pending: 1, window: 1, advanced: 1, failed: 0,
    })

    expect((await runtime.consolidate(workspace)).examined).toBe(0)
    expect(calls).toBe(1)
  })

  it('does not advance on a failed distill, then retries and applies', async () => {
    const { runtime, store } = harness()
    const record = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim',
    })
    let calls = 0
    let fail = true
    runtime.registerDistiller(progressDistiller(() => {
      calls++
      if (fail) return Promise.reject(new Error('distiller unavailable'))
      return Promise.resolve({
        nodes: [{
          type: 'preference', label: 'pnpm over npm', summary: 'I prefer pnpm over npm.',
          confidence: 0.6, evidence: [record.id],
        }],
        edges: [],
      })
    }))

    await expect(runtime.consolidate(workspace)).rejects.toThrow('distiller unavailable')
    expect([...store.progressRows.values()]).toMatchObject([{ status: 'failed', attempts: 1 }])
    fail = false
    const retry = await runtime.consolidate(workspace)
    expect(retry.examined).toBe(1)
    expect(retry.nodesCreated).toBe(1)
    expect(calls).toBe(2)
    expect([...store.progressRows.values()]).toMatchObject([{ status: 'proposed', attempts: 2 }])
  })

  it('bounds retries and stops rescanning after the attempt cap', async () => {
    const { runtime, store } = harness()
    await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'ordinary conversation', fidelity: 'verbatim',
    })
    let calls = 0
    runtime.registerDistiller(progressDistiller(
      () => { calls++; return Promise.reject(new Error('still down')) },
      { progress: { mode: 'record', maxAttempts: 2 } },
    ))
    await expect(runtime.consolidate(workspace)).rejects.toThrow('still down')
    await expect(runtime.consolidate(workspace)).rejects.toThrow('still down')
    expect([...store.progressRows.values()]).toMatchObject([{ status: 'failed', attempts: 2 }])
    const exhausted = await runtime.consolidate(workspace)
    expect(exhausted.examined).toBe(0)
    expect(calls).toBe(2)
  })

  it('does not advance or consume an attempt when the pass is cancelled', async () => {
    const { runtime, store } = harness()
    await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'ordinary conversation', fidelity: 'verbatim',
    })
    const controller = new AbortController()
    controller.abort()
    runtime.registerDistiller(progressDistiller(() => Promise.reject(new Error('cancelled'))))
    await expect(runtime.consolidate(workspace, { signal: controller.signal })).rejects.toThrow(/aborted/)
    expect(store.progressRows.size).toBe(0)
  })

  it('does not call a distiller at all when the pass was already aborted', async () => {
    const { runtime, store } = harness()
    await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'ordinary conversation', fidelity: 'verbatim',
    })
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    runtime.registerDistiller(progressDistiller(() => {
      calls++
      return Promise.resolve({ nodes: [], edges: [] })
    }))
    await expect(runtime.consolidate(workspace, { signal: controller.signal })).rejects.toThrow(/aborted/)
    expect(calls).toBe(0)
    expect(store.progressRows.size).toBe(0)
  })

  it('does not apply candidates or advance progress when aborted before distill returns', async () => {
    const { runtime, store } = harness()
    const record = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim',
    })
    const controller = new AbortController()
    const started = deferred()
    const gate = deferredValue<MemoryDistillation>()
    runtime.registerDistiller(progressDistiller(() => {
      started.resolve()
      return gate.promise
    }))
    const pending = runtime.consolidate(workspace, { signal: controller.signal })
    await started.promise
    controller.abort()
    gate.resolve({
      nodes: [{
        type: 'preference', label: 'pnpm over npm', summary: 'I prefer pnpm over npm.',
        confidence: 0.6, evidence: [record.id],
      }],
      edges: [],
    })
    await expect(pending).rejects.toThrow(/aborted/)
    expect(store.nodeRows.size).toBe(0)
    expect(store.progressRows.size).toBe(0)
  })

  it('does not resurrect an erased record when an in-flight distill returns a candidate', async () => {
    const { runtime, store } = harness()
    const record = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim',
    })
    const started = deferred()
    const gate = deferredValue<MemoryDistillation>()
    runtime.registerDistiller(progressDistiller(() => {
      started.resolve()
      return gate.promise
    }))
    const pending = runtime.consolidate(workspace)
    await started.promise
    await runtime.forget(record.id)
    gate.resolve({
      nodes: [{
        type: 'preference', label: 'pnpm over npm', summary: 'I prefer pnpm over npm.',
        confidence: 0.6, evidence: [record.id],
      }],
      edges: [],
    })
    await expect(pending).rejects.toThrow(/active record/)
    expect(store.getRecord(record.id)).toBeUndefined()
    expect(store.nodeRows.size).toBe(0)
    expect(store.progressRows.size).toBe(0)
  })

  it('keeps already-consumed rows when a later progress write fails', async () => {
    const store = new FailingSecondProgressStore()
    const { runtime } = harness(store)
    const first = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'first record', fidelity: 'verbatim', at: 1,
    })
    const second = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'second record', fidelity: 'verbatim', at: 2,
    })
    let calls = 0
    runtime.registerDistiller(progressDistiller(() => {
      calls++
      return Promise.resolve({ nodes: [], edges: [] })
    }))

    await expect(runtime.consolidate(workspace)).rejects.toThrow('second progress write failed')
    expect(store.progressRows.size).toBe(1)
    expect([...store.progressRows.values()][0]?.record).toBe(first.id)
    expect([...store.progressRows.values()].some(row => row.record === second.id)).toBe(false)

    const retry = await runtime.consolidate(workspace)
    expect(retry.examined).toBe(1)
    expect(calls).toBe(2)
    expect(store.progressRows.size).toBe(2)
  })

  it('replays records when the distiller version changes', async () => {
    const { runtime, store } = harness()
    await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'ordinary conversation', fidelity: 'verbatim',
    })
    let calls = 0
    const disposeV1 = runtime.registerDistiller(progressDistiller(() => {
      calls++
      return Promise.resolve({ nodes: [], edges: [] })
    }))
    await runtime.consolidate(workspace)
    expect(await runtime.consolidate(workspace)).toMatchObject({ examined: 0 })
    expect(calls).toBe(1)
    disposeV1()
    runtime.registerDistiller(progressDistiller(
      () => { calls++; return Promise.resolve({ nodes: [], edges: [] }) },
      { version: '2' },
    ))
    expect((await runtime.consolidate(workspace)).examined).toBe(1)
    expect(calls).toBe(2)
    expect([...store.progressRows.values()].map(row => row.version).sort()).toEqual(['1', '2'])
  })

  it('deduplicates concurrent passes for one scope', async () => {
    const { runtime } = harness()
    await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'ordinary conversation', fidelity: 'verbatim',
    })
    const gate = deferred()
    let calls = 0
    runtime.registerDistiller(progressDistiller(async () => {
      calls++
      await gate.promise
      return { nodes: [], edges: [] }
    }))
    const first = runtime.consolidate(workspace)
    const second = runtime.consolidate(workspace)
    gate.resolve()
    const [left, right] = await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(left).toBe(right)
  })

  it('keeps a repeated behavior across turns by using bounded lookback', async () => {
    const { runtime } = harness()
    runtime.registerDistiller(new BehaviorCycleDistiller(100, behaviorPolicy))
    for (let turn = 0; turn < 3; turn++) {
      await runtime.remember({
        scope: workspace,
        kind: 'skill-invocation',
        text: 'deploy',
        fidelity: 'summary',
        provenance: { skill: 'deploy', sessionId: 's1' as never, turn },
        at: turn + 1,
      })
      const report = await runtime.consolidate(workspace)
      expect(report.nodesCreated).toBe(turn === 2 ? 1 : 0)
    }
    expect((await runtime.consolidate(workspace)).examined).toBe(0)
  })

  it('retries after a progress-write failure without reinforcing the applied candidate twice', async () => {
    const store = new FailingProgressStore()
    const { runtime } = harness(store)
    const record = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim',
    })
    runtime.registerDistiller(progressDistiller(() => Promise.resolve({
      nodes: [{
        type: 'preference', label: 'pnpm over npm', summary: 'I prefer pnpm over npm.',
        confidence: 0.6, evidence: [record.id],
      }],
      edges: [],
    })))

    await expect(runtime.consolidate(workspace)).rejects.toThrow('progress write failed')
    expect(store.nodeRows.size).toBe(1)
    const applied = [...store.nodeRows.values()][0]
    expect(applied?.support.reinforcements).toBe(0)

    const retry = await runtime.consolidate(workspace)
    expect(retry.nodesCreated).toBe(0)
    expect(retry.nodesReinforced).toBe(0)
    expect([...store.nodeRows.values()][0]?.support.reinforcements).toBe(0)
    expect([...store.progressRows.values()]).toMatchObject([{ status: 'proposed' }])
  })

  it('keeps legacy distillers on the promotedTo pending rule', async () => {
    const { runtime, store } = harness()
    const record: MemoryRecord = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim',
    })
    let calls = 0
    runtime.registerDistiller({
      name: 'legacy-fixture',
      rank: 1,
      distill: () => {
        calls++
        return Promise.resolve({
          nodes: [{
            type: 'preference', label: 'pnpm over npm', summary: 'I prefer pnpm over npm.',
            confidence: 0.6, evidence: [record.id],
          }],
          edges: [],
        })
      },
    })
    await runtime.consolidate(workspace)
    expect(store.getRecord(record.id)?.promotedTo).toEqual(['consolidated'])
    expect(await runtime.consolidate(workspace)).toMatchObject({ examined: 0 })
    expect(calls).toBe(1)
  })
})

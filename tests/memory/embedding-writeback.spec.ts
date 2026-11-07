import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryRuntime from '../../src/memory/index.ts'
import type {
  Config,
  MemoryEmbedder,
  MemoryRecord,
  MemoryRecordId,
  MemoryScope,
} from '../../src/memory/index.ts'
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

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function deferredEmbedder(): {
  readonly embedder: MemoryEmbedder
  readonly started: Promise<void>
  readonly vector: Deferred<readonly number[]>
} {
  const started = deferred<void>()
  const vector = deferred<readonly number[]>()
  return {
    started: started.promise,
    vector,
    embedder: {
      name: 'deferred',
      dimensions: 3,
      embed: async () => {
        started.resolve()
        return [await vector.promise]
      },
    },
  }
}

function harness(store = new FakeMemoryStore()) {
  const ctx = new Context()
  const runtime = new MemoryRuntime(ctx, memoryConfig)
  runtime.registerStore(store)
  return { ctx, runtime, store }
}

function onlyRecordId(store: FakeMemoryStore): MemoryRecordId {
  const [id] = [...store.recordRows.keys()]
  if (id === undefined) throw new Error('expected a persisted record')
  return id as MemoryRecordId
}

function latestRecordId(store: FakeMemoryStore): MemoryRecordId {
  const rows = [...store.recordRows.values()]
  const last = rows[rows.length - 1]
  if (last === undefined) throw new Error('expected a persisted record')
  return last.id
}

/** A store whose second write waits, so the vector writeback can be observed mid-flight. */
class DeferredSecondPutStore extends FakeMemoryStore {
  readonly vectorWriteStarted = deferred<void>()
  readonly vectorWriteGate = deferred<void>()
  private readonly puts = new Map<string, number>()

  override async putRecord(record: MemoryRecord): Promise<void> {
    const count = (this.puts.get(record.id) ?? 0) + 1
    this.puts.set(record.id, count)
    if (count === 2) {
      this.vectorWriteStarted.resolve()
      await this.vectorWriteGate.promise
    }
    return super.putRecord(record)
  }
}

/** A store whose second write fails, proving a persistence error is not an embedding outage. */
class FailingSecondPutStore extends FakeMemoryStore {
  private readonly puts = new Map<string, number>()

  override async putRecord(record: MemoryRecord): Promise<void> {
    const count = (this.puts.get(record.id) ?? 0) + 1
    this.puts.set(record.id, count)
    if (count === 2) throw new Error('store write failed')
    return super.putRecord(record)
  }
}

const immediateVector: MemoryEmbedder = {
  name: 'immediate',
  dimensions: 3,
  embed: texts => Promise.resolve(texts.map(() => [1, 0, 0])),
}

describe('deferred embedding writeback', () => {
  it('does not resurrect a record erased while embedding is in flight', async () => {
    const { ctx, runtime, store } = harness()
    const prior = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'deploy uses friday', fidelity: 'verbatim',
    })
    const events: string[] = []
    ctx.on('memory/recorded', record => { events.push(record.id) })
    const pending = deferredEmbedder()
    runtime.registerEmbedder(pending.embedder)

    const remembering = runtime.remember({
      scope: workspace, kind: 'user-message', text: 'actually, deploy uses monday', fidelity: 'verbatim',
    })
    await pending.started
    const correction = latestRecordId(store)
    await runtime.forget(correction)
    pending.vector.resolve([1, 0, 0])
    await remembering

    expect(store.getRecord(correction)).toBeUndefined()
    expect(store.getRecord(prior.id)?.supersededBy).toBeUndefined()
    expect(events).not.toContain(correction)
  })

  it('does not attach a late vector to a record retracted while embedding is in flight', async () => {
    const { ctx, runtime, store } = harness()
    const events: string[] = []
    ctx.on('memory/recorded', record => { events.push(record.id) })
    const pending = deferredEmbedder()
    runtime.registerEmbedder(pending.embedder)
    const remembering = runtime.remember({
      scope: workspace, kind: 'note', text: 'deploy on friday', fidelity: 'verbatim',
    })
    await pending.started
    const id = onlyRecordId(store)
    await runtime.retract({ kind: 'record', id })
    pending.vector.resolve([1, 0, 0])
    await remembering

    expect(store.getRecord(id)?.status).toBe('retracted')
    expect(store.getRecord(id)?.embedding).toBeUndefined()
    expect(events).toEqual([])
  })

  it('serializes the vector write with forget instead of deadlocking or reviving', async () => {
    const store = new DeferredSecondPutStore()
    const { runtime } = harness(store)
    runtime.registerEmbedder(immediateVector)

    const remembering = runtime.remember({
      scope: workspace, kind: 'note', text: 'deploy on friday', fidelity: 'verbatim',
    })
    await store.vectorWriteStarted.promise
    const id = onlyRecordId(store)
    const forgetting = runtime.forget(id)
    store.vectorWriteGate.resolve()
    await remembering
    await forgetting

    expect(store.getRecord(id)).toBeUndefined()
  })

  it('propagates a vector-write persistence failure instead of treating it as an embedding outage', async () => {
    const store = new FailingSecondPutStore()
    const { runtime } = harness(store)
    runtime.registerEmbedder(immediateVector)

    await expect(runtime.remember({
      scope: workspace, kind: 'note', text: 'deploy on friday', fidelity: 'verbatim',
    })).rejects.toThrow('store write failed')

    const id = onlyRecordId(store)
    expect(store.getRecord(id)?.text).toBe('deploy on friday')
    expect(store.getRecord(id)?.embedding).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import type {
  MemoryDistillInput,
  MemoryNode,
  MemoryRecord,
  MemoryRecordId,
  MemoryScopeKey,
} from '../../src/memory/index.ts'
import { SemanticRequestError } from '../../src/memory-consolidation/model.ts'
import type { SemanticModel } from '../../src/memory-consolidation/model.ts'
import { SemanticPreferenceDistiller } from '../../src/memory-consolidation/semantic.ts'
import type { SemanticPolicy } from '../../src/memory-consolidation/semantic.ts'

const policy: SemanticPolicy = {
  semanticEnabled: true,
  semanticMaxRecords: 4,
  semanticMaxInputCharacters: 4_000,
  semanticMaxOutputBytes: 16_384,
  semanticMaxCandidates: 4,
  semanticMaxExistingNodes: 8,
  semanticMaxTokens: 400,
  semanticTemperature: 0,
  semanticTimeoutMs: 1_000,
  semanticMaxFieldLength: 160,
  semanticMaxCallsPerPass: 1,
  semanticMaxConcurrentCalls: 1,
  semanticPromptVersion: 'semantic-test',
  progressMaxAttempts: 2,
  maxConfidence: 0.85,
}

const route = { provider: 'provider-a', model: 'model-a' }
const scope = 'workspace:/repo' as MemoryScopeKey
let counter = 0

function record(text: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: `mem-r-${++counter}` as MemoryRecordId,
    scope,
    kind: 'user-message',
    text,
    fidelity: 'verbatim',
    use: 'recallable',
    terms: [],
    attachments: [],
    provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
    createdAt: counter,
    promotedTo: [],
    status: 'active',
    ...overrides,
  }
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'preference',
    operation: 'addition',
    subject: 'pnpm',
    attribute: 'package manager',
    applicability: 'global',
    cardinality: 'single',
    value: 'pnpm over npm',
    summary: 'Prefers pnpm over npm',
    quote: 'I prefer pnpm over npm',
    evidence: ['r1'],
    attribution: 'user',
    durability: 'long-term',
    confidence: 0.8,
    ...overrides,
  }
}

function semanticNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'mem-n-old' as never,
    scope,
    type: 'preference',
    label: 'pnpm: package manager [global/single]=pnpm over npm',
    summary: 'Prefers pnpm over npm',
    attributes: {
      subject: 'pnpm',
      attribute: 'package manager',
      applicability: 'global',
      cardinality: 'single',
      value: 'pnpm over npm',
      source: 'semantic',
      factKey: 'preference\u0000pnpm\u0000package manager\u0000global\u0000single\u0000pnpm over npm',
    },
    confidence: 0.8,
    decay: { halfLifeMs: null },
    support: { observations: 1, reinforcements: 0, contradictions: 0, sessions: 1, firstSeenAt: 0, lastSeenAt: 0 },
    evidence: [],
    origin: 'inferred',
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function response(candidates: readonly Record<string, unknown>[]): { text: string; usage: { inputTokens: number; outputTokens: number } } {
  return {
    text: JSON.stringify({ candidates }),
    usage: { inputTokens: 10, outputTokens: 5 },
  }
}

function distillerWith(
  result:
    | Awaited<ReturnType<SemanticModel['complete']>>
    | (() => Promise<Awaited<ReturnType<SemanticModel['complete']>>>),
) {
  const model: SemanticModel = {
    name: 'fake',
    complete: typeof result === 'function' ? result : () => Promise.resolve(result),
  }
  return new SemanticPreferenceDistiller(120, policy, () => model)
}

function input(records: readonly MemoryRecord[], overrides: Partial<MemoryDistillInput> = {}): MemoryDistillInput {
  return { scope, records, existing: [], route, sessionId: 's1', ...overrides }
}

async function expectRejectCode(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(promise).rejects.toThrow(pattern)
}

describe('SemanticPreferenceDistiller', () => {
  it('accepts a user-attributed long-term candidate with a verbatim quote', async () => {
    const source = record('I prefer pnpm over npm.')
    const distillation = await distillerWith(response([candidate()])).distill(input([source]))
    expect(distillation.nodes).toHaveLength(1)
    expect(distillation.nodes[0]).toMatchObject({
      type: 'preference',
      label: 'pnpm: package manager [global/single]=pnpm over npm',
      summary: 'Prefers pnpm over npm',
      confidence: 0.8,
      evidence: [source.id],
      merge: 'exact',
    })
    expect(distillation.consumedRecordIds).toEqual([source.id])
    expect(distillation.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it('exposes distinct progress identities for prompt, config and model routes', () => {
    const distiller = new SemanticPreferenceDistiller(120, policy, () => ({ name: 'fake', complete: () => Promise.resolve(response([])) }))
    const a = distiller.progressVersion({ provider: 'p', model: 'a' })
    const b = distiller.progressVersion({ provider: 'p', model: 'b' })
    expect(a).not.toBe(b)
    expect(a).toContain('semantic-test')
    const other = new SemanticPreferenceDistiller(120, { ...policy, semanticMaxRecords: 5 }, () => ({
      name: 'fake', complete: () => Promise.resolve(response([])),
    }))
    expect(other.progressVersion({ provider: 'p', model: 'a' })).not.toBe(a)
  })

  it('states addition target emptiness and replacement alias only in the semantic-v4 prompt', async () => {
    let system = ''
    const model: SemanticModel = {
      name: 'fake',
      complete: value => {
        system = value
        return Promise.resolve(response([]))
      },
    }
    const distiller = new SemanticPreferenceDistiller(120, policy, () => model)
    await distiller.distill(input([record('List the files.')]))
    expect(distiller.version).toBe('4')
    expect(distiller.progressVersion(route)).toContain('semantic-v4')
    expect(system).toContain('"operation":"addition","target":""')
    expect(system).toContain('"operation":"replacement","target":"n1"')
    expect(system).toContain('addition: target must be "" (or omit target)')
    expect(system).toContain('only names the old node, never the new subject')
  })

  it('reads Chinese negation as a constraint', async () => {
    const source = record('不要使用 npm 安装依赖。')
    const distillation = await distillerWith(response([candidate({
      type: 'constraint',
      subject: 'npm',
      attribute: 'install command',
      value: 'do not use npm',
      summary: '不要在安装依赖时使用 npm',
      quote: '不要使用 npm 安装依赖。',
    })])).distill(input([source]))
    expect(distillation.nodes[0]).toMatchObject({ type: 'constraint', evidence: [source.id] })
  })

  it('rejects quoted, third-party, roleplay, ghostwriting and assistant attributions', async () => {
    const source = record('They said: "I prefer tabs".')
    for (const attribution of ['quoted', 'third-party', 'roleplay', 'ghostwriting', 'assistant']) {
      const distillation = await distillerWith(response([candidate({ attribution })])).distill(input([source]))
      expect(distillation.nodes).toEqual([])
      expect(distillation.failed?.[0]).toMatchObject({ record: source.id, reason: 'invalid-output' })
      expect(distillation.consumedRecordIds).toEqual([])
    }
  })

  it('rejects a task-local instruction instead of making it a long-term belief', async () => {
    const source = record('For this task, use Yarn.')
    const distillation = await distillerWith(response([candidate({
      subject: 'yarn', attribute: 'package manager', value: 'yarn', quote: 'For this task, use Yarn.',
      durability: 'task-local',
    })])).distill(input([source]))
    expect(distillation.nodes).toEqual([])
    expect(distillation.failed?.[0]).toMatchObject({ reason: 'invalid-output' })
  })

  it('rejects a placeholder quote as evidence', async () => {
    const source = record('I prefer pnpm over npm.')
    const distillation = await distillerWith(response([candidate({
      quote: '[redacted:secret-assignment]',
    })])).distill(input([source]))
    expect(distillation.nodes).toEqual([])
    expect(distillation.failed?.[0]).toMatchObject({ reason: 'invalid-output' })
  })

  it('rejects a quote that is not present in the cited record', async () => {
    const source = record('I prefer pnpm over npm.')
    const distillation = await distillerWith(response([candidate({ quote: 'I prefer yarn' })])).distill(input([source]))
    expect(distillation.nodes).toEqual([])
    expect(distillation.failed?.[0]).toMatchObject({ reason: 'invalid-output' })
  })

  it('rejects an alias, cross-session record, assistant record or tool record', async () => {
    const source = record('I prefer pnpm over npm.')
    const otherSession = record('I prefer yarn over pnpm.', { provenance: { author: 'user', sessionId: 's2' as never, turn: 1 } })
    const assistant = record('I prefer yarn.', { kind: 'assistant-message', use: 'evidence' })
    const tool = record('bash — I prefer yarn.', { kind: 'tool-invocation', use: 'evidence' })
    const distillation = await distillerWith(response([
      candidate({ evidence: ['r9'] }),
      candidate({ evidence: ['r2'] }),
    ])).distill(input([source, otherSession, assistant, tool]))
    expect(distillation.nodes).toEqual([])
    expect(distillation.failed?.[0]).toMatchObject({ record: source.id, reason: 'invalid-output' })
    expect(distillation.consumedRecordIds).toEqual([])
  })

  it('fails the batch on malformed JSON, missing candidates, or too many candidates', async () => {
    const source = record('I prefer pnpm over npm.')
    for (const text of [
      'not json',
      '{}',
      JSON.stringify({ candidates: [candidate(), candidate(), candidate(), candidate(), candidate()] }),
      JSON.stringify({ candidates: [{ type: 'tool-affinity' }] }),
    ]) {
      const distillation = await distillerWith({ text, usage: { inputTokens: 1, outputTokens: 1 } }).distill(input([source]))
      expect(distillation.nodes).toEqual([])
      expect(distillation.failed?.[0]).toMatchObject({ record: source.id, reason: 'invalid-output' })
      expect(distillation.consumedRecordIds).toEqual([])
    }
  })

  it('does not treat a timeout or byte-limit failure as a successful empty result', async () => {
    const source = record('I prefer pnpm over npm.')
    for (const [code, expected] of [['timeout', 'timeout'], ['output-limit', 'output-limit']] as const) {
      const distillation = await distillerWith(() => Promise.reject(new SemanticRequestError(code)))
        .distill(input([source]))
      expect(distillation.nodes).toEqual([])
      expect(distillation.failed?.[0]).toMatchObject({ record: source.id, reason: expected })
      expect(distillation.consumedRecordIds).toEqual([])
    }
  })

  it('advances only the records actually read by a partial call', async () => {
    const first = record('I prefer pnpm over npm.')
    const second = record('I prefer dark mode.')
    const partial = new SemanticPreferenceDistiller(
      120,
      { ...policy, semanticMaxRecords: 1 },
      () => ({
        name: 'fake',
        complete: () => Promise.resolve(response([])),
      }),
    )
    const distillation = await partial.distill(input([first, second]))
    expect(distillation.consumedRecordIds).toEqual([first.id])
    expect(distillation.nodes).toEqual([])
  })

  it('skips one oversized input and still processes later records', async () => {
    const huge = record('x'.repeat(5_000))
    const small = record('I prefer pnpm over npm.')
    const smallPolicy = { ...policy, semanticMaxInputCharacters: 2_000 }
    const smallDistiller = new SemanticPreferenceDistiller(120, smallPolicy, () => ({
      name: 'fake',
      complete: () => Promise.resolve(response([])),
    }))
    const distillation = await smallDistiller.distill(input([huge, small]))
    expect(distillation.skipped).toEqual([{ record: huge.id, reason: 'input-too-large' }])
    expect(distillation.consumedRecordIds).toEqual([small.id])
  })

  it('deduplicates a fact already produced by the fixed-phrase miner', async () => {
    const source = record('I prefer pnpm over npm.')
    const existing: MemoryNode = {
      id: 'mem-n-existing' as never,
      scope,
      type: 'preference',
      label: 'pnpm over npm',
      summary: 'I prefer pnpm over npm',
      attributes: {},
      confidence: 0.8,
      decay: { halfLifeMs: null },
      support: { observations: 1, reinforcements: 0, contradictions: 0, sessions: 1, firstSeenAt: 0, lastSeenAt: 0 },
      evidence: [source.id],
      origin: 'inferred',
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    }
    const distillation = await distillerWith(response([candidate()])).distill(input([source], { existing: [existing] }))
    expect(distillation.nodes).toEqual([])
    expect(distillation.failed).toBeUndefined()
    expect(distillation.consumedRecordIds).toEqual([source.id])
  })

  it('returns the same-fact candidate so the hub can merge new evidence', async () => {
    const source = record('Again, pnpm is my package manager.')
    const existing = semanticNode()
    const distillation = await distillerWith(response([candidate({
      quote: 'pnpm is my package manager',
      summary: 'Uses pnpm as package manager',
    })])).distill(input([source], { existing: [existing] }))
    expect(distillation.nodes).toHaveLength(1)
    expect(distillation.nodes[0]).toMatchObject({
      label: 'pnpm: package manager [global/single]=pnpm over npm',
      evidence: [source.id],
      merge: 'exact',
    })
  })

  it('keeps the same value in different applicability scopes as separate facts', async () => {
    const source = record('At work I use pnpm over npm.')
    const existing = semanticNode({
      attributes: { ...semanticNode().attributes, applicability: 'work' },
    })
    const distillation = await distillerWith(response([candidate({
      applicability: 'home',
      quote: 'At work I use pnpm over npm',
    })])).distill(input([source], { existing: [existing] }))
    expect(distillation.nodes).toHaveLength(1)
    expect(distillation.nodes[0]?.label).toContain('[home/single]')
    expect(distillation.nodes[0]?.label).not.toContain('[work/single]')
  })

  it('keeps the same value with different cardinality as separate facts', async () => {
    const source = record('I can use pnpm over npm in several places.')
    const existing = semanticNode()
    const distillation = await distillerWith(response([candidate({
      cardinality: 'multiple',
      quote: 'pnpm over npm in several places',
    })])).distill(input([source], { existing: [existing] }))
    expect(distillation.nodes).toHaveLength(1)
    expect(distillation.nodes[0]?.label).toContain('[global/multiple]')
    expect(distillation.nodes[0]?.label).not.toContain('[global/single]')
  })

  it('does not retire the old node when a replacement repeats the same value', async () => {
    const source = record('I still use pnpm over npm.')
    const existing = semanticNode()
    const distillation = await distillerWith(response([candidate({
      operation: 'replacement',
      target: 'n1',
      quote: 'I still use pnpm over npm',
    })])).distill(input([source], { existing: [existing] }))
    expect(distillation.replacements).toBeUndefined()
    expect(distillation.nodes).toHaveLength(1)
    expect(distillation.nodes[0]?.label).toContain('[global/single]')
  })

  it('proposes an explicit replacement for a matching stable single-value fact', async () => {
    const source = record('Actually, use yarn instead of pnpm.')
    const existing = semanticNode()
    const distillation = await distillerWith(response([candidate({
      operation: 'replacement',
      target: 'n1',
      value: 'pnpm over yarn',
      summary: 'Prefers yarn over pnpm',
      quote: 'use yarn instead of pnpm',
    })])).distill(input([source], { existing: [existing] }))
    expect(distillation.nodes).toEqual([])
    expect(distillation.replacements).toHaveLength(1)
    expect(distillation.replacements?.[0]).toMatchObject({
      target: existing.id,
      type: 'preference',
      evidence: [source.id],
      quote: 'use yarn instead of pnpm',
    })
    expect(distillation.consumedRecordIds).toEqual([source.id])
  })

  it('keeps an unconfirmed replacement as a reviewed addition when cardinality is multiple', async () => {
    const source = record('Also, pnpm is allowed with yarn.')
    const existing = semanticNode({
      attributes: { ...semanticNode().attributes, cardinality: 'multiple' },
    })
    const distillation = await distillerWith(response([candidate({
      operation: 'replacement',
      target: 'n1',
      value: 'pnpm over yarn',
      summary: 'Allows pnpm with yarn.',
      quote: 'pnpm is allowed with yarn',
    })])).distill(input([source], { existing: [existing] }))
    expect(distillation.replacements).toBeUndefined()
    expect(distillation.nodes[0]?.attributes).toMatchObject({
      review: 'unconfirmed-replacement',
      reviewTarget: existing.id,
    })
  })

  it('does not replace a legacy node without a stable semantic key', async () => {
    const source = record('Actually, use yarn instead of pnpm.')
    const existing = semanticNode({ attributes: {} })
    const distillation = await distillerWith(response([candidate({
      operation: 'replacement',
      target: 'n1',
      value: 'pnpm over yarn',
      summary: 'Prefers yarn over pnpm',
      quote: 'use yarn instead of pnpm',
    })])).distill(input([source], { existing: [existing] }))
    expect(distillation.replacements).toBeUndefined()
    expect(distillation.nodes[0]?.attributes).toMatchObject({ review: 'unconfirmed-replacement' })
  })

  it('does not replace across a different applicability context', async () => {
    const source = record('Actually, use yarn instead of pnpm.')
    const existing = semanticNode({
      attributes: { ...semanticNode().attributes, applicability: 'project-a' },
    })
    const distillation = await distillerWith(response([candidate({
      operation: 'replacement',
      target: 'n1',
      applicability: 'project-b',
      value: 'pnpm over yarn',
      summary: 'Prefers yarn over pnpm',
      quote: 'use yarn instead of pnpm',
    })])).distill(input([source], { existing: [existing] }))
    expect(distillation.replacements).toBeUndefined()
    expect(distillation.nodes[0]?.attributes).toMatchObject({ review: 'unconfirmed-replacement' })
  })

  it('does not replace across a different subject or entity', async () => {
    const source = record('Actually, use yarn for the other project.')
    const existing = semanticNode()
    const distillation = await distillerWith(response([candidate({
      operation: 'replacement',
      target: 'n1',
      subject: 'yarn',
      value: 'yarn over pnpm',
      summary: 'Prefers yarn for another entity',
      quote: 'use yarn for the other project',
    })])).distill(input([source], { existing: [existing] }))
    expect(distillation.replacements).toBeUndefined()
    expect(distillation.nodes[0]?.attributes).toMatchObject({ review: 'unconfirmed-replacement' })
  })

  it('rejects a replacement that names no provided existing alias', async () => {
    const source = record('Actually, use yarn instead of pnpm.')
    const distillation = await distillerWith(response([candidate({
      operation: 'replacement',
      target: 'n9',
      value: 'pnpm over yarn',
      summary: 'Prefers yarn over pnpm',
      quote: 'use yarn instead of pnpm',
    })])).distill(input([source], { existing: [semanticNode()] }))
    expect(distillation.nodes).toEqual([])
    expect(distillation.replacements).toBeUndefined()
    expect(distillation.failed?.[0]).toMatchObject({ reason: 'invalid-output' })
  })

  it('keeps a different value as a distinct fact rather than a topic merge', async () => {
    const source = record('I prefer pnpm over npm.')
    const existing: MemoryNode = {
      id: 'mem-n-pnpm' as never,
      scope,
      type: 'preference',
      label: 'pnpm: package manager [global/single]=pnpm over yarn',
      summary: 'Prefers pnpm over yarn',
      attributes: {
        subject: 'pnpm', attribute: 'package manager', value: 'pnpm over yarn',
        factKey: 'preference\u0000pnpm\u0000package manager\u0000global\u0000single\u0000pnpm over yarn',
      },
      confidence: 0.8,
      decay: { halfLifeMs: null },
      support: { observations: 1, reinforcements: 0, contradictions: 0, sessions: 1, firstSeenAt: 0, lastSeenAt: 0 },
      evidence: [],
      origin: 'inferred',
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    }
    const distillation = await distillerWith(response([candidate()])).distill(input([source], { existing: [existing] }))
    expect(distillation.nodes).toHaveLength(1)
    expect(distillation.nodes[0]?.label).toContain('pnpm over npm')
  })

  it('does not read a record from a different session', async () => {
    const s1 = record('I prefer pnpm over npm.', { provenance: { author: 'user', sessionId: 's1' as never, turn: 1 } })
    const s2 = record('I prefer yarn over pnpm.', { provenance: { author: 'user', sessionId: 's2' as never, turn: 1 } })
    const distillation = await distillerWith(response([candidate()])).distill(input([s1, s2]))
    expect(distillation.nodes[0]?.evidence).toEqual([s1.id])
    expect(distillation.consumedRecordIds).toEqual([s1.id])
  })

  it('does not read a same-session record from another scope', async () => {
    const source = record('I prefer pnpm over npm.')
    const other = record('I prefer yarn over npm.', { scope: 'workspace:/other' as MemoryScopeKey })
    let payload = ''
    const distiller = new SemanticPreferenceDistiller(120, policy, () => ({
      name: 'fake',
      complete: (_system, text) => {
        payload = text
        return Promise.resolve(response([candidate()]))
      },
    }))
    const distillation = await distiller.distill(input([source, other]))
    expect(payload).toContain(source.text)
    expect(payload).not.toContain(other.text)
    expect(distillation.nodes[0]?.evidence).toEqual([source.id])
    expect(distillation.consumedRecordIds).toEqual([source.id])
  })

  it('requires an explicit route and session rather than silently using another model', async () => {
    const source = record('I prefer pnpm over npm.')
    const distiller = distillerWith(response([candidate()]))
    const { route: _route, ...withoutRoute } = input([source])
    await expect(distiller.distill(withoutRoute)).rejects.toThrow(/session model route/)
    const { sessionId: _session, ...withoutSession } = input([source])
    await expect(distiller.distill(withoutSession)).rejects.toThrow(/session id/)
  })

  it('rethrows abort without consuming records', async () => {
    const source = record('I prefer pnpm over npm.')
    const controller = new AbortController()
    const model = new SemanticPreferenceDistiller(120, policy, () => ({
      name: 'fake',
      complete: () => new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new SemanticRequestError('aborted')), { once: true })
      }),
    }))
    const pending = model.distill(input([source], { signal: controller.signal }))
    controller.abort()
    await expectRejectCode(pending, /aborted/)
  })

  it('uses multiple bounded calls when the pass budget allows it', async () => {
    const first = record('I prefer pnpm over npm.')
    const second = record('I prefer dark mode.')
    const distiller = new SemanticPreferenceDistiller(
      120,
      { ...policy, semanticMaxRecords: 1, semanticMaxCallsPerPass: 2 },
      () => ({ name: 'fake', complete: () => Promise.resolve(response([])) }),
    )
    const distillation = await distiller.distill(input([first, second]))
    expect(distillation.consumedRecordIds).toEqual([first.id, second.id])
  })

  it('removes an aborted waiter immediately and transfers its slot to the next waiter', async () => {
    const a = record('I prefer pnpm over npm.')
    const b = record('I prefer yarn.')
    const c = record('I prefer dark mode.')
    const d = record('I prefer tabs.')
    let calls = 0
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    let aStarted!: () => void
    const aStartedPromise = new Promise<void>((resolve) => { aStarted = resolve })
    const distiller = new SemanticPreferenceDistiller(
      120,
      { ...policy, semanticMaxConcurrentCalls: 1 },
      () => ({
        name: 'fake',
        complete: () => {
          calls++
          if (calls === 1) {
            aStarted()
            return gateA.then(() => response([]))
          }
          return Promise.resolve(response([]))
        },
      }),
    )
    const controllerB = new AbortController()
    const first = distiller.distill(input([a]))
    await aStartedPromise
    const second = distiller.distill(input([b], { signal: controllerB.signal }))
    const third = distiller.distill(input([c]))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(1)
    controllerB.abort()
    await expect(second).rejects.toBeDefined()
    releaseA()
    await Promise.all([first, third])
    expect(calls).toBe(2)
    await distiller.distill(input([d]))
    expect(calls).toBe(3)
  })

  it('honors the configured concurrent-call bound', async () => {
    const first = record('I prefer pnpm over npm.')
    const second = record('I prefer dark mode.')
    let active = 0
    let maxActive = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const distiller = new SemanticPreferenceDistiller(
      120,
      { ...policy, semanticMaxConcurrentCalls: 1 },
      () => ({
        name: 'fake',
        complete: async () => {
          active++
          maxActive = Math.max(maxActive, active)
          started()
          await gate
          active--
          return response([])
        },
      }),
    )
    const left = distiller.distill(input([first]))
    await startedPromise
    const right = distiller.distill(input([second]))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(maxActive).toBe(1)
    release()
    await Promise.all([left, right])
    expect(maxActive).toBe(1)
  })
})

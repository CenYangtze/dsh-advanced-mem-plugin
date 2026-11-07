import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryRuntime from '../../src/memory/index.ts'
import type {
  Config,
  MemoryDistiller,
  MemoryModelRoute,
  MemoryRecord,
  MemoryRecordId,
  MemoryScope,
} from '../../src/memory/index.ts'
import { SemanticPreferenceDistiller } from '../../src/memory-consolidation/semantic.ts'
import type { SemanticPolicy } from '../../src/memory-consolidation/semantic.ts'
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
const route: MemoryModelRoute = { provider: 'provider-a', model: 'model-a' }

function harness(store = new FakeMemoryStore()) {
  const ctx = new Context()
  const runtime = new MemoryRuntime(ctx, memoryConfig)
  runtime.registerStore(store)
  return { ctx, runtime, store }
}

function fixture(consumed: (input: MemoryRecord[]) => MemoryRecordId[]): MemoryDistiller {
  return {
    name: 'semantic-fixture',
    rank: 120,
    version: '1',
    progress: { mode: 'record', maxAttempts: 2 },
    accepts: (record, context) => context.sessionId === undefined || record.provenance.sessionId === context.sessionId,
    distill: input => Promise.resolve({
      nodes: [],
      edges: [],
      consumedRecordIds: consumed([...input.records]),
      usage: { inputTokens: 7, outputTokens: 3 },
    }),
  }
}

const semanticPolicy: SemanticPolicy = {
  semanticEnabled: true,
  semanticMaxRecords: 2,
  semanticMaxInputCharacters: 4_000,
  semanticMaxOutputBytes: 8_000,
  semanticMaxCandidates: 4,
  semanticMaxExistingNodes: 8,
  semanticMaxTokens: 200,
  semanticTemperature: 0,
  semanticTimeoutMs: 1_000,
  semanticMaxFieldLength: 160,
  semanticMaxCallsPerPass: 1,
  semanticMaxConcurrentCalls: 1,
  semanticPromptVersion: 'semantic-test',
  progressMaxAttempts: 2,
  maxConfidence: 0.85,
}

describe('semantic consolidation progress', () => {
  it('advances only the records a partial window actually consumed', async () => {
    const { runtime, store } = harness()
    const first = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'first', fidelity: 'verbatim', at: 1,
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
    })
    const second = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'second', fidelity: 'verbatim', at: 2,
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
    })
    runtime.registerDistiller(fixture(records => records.slice(0, 1).map(record => record.id)))

    const diagnostics: unknown[] = []
    const firstPass = await runtime.consolidate(workspace, {
      route,
      sessionId: 's1',
      onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    })
    expect(firstPass.examined).toBe(2)
    expect([...store.progressRows.values()]).toHaveLength(1)
    expect([...store.progressRows.values()][0]?.record).toBe(first.id)
    expect(diagnostics[0]).toMatchObject({
      advanced: 1,
      usage: { inputTokens: 7, outputTokens: 3 },
    })

    const secondPass = await runtime.consolidate(workspace, { route, sessionId: 's1' })
    expect(secondPass.examined).toBe(1)
    expect([...store.progressRows.values()]).toHaveLength(2)
    expect([...store.progressRows.values()].some(row => row.record === second.id)).toBe(true)
  })

  it('isolates progress by model route and replays on a route change', async () => {
    const { runtime, store } = harness()
    await runtime.remember({ scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim' })
    let version = 'model-a'
    const distiller: MemoryDistiller = {
      name: 'route-fixture',
      rank: 120,
      progress: { mode: 'record', maxAttempts: 2 },
      progressVersion: () => version,
      distill: input => Promise.resolve({ nodes: [], edges: [], consumedRecordIds: input.records.map(record => record.id) }),
    }
    runtime.registerDistiller(distiller)
    expect((await runtime.consolidate(workspace, { route: { provider: 'p', model: 'a' }, sessionId: 's1' })).examined).toBe(1)
    expect((await runtime.consolidate(workspace, { route: { provider: 'p', model: 'a' }, sessionId: 's1' })).examined).toBe(0)

    version = 'model-b'
    expect((await runtime.consolidate(workspace, { route: { provider: 'p', model: 'b' }, sessionId: 's1' })).examined).toBe(1)
    expect([...store.progressRows.values()].map(row => row.version).sort()).toEqual(['model-a', 'model-b'])
  })

  it('does not let one session consume another session record', async () => {
    const { runtime, store } = harness()
    await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'first session', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
    })
    await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'second session', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's2' as never, turn: 1 },
    })
    runtime.registerDistiller(fixture(records => records.map(record => record.id)))
    await runtime.consolidate(workspace, { route, sessionId: 's1' })
    expect([...store.progressRows.values()]).toHaveLength(1)
    expect([...store.progressRows.values()][0]?.distiller).toBe('semantic-fixture')
    await runtime.consolidate(workspace, { route, sessionId: 's2' })
    expect([...store.progressRows.values()]).toHaveLength(2)
  })

  it('rejects a consumed id outside the input window', async () => {
    const { runtime } = harness()
    await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
    })
    runtime.registerDistiller({
      name: 'bad-consumer',
      rank: 120,
      progress: { mode: 'record', maxAttempts: 2 },
      distill: () => Promise.resolve({
        nodes: [],
        edges: [],
        consumedRecordIds: ['mem-r-not-in-input' as never],
      }),
    })
    await expect(runtime.consolidate(workspace, { route, sessionId: 's1' }))
      .rejects.toThrow(/outside its input window/)
  })

  it('writes failed progress, not a successful empty row, for invalid semantic output', async () => {
    const { runtime, store } = harness()
    const source = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
    })
    const distiller = new SemanticPreferenceDistiller(120, semanticPolicy, () => ({
      name: 'fake',
      complete: () => Promise.resolve({ text: 'not json', usage: { inputTokens: 1, outputTokens: 1 } }),
    }))
    runtime.registerDistiller(distiller)
    await runtime.consolidate(workspace, { route, sessionId: 's1' })
    const rows = [...store.progressRows.values()]
    expect(rows).toMatchObject([{ record: source.id, status: 'failed', attempts: 1 }])
    expect(store.nodeRows.size).toBe(0)
  })

  it('does not delete existing progress when the semantic distiller is absent', async () => {
    const { runtime, store } = harness()
    await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
    })
    const dispose = runtime.registerDistiller(fixture(records => records.map(record => record.id)))
    await runtime.consolidate(workspace, { route, sessionId: 's1' })
    expect(store.progressRows.size).toBe(1)
    dispose()
    await runtime.consolidate(workspace, { route, sessionId: 's1' })
    expect(store.progressRows.size).toBe(1)
  })

  it('keeps a different value as a separate node instead of topic-merging it', async () => {
    const { runtime, store } = harness()
    let text = JSON.stringify({ candidates: [{
      type: 'preference', operation: 'addition', subject: 'pnpm', attribute: 'comparison',
      applicability: 'global', cardinality: 'single', value: 'pnpm over npm',
      summary: 'Prefers pnpm over npm', quote: 'I prefer pnpm over npm',
      evidence: ['r1'], attribution: 'user', durability: 'long-term', confidence: 0.8,
    }] })
    const distiller = new SemanticPreferenceDistiller(120, semanticPolicy, () => ({
      name: 'fake',
      complete: () => Promise.resolve({ text, usage: { inputTokens: 1, outputTokens: 1 } }),
    }))
    runtime.registerDistiller(distiller)
    await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
    })
    await runtime.consolidate(workspace, { route, sessionId: 's1' })
    expect(store.nodeRows.size).toBe(1)

    text = JSON.stringify({ candidates: [{
      type: 'preference', operation: 'addition', subject: 'pnpm', attribute: 'comparison',
      applicability: 'global', cardinality: 'single', value: 'pnpm over yarn',
      summary: 'Prefers pnpm over yarn', quote: 'I prefer pnpm over yarn',
      evidence: ['r1'], attribution: 'user', durability: 'long-term', confidence: 0.8,
    }] })
    await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over yarn.', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 2 },
    })
    await runtime.consolidate(workspace, { route, sessionId: 's1' })
    expect(store.nodeRows.size).toBe(2)
  })

  it('merges new evidence into the same semantic fact instead of duplicating it', async () => {
    const { runtime, store } = harness()
    let text = JSON.stringify({ candidates: [{
      type: 'preference', operation: 'addition', subject: 'pnpm', attribute: 'package manager',
      applicability: 'global', cardinality: 'single', value: 'pnpm over npm',
      summary: 'Prefers pnpm over npm', quote: 'I prefer pnpm over npm',
      evidence: ['r1'], attribution: 'user', durability: 'long-term', confidence: 0.8,
    }] })
    const distiller = new SemanticPreferenceDistiller(120, semanticPolicy, () => ({
      name: 'fake',
      complete: () => Promise.resolve({ text, usage: { inputTokens: 1, outputTokens: 1 } }),
    }))
    runtime.registerDistiller(distiller)
    const first = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
    })
    await runtime.consolidate(workspace, { route, sessionId: 's1' })
    text = JSON.stringify({ candidates: [{
      type: 'preference', operation: 'addition', subject: 'pnpm', attribute: 'package manager',
      applicability: 'global', cardinality: 'single', value: 'pnpm over npm',
      summary: 'Uses pnpm as the package manager', quote: 'Again, pnpm over npm',
      evidence: ['r1'], attribution: 'user', durability: 'long-term', confidence: 0.8,
    }] })
    const second = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'Again, pnpm over npm.', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 2 },
    })
    await runtime.consolidate(workspace, { route, sessionId: 's1' })
    expect(store.nodeRows.size).toBe(1)
    const node = [...store.nodeRows.values()][0]
    expect(node?.evidence).toEqual([first.id, second.id])
    expect(node?.support.reinforcements).toBe(1)
  })

  it('filters historical record text before the semantic model payload', async () => {
    const { runtime, store } = harness()
    const legacy: MemoryRecord = {
      id: 'mem-r-legacy' as never,
      scope: 'workspace:/repo' as never,
      kind: 'user-message',
      text: 'I use token=abcdef123456 for deploys.',
      fidelity: 'verbatim',
      use: 'recallable',
      terms: [],
      attachments: [],
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
      createdAt: 1,
      promotedTo: [],
      status: 'active',
    }
    await store.putRecord(legacy)
    await store.putNode({
      id: 'mem-n-legacy' as never,
      scope: 'workspace:/repo' as never,
      type: 'preference',
      label: 'deploy config',
      summary: 'Deploy configuration.',
      attributes: { config: { password: 'hunter2' } },
      confidence: 0.9,
      decay: { halfLifeMs: null },
      support: { observations: 1, reinforcements: 0, contradictions: 0, sessions: 1, firstSeenAt: 1, lastSeenAt: 1 },
      evidence: ['mem-r-legacy' as never],
      origin: 'inferred',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    let payload = ''
    const distiller = new SemanticPreferenceDistiller(120, semanticPolicy, () => ({
      name: 'fake',
      complete: (_system, text) => {
        payload = text
        return Promise.resolve({ text: JSON.stringify({ candidates: [] }) })
      },
    }), text => runtime.filterExternalText(text))
    runtime.registerDistiller(distiller)
    await runtime.consolidate(workspace, { route, sessionId: 's1' })
    expect(payload).not.toContain('abcdef123456')
    expect(payload).not.toContain('hunter2')
    expect(payload).toContain('[redacted:secret-assignment]')
  })

  it('skips a blocked historical record with an explicit diagnostic', async () => {
    const blockedConfig: Config = {
      ...memoryConfig,
      safety: { ...memoryConfig.safety, blockedLiterals: ['Project Nightingale'] },
    }
    const ctx = new Context()
    const runtime = new MemoryRuntime(ctx, blockedConfig)
    const store = new FakeMemoryStore()
    runtime.registerStore(store)
    await store.putRecord({
      id: 'mem-r-blocked' as never,
      scope: 'workspace:/repo' as never,
      kind: 'user-message',
      text: 'Project Nightingale is the codename.',
      fidelity: 'verbatim',
      use: 'recallable',
      terms: [],
      attachments: [],
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
      createdAt: 1,
      promotedTo: [],
      status: 'active',
    })
    let calls = 0
    runtime.registerDistiller(new SemanticPreferenceDistiller(120, semanticPolicy, () => ({
      name: 'fake',
      complete: () => {
        calls++
        return Promise.resolve({ text: JSON.stringify({ candidates: [] }) })
      },
    }), text => runtime.filterExternalText(text)))
    await runtime.consolidate(workspace, { route, sessionId: 's1' })
    expect(calls).toBe(0)
    expect([...store.progressRows.values()]).toMatchObject([{
      record: 'mem-r-blocked',
      status: 'skipped',
      skipReason: 'blocked-sensitive',
    }])
  })

  it('turns a natural correction into a new node and a supersedes edge', async () => {
    const { runtime, store } = harness()
    let text = JSON.stringify({ candidates: [{
      type: 'preference', operation: 'addition', subject: 'pnpm', attribute: 'package manager',
      applicability: 'global', cardinality: 'single', value: 'pnpm over npm',
      summary: 'Prefers pnpm over npm', quote: 'I prefer pnpm over npm',
      evidence: ['r1'], attribution: 'user', durability: 'long-term', confidence: 0.8,
    }] })
    const distiller = new SemanticPreferenceDistiller(120, semanticPolicy, () => ({
      name: 'fake',
      complete: () => Promise.resolve({ text, usage: { inputTokens: 1, outputTokens: 1 } }),
    }))
    runtime.registerDistiller(distiller)
    const oldEvidence = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
    })
    await runtime.consolidate(workspace, { route, sessionId: 's1' })
    const old = [...store.nodeRows.values()][0]!

    text = JSON.stringify({ candidates: [{
      type: 'preference', operation: 'replacement', target: 'n1',
      subject: 'pnpm', attribute: 'package manager', applicability: 'global', cardinality: 'single',
      value: 'pnpm over yarn', summary: 'Prefers pnpm over yarn', quote: 'use yarn instead of pnpm',
      evidence: ['r1'], attribution: 'user', durability: 'long-term', confidence: 0.8,
    }] })
    const correction = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'Actually, use yarn instead of pnpm.', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 2 },
    })
    const report = await runtime.consolidate(workspace, { route, sessionId: 's1' })

    expect(report.replaced).toBe(1)
    expect(store.getNode(old.id)).toMatchObject({ status: 'superseded', supersededBy: store.getNode(old.id)?.supersededBy })
    const replacement = [...store.nodeRows.values()].find(node => node.status === 'active' && node.id !== old.id)
    expect(replacement?.evidence).toEqual([correction.id])
    expect(store.getNode(old.id)?.supersededBy).toBe(replacement?.id)
    expect(store.getNode(old.id)?.evidence).toEqual([oldEvidence.id])
    expect([...store.edgeRows.values()]).toMatchObject([{
      from: replacement?.id,
      to: old.id,
      relation: 'supersedes',
    }])
  })
})

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryRuntime from '../../src/memory/index.ts'
import type { Config, MemoryEdge, MemoryRecord, MemoryScope } from '../../src/memory/index.ts'
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

function harness(store = new FakeMemoryStore()) {
  const ctx = new Context()
  const runtime = new MemoryRuntime(ctx, memoryConfig)
  runtime.registerStore(store)
  return { ctx, runtime, store }
}

async function userRecord(runtime: MemoryRuntime, text: string, scope: MemoryScope = workspace): Promise<MemoryRecord> {
  return runtime.remember({
    scope, kind: 'user-message', text, fidelity: 'verbatim',
    provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
  })
}

async function target(runtime: MemoryRuntime, evidence: MemoryRecord, scope: MemoryScope = workspace) {
  return runtime.assert({
    scope, type: 'preference', label: 'pnpm: package manager=pnpm over npm',
    summary: 'Prefers pnpm over npm.', origin: 'asserted', evidence: [evidence.id],
  })
}

/** A store whose first edge write fails once, after the replacement node exists. */
class FailingEdgeStore extends FakeMemoryStore {
  fail = true

  override putEdge(edge: MemoryEdge): Promise<void> {
    if (this.fail) {
      this.fail = false
      return Promise.reject(new Error('edge write failed'))
    }
    return super.putEdge(edge)
  }
}

/** A store whose second node write (the old-node tombstone) fails once. */
class FailingRetireStore extends FakeMemoryStore {
  private writes = 0

  /** Arm the failure after test setup has written the target node. */
  arm(): void {
    this.writes = 0
  }

  override putNode(node: Parameters<FakeMemoryStore['putNode']>[0]): Promise<void> {
    this.writes++
    if (this.writes === 2) return Promise.reject(new Error('retire write failed'))
    return super.putNode(node)
  }
}

describe('explicit replacement', () => {
  it('creates a new identity, retires the old node and writes a supersedes edge', async () => {
    const { runtime, store } = harness()
    const oldEvidence = await userRecord(runtime, 'I prefer pnpm over npm.')
    const old = await target(runtime, oldEvidence)
    const correction = await userRecord(runtime, 'Actually, use yarn instead of pnpm.')

    const result = await runtime.replace({
      scope: workspace,
      target: old.id,
      type: 'preference',
      label: 'pnpm: package manager=pnpm over yarn',
      summary: 'Prefers pnpm over yarn.',
      origin: 'asserted',
      evidence: [correction.id],
      quote: 'use yarn instead of pnpm',
    })

    expect(result.replacement.id).not.toBe(old.id)
    expect(result.replaced).toBe(old.id)
    expect(result.replacement).toMatchObject({ status: 'active', evidence: [correction.id] })
    expect(store.getNode(old.id)).toMatchObject({ status: 'superseded', supersededBy: result.replacement.id })
    expect(store.getNode(old.id)?.evidence).toEqual([oldEvidence.id])
    expect(result.edge).toMatchObject({
      from: result.replacement.id,
      to: old.id,
      relation: 'supersedes',
      origin: 'asserted',
    })
  })

  it('is idempotent when the same request is retried with reordered evidence and attributes', async () => {
    const { runtime, store } = harness()
    const oldEvidence = await userRecord(runtime, 'I prefer pnpm over npm.')
    const old = await target(runtime, oldEvidence)
    const firstCorrection = await userRecord(runtime, 'Actually, use yarn instead of pnpm.')
    const secondCorrection = await userRecord(runtime, 'Use yarn instead of pnpm from now on.')
    const request = {
      scope: workspace,
      target: old.id,
      type: 'preference' as const,
      label: 'pnpm: package manager=pnpm over yarn',
      summary: 'Prefers pnpm over yarn.',
      attributes: { source: 'explicit', priority: 1 },
      origin: 'asserted' as const,
      evidence: [firstCorrection.id, secondCorrection.id],
      quote: 'use yarn instead of pnpm',
    }
    const first = await runtime.replace(request)
    const second = await runtime.replace({
      ...request,
      attributes: { priority: 1, source: 'explicit' },
      evidence: [secondCorrection.id, firstCorrection.id],
    })
    expect(second.replacement.id).toBe(first.replacement.id)
    expect([...store.nodeRows.values()].filter(node => node.status === 'active')).toHaveLength(1)
    expect([...store.edgeRows.values()]).toHaveLength(1)
    expect(store.getNode(old.id)?.supersededBy).toBe(first.replacement.id)
  })

  it('rejects missing, cross-scope, wrong-type, retired targets and bad evidence', async () => {
    const { runtime } = harness()
    const oldEvidence = await userRecord(runtime, 'I prefer pnpm over npm.')
    const old = await target(runtime, oldEvidence)
    const correction = await userRecord(runtime, 'Actually, use yarn instead of pnpm.')
    const userScope = { kind: 'user' as const }
    const other = await runtime.assert({
      scope: userScope, type: 'preference', label: 'other', summary: 'Other.', origin: 'asserted',
    })
    const agentNote = await runtime.remember({
      scope: workspace, kind: 'note', text: 'Actually, use yarn instead of pnpm.', fidelity: 'derived',
      use: 'evidence', provenance: { author: 'agent' },
    })
    const agentAuthored = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'Actually, use yarn instead of pnpm.', fidelity: 'verbatim',
      provenance: { author: 'agent' },
    })
    const legacyNoAuthor = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'Actually, use yarn instead of pnpm.', fidelity: 'verbatim',
    })
    const base = {
      scope: workspace,
      type: 'preference' as const,
      label: 'pnpm: package manager=pnpm over yarn',
      summary: 'Prefers pnpm over yarn.',
      origin: 'asserted' as const,
      evidence: [correction.id],
      quote: 'use yarn instead of pnpm',
    }
    await expect(runtime.replace({ ...base, target: 'mem-n-missing' as never })).rejects.toThrow(/does not exist/)
    await expect(runtime.replace({ ...base, target: old.id, scope: userScope })).rejects.toThrow(/request scope/)
    await expect(runtime.replace({
      ...base, target: old.id, type: 'constraint', label: 'constraint',
    })).rejects.toThrow(/type must match/)
    await expect(runtime.replace({ ...base, target: old.id, quote: 'not in the record' })).rejects.toThrow(/quote/)
    await expect(runtime.replace({ ...base, target: old.id, evidence: [agentNote.id] })).rejects.toThrow(/not user-authored/)
    await expect(runtime.replace({ ...base, target: old.id, evidence: [agentAuthored.id] })).rejects.toThrow(/not user-authored/)
    await expect(runtime.replace({ ...base, target: old.id, evidence: [legacyNoAuthor.id] })).rejects.toThrow(/not user-authored/)
    await expect(runtime.replace({ ...base, target: other.id })).rejects.toThrow(/request scope/)
    await runtime.retract({ kind: 'node', id: old.id })
    await expect(runtime.replace({ ...base, target: old.id })).rejects.toThrow(/retracted/)
  })

  it('leaves the old node active and retries after an edge-write failure', async () => {
    const store = new FailingEdgeStore()
    const { runtime } = harness(store)
    const oldEvidence = await userRecord(runtime, 'I prefer pnpm over npm.')
    const old = await target(runtime, oldEvidence)
    const correction = await userRecord(runtime, 'Actually, use yarn instead of pnpm.')
    const request = {
      scope: workspace,
      target: old.id,
      type: 'preference' as const,
      label: 'pnpm: package manager=pnpm over yarn',
      summary: 'Prefers pnpm over yarn.',
      origin: 'asserted' as const,
      evidence: [correction.id],
      quote: 'use yarn instead of pnpm',
    }
    await expect(runtime.replace(request)).rejects.toThrow('edge write failed')
    expect(store.getNode(old.id)?.status).toBe('active')
    expect(store.edgeRows.size).toBe(0)
    const replacement = [...store.nodeRows.values()].find(node => node.id !== old.id)
    expect(replacement?.status).toBe('active')
    expect(runtime.profile([workspace]).nodes).toHaveLength(2)

    const retried = await runtime.replace(request)
    expect(retried.replacement.id).toBe(replacement?.id)
    expect(store.getNode(old.id)).toMatchObject({ status: 'superseded', supersededBy: retried.replacement.id })
    expect(store.edgeRows.size).toBe(1)
    expect(runtime.profile([workspace]).nodes).toHaveLength(1)
  })

  it('does not duplicate an existing edge when only the old-node retire fails', async () => {
    const store = new FailingRetireStore()
    const { runtime } = harness(store)
    const oldEvidence = await userRecord(runtime, 'I prefer pnpm over npm.')
    const old = await target(runtime, oldEvidence)
    const correction = await userRecord(runtime, 'Actually, use yarn instead of pnpm.')
    store.arm()
    const request = {
      scope: workspace,
      target: old.id,
      type: 'preference' as const,
      label: 'pnpm: package manager=pnpm over yarn',
      summary: 'Prefers pnpm over yarn.',
      origin: 'asserted' as const,
      evidence: [correction.id],
      quote: 'use yarn instead of pnpm',
    }
    await expect(runtime.replace(request)).rejects.toThrow('retire write failed')
    expect(store.getNode(old.id)?.status).toBe('active')
    expect(store.edgeRows.size).toBe(1)
    expect(runtime.profile([workspace]).nodes).toHaveLength(2)
    const edgeBefore = [...store.edgeRows.values()][0]

    const retried = await runtime.replace(request)
    expect(store.edgeRows.size).toBe(1)
    expect([...store.edgeRows.values()][0]?.support.reinforcements).toBe(edgeBefore?.support.reinforcements)
    expect(store.getNode(old.id)).toMatchObject({ status: 'superseded', supersededBy: retried.replacement.id })
    expect(runtime.profile([workspace]).nodes).toHaveLength(1)
  })

  it('rejects a replacement quote that only matched before redaction', async () => {
    const { runtime } = harness()
    const oldEvidence = await userRecord(runtime, 'I prefer pnpm over npm.')
    const old = await target(runtime, oldEvidence)
    const correction = await userRecord(runtime, 'Actually use yarn. secret=abcdef123456')
    await expect(runtime.replace({
      scope: workspace,
      target: old.id,
      type: 'preference',
      label: 'yarn',
      summary: 'Uses yarn.',
      origin: 'asserted',
      evidence: [correction.id],
      quote: 'secret=abcdef123456',
    })).rejects.toThrow(/quote is not present/)
  })

  it('accepts an ordinary quote fragment from a record that also contained a redacted secret', async () => {
    const { runtime } = harness()
    const oldEvidence = await userRecord(runtime, 'I prefer pnpm over npm.')
    const old = await target(runtime, oldEvidence)
    const correction = await userRecord(runtime, 'Use yarn. secret=abcdef123456')
    expect(correction.text).toContain('[redacted:secret-assignment]')

    const result = await runtime.replace({
      scope: workspace,
      target: old.id,
      type: 'preference',
      label: 'pnpm: package manager=pnpm over yarn',
      summary: 'Prefers pnpm over yarn.',
      origin: 'asserted',
      evidence: [correction.id],
      quote: 'Use yarn.',
    })
    expect(result.replacement.status).toBe('active')
  })

  it('rejects a placeholder quote even if the saved text contains that placeholder', async () => {
    const { runtime } = harness()
    const oldEvidence = await userRecord(runtime, 'I prefer pnpm over npm.')
    const old = await target(runtime, oldEvidence)
    const correction = await userRecord(runtime, 'Use yarn. secret=abcdef123456')
    await expect(runtime.replace({
      scope: workspace,
      target: old.id,
      type: 'preference',
      label: 'yarn',
      summary: 'Uses yarn.',
      origin: 'asserted',
      evidence: [correction.id],
      quote: '[redacted:secret-assignment]',
    })).rejects.toThrow(/quote is not present/)
  })

  it('erases the replacement and its edge when the replacement is forgotten', async () => {
    const { runtime, store } = harness()
    const oldEvidence = await userRecord(runtime, 'I prefer pnpm over npm.')
    const old = await target(runtime, oldEvidence)
    const correction = await userRecord(runtime, 'Actually, use yarn instead of pnpm.')
    const result = await runtime.replace({
      scope: workspace,
      target: old.id,
      type: 'preference',
      label: 'pnpm: package manager=pnpm over yarn',
      summary: 'Prefers pnpm over yarn.',
      origin: 'asserted',
      evidence: [correction.id],
      quote: 'use yarn instead of pnpm',
    })
    expect(await runtime.forgetNode(result.replacement.id)).toBe(1)
    expect(store.getNode(result.replacement.id)).toBeUndefined()
    expect(store.edgeRows.size).toBe(0)
    expect(store.getNode(old.id)?.supersededBy).toBeUndefined()
  })
})

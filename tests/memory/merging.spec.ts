import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryRuntime, { similarity } from '../../src/memory/index.ts'
import type {
  Config as MemoryConfig,
  MemoryCandidateNode,
  MemoryDistillation,
  MemoryDistiller,
  MemoryScope,
} from '../../src/memory/index.ts'
import { FakeMemoryStore } from './helpers/fake-store.ts'

const HOUR = 3600_000
const workspace: MemoryScope = { kind: 'workspace', workspace: '/repo' }

/** The shipped values for the three knobs under test; overridden per case. */
const base = {
  recallLimit: 8,
  profileLimit: 10,
  inferredConfidence: 0.4,
  assertedConfidence: 0.9,
  inferredHalfLifeMs: 30 * 24 * HOUR,
  assertedHalfLifeMs: 0,
  reinforcementRate: 0.25,
  contradictionRate: 0.5,
  retirementFloor: 0.05,
  activationHops: 2,
  activationFalloff: 0.45,
  recordBudget: 1000,
  supportWeight: 0.15,
  duplicateThreshold: 0.8,
  diversityThreshold: 0.7,
  vectorWeight: 1,
} satisfies MemoryConfig

/** Mount the hub over an in-memory store with the given overrides. */
async function harness(overrides: Partial<MemoryConfig> = {}) {
  const ctx = new Context()
  await ctx.plugin(MemoryRuntime, { ...base, ...overrides })
  ctx.memory.registerStore(new FakeMemoryStore())
  return ctx
}

/**
 * One distiller reading a list the test refills between passes.
 *
 * Mounting a second distiller instead would leave the first mounted too, and
 * both would propose on every later pass — which looks exactly like a merge
 * that failed.
 */
function proposer(): { nodes: MemoryCandidateNode[]; distiller: MemoryDistiller } {
  const nodes: MemoryCandidateNode[] = []
  return {
    nodes,
    distiller: {
      name: 'fixture',
      rank: 1,
      distill: (): Promise<MemoryDistillation> => Promise.resolve({ nodes: [...nodes], edges: [] }),
    },
  }
}

describe('similarity', () => {
  it('ignores case and word order, because a restatement is still a restatement', () => {
    expect(similarity('pnpm over npm', 'NPM over PNPM')).toBe(1)
  })

  it('separates claims that share only common words', () => {
    expect(similarity('prefers pnpm', 'prefers vitest')).toBeLessThan(0.5)
  })

  it('measures Chinese through the same character bigrams the index uses', () => {
    expect(similarity('喜欢用简短的提交信息', '喜欢用简短的提交信息')).toBe(1)
    expect(similarity('喜欢简短的提交信息', '讨厌冗长的会议')).toBeLessThan(0.3)
  })

  it('reports no overlap rather than dividing by zero on empty text', () => {
    expect(similarity('', 'anything')).toBe(0)
  })
})

describe('merging near-duplicate beliefs', () => {
  it('reinforces the belief already held instead of adding a synonym beside it', async () => {
    const ctx = await harness()
    const { nodes, distiller } = proposer()
    ctx.memory.registerDistiller(distiller)

    const record = await ctx.memory.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm', fidelity: 'verbatim',
    })
    nodes.push({
      type: 'preference', label: 'pnpm over npm', summary: 'Installs with pnpm.',
      confidence: 0.5, evidence: [record.id],
    })
    const first = await ctx.memory.consolidate(workspace)
    expect(first.nodesCreated).toBe(1)

    const second = await ctx.memory.remember({
      scope: workspace, kind: 'user-message', text: 'still prefer pnpm over npm here', fidelity: 'verbatim',
    })
    nodes.length = 0
    nodes.push({
      // A different wording of the same claim.
      type: 'preference', label: 'over npm pnpm', summary: 'Prefers pnpm to npm.',
      confidence: 0.5, evidence: [second.id],
    })
    const merged = await ctx.memory.consolidate(workspace)
    expect(merged.nodesCreated).toBe(0)
    expect(merged.nodesReinforced).toBe(1)
    expect(ctx.memory.profile([workspace]).nodes).toHaveLength(1)
  })

  it('counts the merge as support, so repetition is visible rather than lost', async () => {
    const ctx = await harness()
    const { nodes, distiller } = proposer()
    ctx.memory.registerDistiller(distiller)
    for (const text of ['I prefer pnpm over npm', 'again, pnpm over npm']) {
      const record = await ctx.memory.remember({ scope: workspace, kind: 'user-message', text, fidelity: 'verbatim' })
      nodes.length = 0
      nodes.push({
        type: 'preference', label: 'pnpm over npm', summary: text, confidence: 0.5, evidence: [record.id],
      })
      await ctx.memory.consolidate(workspace)
    }
    const node = ctx.memory.profile([workspace]).nodes[0]
    expect(node?.support.reinforcements).toBe(1)
    expect(node?.evidence).toHaveLength(2)
  })

  it('never merges across subject classes, however alike the labels read', async () => {
    const ctx = await harness()
    const record = await ctx.memory.remember({
      scope: workspace, kind: 'user-message', text: 'about npm', fidelity: 'verbatim',
    })
    const { nodes, distiller } = proposer()
    nodes.push(
      { type: 'preference', label: 'npm usage', summary: 'Prefers it.', confidence: 0.5, evidence: [record.id] },
      { type: 'constraint', label: 'npm usage', summary: 'Never use it.', confidence: 0.5, evidence: [record.id] },
    )
    ctx.memory.registerDistiller(distiller)
    await ctx.memory.consolidate(workspace)
    expect(ctx.memory.profile([workspace]).nodes).toHaveLength(2)
  })

  it('leaves an explicit assertion on exact-label semantics, so forget stays predictable', async () => {
    const ctx = await harness()
    await ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'pnpm over npm', summary: 'One.', origin: 'asserted',
    })
    await ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'over npm pnpm', summary: 'Two.', origin: 'asserted',
    })
    expect(ctx.memory.profile([workspace]).nodes).toHaveLength(2)
  })

  it('adds the belief beside the others when merging is switched off', async () => {
    const ctx = await harness({ duplicateThreshold: 1 })
    const { nodes, distiller } = proposer()
    ctx.memory.registerDistiller(distiller)
    for (const [label, text] of [['pnpm over npm', 'a'], ['over npm pnpm', 'b']] as const) {
      const record = await ctx.memory.remember({ scope: workspace, kind: 'user-message', text, fidelity: 'verbatim' })
      nodes.length = 0
      nodes.push({ type: 'preference', label, summary: text, confidence: 0.5, evidence: [record.id] })
      await ctx.memory.consolidate(workspace)
    }
    expect(ctx.memory.profile([workspace]).nodes).toHaveLength(2)
  })
})

describe('support weighting in recall', () => {
  it('puts the belief seen many times above the one seen once', async () => {
    const ctx = await harness()
    const seen = await ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'pnpm install', summary: 'Installs with pnpm.', origin: 'inferred',
    })
    await ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'pnpm workspace', summary: 'Installs with pnpm.', origin: 'inferred',
    })
    // Ten more sightings of the first belief, and none of the second.
    for (let index = 0; index < 10; index += 1) await ctx.memory.reinforce({ kind: 'node', id: seen.id })

    const recall = await ctx.memory.recall({ text: 'pnpm install', scopes: [workspace] })
    const first = recall.cues[0]
    expect(first?.kind).toBe('node')
    expect(first?.kind === 'node' && first.node.id).toBe(seen.id)
  })

  it('contributes nothing when the weight is zero', async () => {
    // Reinforcement raises confidence as well as support, so the same fixture is
    // built twice and the two scores compared: everything but the multiplier is
    // identical, which makes the difference the multiplier itself.
    const scoreUnder = async (supportWeight: number): Promise<number> => {
      const ctx = await harness({ supportWeight })
      const node = await ctx.memory.assert({
        scope: workspace, type: 'preference', label: 'pnpm', summary: 'Installs with pnpm.', origin: 'inferred',
      })
      for (let index = 0; index < 10; index += 1) await ctx.memory.reinforce({ kind: 'node', id: node.id })
      return (await ctx.memory.recall({ text: 'pnpm', scopes: [workspace] })).cues[0]?.score ?? 0
    }
    const off = await scoreUnder(0)
    const on = await scoreUnder(0.15)
    expect(on).toBeGreaterThan(off)
    // Ten reinforcements and no cited evidence, so support totals ten.
    expect(on / off).toBeCloseTo(1 + 0.15 * Math.log1p(10), 5)
  })
})

describe('diversity in recall', () => {
  /** Assert a family of near-identical beliefs plus one distinct outlier. */
  async function crowded(overrides: Partial<MemoryConfig> = {}) {
    const ctx = await harness(overrides)
    for (let index = 0; index < 8; index += 1) {
      await ctx.memory.assert({
        scope: workspace,
        type: 'tool-affinity',
        label: `edit run ${index}`,
        summary: 'edit is habitually followed by bash.',
        origin: 'inferred',
      })
    }
    await ctx.memory.assert({
      scope: workspace,
      type: 'preference',
      label: 'edit review',
      summary: 'Wants every edit reviewed before it lands.',
      origin: 'inferred',
    })
    return ctx
  }

  it('refuses to spend the whole budget on restatements of one claim', async () => {
    const ctx = await crowded()
    const recall = await ctx.memory.recall({ text: 'edit', scopes: [workspace], limit: 4 })
    const summaries = recall.cues.map(cue => (cue.kind === 'node' ? cue.node.summary : ''))
    expect(new Set(summaries).size).toBeGreaterThan(1)
    expect(summaries).toContain('Wants every edit reviewed before it lands.')
  })

  it('fills the budget with distinct material rather than returning short', async () => {
    const ctx = await harness()
    for (const [label, summary] of [
      ['a', 'The deployment runs on Kubernetes.'],
      ['b', 'The deployment runs on Kubernetes.'],
      ['c', 'Tests are run with vitest.'],
      ['d', 'Commits are signed.'],
    ] as const) {
      await ctx.memory.assert({ scope: workspace, type: 'entity', label, summary, origin: 'inferred' })
    }
    const recall = await ctx.memory.recall({ text: 'deployment kubernetes vitest signed', scopes: [workspace], limit: 3 })
    expect(recall.cues).toHaveLength(3)
  })

  it('returns a pure score ordering when the filter is switched off', async () => {
    const ctx = await crowded({ diversityThreshold: 1 })
    const recall = await ctx.memory.recall({ text: 'edit', scopes: [workspace], limit: 4 })
    const summaries = new Set(recall.cues.map(cue => (cue.kind === 'node' ? cue.node.summary : '')))
    expect(summaries.size).toBe(1)
  })

  it('reports truncation against what was actually returned', async () => {
    const ctx = await crowded()
    const recall = await ctx.memory.recall({ text: 'edit', scopes: [workspace], limit: 2 })
    expect(recall.cues).toHaveLength(2)
    expect(recall.truncated).toBe(true)
  })
})

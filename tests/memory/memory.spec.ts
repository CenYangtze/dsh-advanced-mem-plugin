import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryRuntime, { memoryScopeKey } from '../../src/memory/index.ts'
import type {
  Config,
  MemoryDistillation,
  MemoryDistiller,
  MemoryEmbedder,
  MemoryNode,
  MemoryScope,
} from '../../src/memory/index.ts'
import { FakeMemoryStore } from './helpers/fake-store.ts'

const HOUR = 3600_000

const baseConfig: Config = {
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
}

const workspace: MemoryScope = { kind: 'workspace', workspace: '/repo' }

/** A mounted runtime over a fake store, with optional providers. */
function harness(overrides?: Partial<Config>) {
  const ctx = new Context()
  const runtime = new MemoryRuntime(ctx, { ...baseConfig, ...overrides })
  const store = new FakeMemoryStore()
  runtime.registerStore(store)
  return { ctx, runtime, store }
}

/** An embedder that projects text onto one axis per keyword, for deterministic vector recall. */
const keywordEmbedder: MemoryEmbedder = {
  name: 'keyword',
  dimensions: 3,
  embed: texts => Promise.resolve(texts.map((text) => {
    const lower = text.toLowerCase()
    return [
      lower.includes('deploy') ? 1 : 0,
      lower.includes('test') ? 1 : 0,
      lower.includes('lint') ? 1 : 0,
    ]
  })),
}

describe('provider registration', () => {
  it('refuses a second store rather than silently switching media', () => {
    const { runtime, store } = harness()
    expect(() => runtime.registerStore(store)).toThrow(/already mounted/)
  })

  it('frees the slot when the registration disposes', () => {
    const ctx = new Context()
    const runtime = new MemoryRuntime(ctx, baseConfig)
    const dispose = runtime.registerStore(new FakeMemoryStore())
    expect(runtime.ready).toBe(true)
    dispose()
    expect(runtime.ready).toBe(false)
    expect(() => runtime.store).toThrow(/no memory store is mounted/)
  })

  it('refuses a second embedder', () => {
    const { runtime } = harness()
    runtime.registerEmbedder(keywordEmbedder)
    expect(() => runtime.registerEmbedder(keywordEmbedder)).toThrow(/already mounted/)
  })
})

describe('remember', () => {
  it('indexes terms and keeps attachment locators without copying bytes', async () => {
    const { runtime } = harness()
    const record = await runtime.remember({
      scope: workspace,
      kind: 'user-message',
      text: 'always run the linter before pushing',
      fidelity: 'verbatim',
      attachments: [{ kind: 'image', uri: 'attachment:img-1', mediaType: 'image/png', caption: 'lint output' }],
    })
    expect(record.terms).toContain('linter')
    expect(record.terms).toContain('output')
    expect(record.attachments[0]?.uri).toBe('attachment:img-1')
    expect(record.scope).toBe('workspace:/repo')
  })

  it('rejects blank observations instead of storing an unretrievable record', async () => {
    const { runtime } = harness()
    await expect(runtime.remember({
      scope: workspace, kind: 'note', text: '   ', fidelity: 'verbatim',
    })).rejects.toThrow(/non-empty text/)
  })

  it('embeds at capture time so recall never backfills on the request path', async () => {
    const { runtime } = harness()
    runtime.registerEmbedder(keywordEmbedder)
    const record = await runtime.remember({
      scope: workspace, kind: 'note', text: 'deploy checklist', fidelity: 'verbatim',
    })
    expect(record.embedding).toEqual({ model: 'keyword', dimensions: 3, vector: [1, 0, 0] })
  })
})

describe('assert', () => {
  it('reinforces an existing label rather than duplicating it', async () => {
    const { runtime, store } = harness()
    const first = await runtime.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Uses pnpm.', origin: 'inferred',
    })
    const second = await runtime.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Uses pnpm everywhere.', origin: 'inferred',
    })
    expect(second.id).toBe(first.id)
    expect(second.confidence).toBeGreaterThan(first.confidence)
    expect(second.summary).toBe('Uses pnpm everywhere.')
    expect(store.nodeRows.size).toBe(1)
  })

  it('upgrades an inferred belief to asserted when the user confirms it, so it stops fading', async () => {
    const { runtime } = harness()
    await runtime.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Uses pnpm.', origin: 'inferred',
    })
    const confirmed = await runtime.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Uses pnpm.', origin: 'asserted',
    })
    expect(confirmed.origin).toBe('asserted')
    expect(confirmed.decay.halfLifeMs).toBeNull()
  })

  it('rejects a blank label or summary', async () => {
    const { runtime } = harness()
    await expect(runtime.assert({
      scope: workspace, type: 'preference', label: ' ', summary: 'x', origin: 'inferred',
    })).rejects.toThrow(/non-empty label and summary/)
  })
})

describe('relate', () => {
  it('rejects an endpoint that does not exist', async () => {
    const { runtime } = harness()
    const node = await runtime.assert({
      scope: workspace, type: 'project', label: 'harness', summary: 'The harness repo.', origin: 'asserted',
    })
    await expect(runtime.relate({
      scope: workspace,
      from: node.id,
      to: node.id.replace('mem-n-', 'mem-n-missing-') as MemoryNode['id'],
      relation: 'part-of',
      claim: 'x',
      origin: 'inferred',
    })).rejects.toThrow(/does not exist/)
  })

  it('reinforces a repeated conclusion between the same endpoints', async () => {
    const { runtime, store } = harness()
    const from = await runtime.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Uses pnpm.', origin: 'inferred',
    })
    const to = await runtime.assert({
      scope: workspace, type: 'project', label: 'harness', summary: 'The repo.', origin: 'inferred',
    })
    const first = await runtime.relate({
      scope: workspace, from: from.id, to: to.id, relation: 'uses', claim: 'pnpm is used in harness.', origin: 'inferred',
    })
    const second = await runtime.relate({
      scope: workspace, from: from.id, to: to.id, relation: 'uses', claim: 'pnpm is used in harness.', origin: 'inferred',
    })
    expect(second.id).toBe(first.id)
    expect(store.edgeRows.size).toBe(1)
    expect(second.support.reinforcements).toBe(1)
  })
})

describe('recall', () => {
  it('surfaces the belief whose summary matches the cue', async () => {
    const { runtime } = harness()
    await runtime.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Installs dependencies with pnpm.', origin: 'asserted',
    })
    await runtime.assert({
      scope: workspace, type: 'preference', label: 'vitest', summary: 'Runs tests with vitest.', origin: 'asserted',
    })
    const recall = await runtime.recall({ text: 'how are dependencies installed', scopes: [workspace] })
    const first = recall.cues[0]
    expect(first?.kind).toBe('node')
    expect(first?.kind === 'node' && first.node.label).toBe('pnpm')
  })

  it('spreads activation so a belief linked to a match is recalled with it', async () => {
    const { runtime } = harness()
    const matched = await runtime.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Installs with pnpm.', origin: 'asserted',
    })
    const neighbour = await runtime.assert({
      scope: workspace, type: 'routine', label: 'bootstrap', summary: 'Bootstraps a clone.', origin: 'asserted',
    })
    await runtime.relate({
      scope: workspace,
      from: matched.id,
      to: neighbour.id,
      relation: 'part-of',
      claim: 'Installing is part of bootstrapping.',
      origin: 'inferred',
    })
    const recall = await runtime.recall({ text: 'pnpm', scopes: [workspace] })
    const labels = recall.cues.flatMap(cue => cue.kind === 'node' ? [cue.node.label] : [])
    expect(labels).toContain('pnpm')
    expect(labels).toContain('bootstrap')
  })

  it('applies decay before filtering, so a faded belief drops out with no expiry pass', async () => {
    const { runtime } = harness()
    const at = 0
    await runtime.assert({
      scope: workspace, type: 'preference', label: 'jest', summary: 'Runs tests with jest.', origin: 'inferred', at,
    })
    const fresh = await runtime.recall({ text: 'tests', scopes: [workspace], now: at, minConfidence: 0.3 })
    expect(fresh.cues.length).toBeGreaterThan(0)
    const stale = await runtime.recall({
      text: 'tests', scopes: [workspace], now: at + 365 * 24 * HOUR, minConfidence: 0.3,
    })
    expect(stale.cues.filter(cue => cue.kind === 'node')).toEqual([])
  })

  it('reads only the scopes it was given', async () => {
    const { runtime } = harness()
    await runtime.assert({
      scope: { kind: 'user' }, type: 'preference', label: 'dark-mode', summary: 'Prefers dark mode.', origin: 'asserted',
    })
    const scoped = await runtime.recall({ text: 'dark mode', scopes: [workspace] })
    expect(scoped.cues).toEqual([])
    const global = await runtime.recall({ text: 'dark mode', scopes: [{ kind: 'user' }] })
    expect(global.cues.length).toBeGreaterThan(0)
  })

  it('reports whether a vector signal participated', async () => {
    const { runtime } = harness()
    await runtime.remember({ scope: workspace, kind: 'note', text: 'deploy on friday', fidelity: 'verbatim' })
    expect((await runtime.recall({ text: 'deploy', scopes: [workspace] })).semantic).toBe(false)

    const semantic = harness()
    semantic.runtime.registerEmbedder(keywordEmbedder)
    await semantic.runtime.remember({ scope: workspace, kind: 'note', text: 'deploy on friday', fidelity: 'verbatim' })
    expect((await semantic.runtime.recall({ text: 'deploy', scopes: [workspace] })).semantic).toBe(true)
  })

  it('honors the fidelity floor so derived material cannot drive a strict consumer', async () => {
    const { runtime } = harness()
    await runtime.remember({ scope: workspace, kind: 'tool-invocation', text: 'bash rm -rf', fidelity: 'derived' })
    const strict = await runtime.recall({ text: 'bash', scopes: [workspace], minFidelity: 'verbatim' })
    expect(strict.cues).toEqual([])
    const loose = await runtime.recall({ text: 'bash', scopes: [workspace], minFidelity: 'derived' })
    expect(loose.cues.length).toBeGreaterThan(0)
  })

  it('reports truncation rather than silently dropping matches', async () => {
    const { runtime } = harness()
    for (let index = 0; index < 5; index++) {
      await runtime.remember({ scope: workspace, kind: 'note', text: `deploy step ${index}`, fidelity: 'verbatim' })
    }
    const recall = await runtime.recall({ text: 'deploy', scopes: [workspace], limit: 2 })
    expect(recall.cues).toHaveLength(2)
    expect(recall.truncated).toBe(true)
  })

  it('emits the answer with the request that produced it', async () => {
    const { ctx, runtime } = harness()
    const seen: string[] = []
    ctx.on('memory/recalled', (_recall, query) => { seen.push(query.text) })
    await runtime.recall({ text: 'anything', scopes: [workspace] })
    expect(seen).toEqual(['anything'])
  })
})

describe('profile', () => {
  it('ranks well-supported beliefs above single confident guesses', async () => {
    const { runtime } = harness()
    await runtime.assert({
      scope: workspace, type: 'preference', label: 'guess', summary: 'A one-off guess.', origin: 'inferred', confidence: 0.6,
    })
    for (let index = 0; index < 5; index++) {
      await runtime.assert({
        scope: workspace, type: 'preference', label: 'habit', summary: 'A repeated habit.', origin: 'inferred', confidence: 0.5,
      })
    }
    const profile = runtime.profile([workspace])
    expect(profile.nodes[0]?.label).toBe('habit')
    expect(profile.total).toBe(2)
  })

  it('carries only edges whose endpoints it also carries', async () => {
    const { runtime } = harness()
    const from = await runtime.assert({
      scope: workspace, type: 'preference', label: 'a', summary: 'A.', origin: 'asserted',
    })
    const to = await runtime.assert({
      scope: workspace, type: 'preference', label: 'b', summary: 'B.', origin: 'asserted',
    })
    await runtime.relate({
      scope: workspace, from: from.id, to: to.id, relation: 'part-of', claim: 'A is part of B.', origin: 'inferred',
    })
    expect(runtime.profile([workspace], { limit: 1 }).edges).toEqual([])
    expect(runtime.profile([workspace], { limit: 2 }).edges).toHaveLength(1)
  })
})

describe('belief maintenance', () => {
  it('reinforcing raises the belief and resets the decay clock', async () => {
    const { runtime } = harness()
    const node = await runtime.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Uses pnpm.', origin: 'inferred', at: 0,
    })
    await runtime.reinforce({ kind: 'node', id: node.id }, 5_000)
    const updated = runtime.store.getNode(node.id)
    expect(updated?.confidence).toBeGreaterThan(node.confidence)
    expect(updated?.support.lastSeenAt).toBe(5_000)
  })

  it('contradicting lowers the belief and counts the disagreement', async () => {
    const { runtime } = harness()
    const node = await runtime.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Uses pnpm.', origin: 'asserted',
    })
    await runtime.contradict({ kind: 'node', id: node.id })
    const updated = runtime.store.getNode(node.id)
    expect(updated?.confidence).toBeLessThan(node.confidence)
    expect(updated?.support.contradictions).toBe(1)
  })

  it('rejects adjusting a layer-0 record, which carries no belief', async () => {
    const { runtime } = harness()
    const record = await runtime.remember({
      scope: workspace, kind: 'note', text: 'note', fidelity: 'verbatim',
    })
    await expect(runtime.reinforce({ kind: 'record', id: record.id })).rejects.toThrow(/carry no belief/)
  })

  it('refuses to reinforce a retracted belief', async () => {
    const { runtime } = harness()
    const node = await runtime.assert({
      scope: workspace, type: 'preference', label: 'wrong', summary: 'Mistaken.', origin: 'inferred',
    })
    await runtime.retract({ kind: 'node', id: node.id })
    await expect(runtime.reinforce({ kind: 'node', id: node.id })).rejects.toThrow(/retracted/)
  })

  it('retraction keeps the item auditable but out of recall', async () => {
    const { runtime } = harness()
    const node = await runtime.assert({
      scope: workspace, type: 'preference', label: 'mistaken', summary: 'Believes something false.', origin: 'inferred',
    })
    await runtime.retract({ kind: 'node', id: node.id })
    expect(runtime.store.getNode(node.id)?.status).toBe('retracted')
    const recall = await runtime.recall({ text: 'false', scopes: [workspace] })
    expect(recall.cues).toEqual([])
  })

  it('supersession records why the belief changed, not only what replaced it', async () => {
    const { runtime } = harness()
    const outdated = await runtime.assert({
      scope: workspace, type: 'preference', label: 'npm', summary: 'Used npm.', origin: 'inferred',
    })
    const replacement = await runtime.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Now uses pnpm.', origin: 'asserted',
    })
    await runtime.supersede(outdated.id, replacement.id)
    expect(runtime.store.getNode(outdated.id)?.status).toBe('superseded')
    expect(runtime.store.getNode(outdated.id)?.supersededBy).toBe(replacement.id)
    const supersedes = [...runtime.store.edges([memoryScopeKey({ kind: 'user' })])]
      .filter(edge => edge.relation === 'supersedes')
    expect(supersedes).toHaveLength(1)
  })

  it('forgetting erases the record and drops every citation of it', async () => {
    const { runtime } = harness()
    const record = await runtime.remember({
      scope: workspace, kind: 'user-message', text: 'private detail', fidelity: 'verbatim',
    })
    const node = await runtime.assert({
      scope: workspace,
      type: 'preference',
      label: 'derived',
      summary: 'Drawn from that detail.',
      origin: 'inferred',
      evidence: [record.id],
    })
    expect(await runtime.forget(record.id)).toBe(true)
    expect(runtime.store.getRecord(record.id)).toBeUndefined()
    expect(runtime.store.getNode(node.id)?.evidence).toEqual([])
    expect(await runtime.forget(record.id)).toBe(false)
  })
})

describe('sweep', () => {
  it('retires a faded inference but never a stated fact', async () => {
    const { runtime } = harness()
    const inferred = await runtime.assert({
      scope: workspace, type: 'preference', label: 'guess', summary: 'A guess.', origin: 'inferred', at: 0,
    })
    const stated = await runtime.assert({
      scope: workspace, type: 'preference', label: 'stated', summary: 'Said outright.', origin: 'asserted', at: 0,
    })
    const report = await runtime.sweep([workspace], 365 * 24 * HOUR)
    expect(report.retired).toBe(1)
    expect(runtime.store.getNode(inferred.id)?.status).toBe('superseded')
    expect(runtime.store.getNode(stated.id)?.status).toBe('active')
  })

  it('evicts overflowing raw material oldest-first but never orphans a conclusion', async () => {
    const { runtime } = harness({ recordBudget: 2 })
    const cited = await runtime.remember({
      scope: workspace, kind: 'note', text: 'oldest and cited', fidelity: 'verbatim', at: 1,
    })
    await runtime.remember({ scope: workspace, kind: 'note', text: 'second', fidelity: 'verbatim', at: 2 })
    await runtime.remember({ scope: workspace, kind: 'note', text: 'third', fidelity: 'verbatim', at: 3 })
    await runtime.assert({
      scope: workspace,
      type: 'preference',
      label: 'kept',
      summary: 'Stands on the oldest record.',
      origin: 'asserted',
      evidence: [cited.id],
    })
    const report = await runtime.sweep([workspace], 4)
    expect(report.evicted).toBe(1)
    expect(runtime.store.getRecord(cited.id)).toBeDefined()
  })
})

describe('consolidate', () => {
  /** A distiller that proposes one node per record and links them in a chain. */
  const chainDistiller = (proposals: MemoryDistillation): MemoryDistiller => ({
    name: 'test',
    rank: 1,
    distill: () => Promise.resolve(proposals),
  })

  it('merges proposals and marks the records it consumed', async () => {
    const { runtime } = harness()
    const record = await runtime.remember({
      scope: workspace, kind: 'tool-invocation', text: 'bash ls', fidelity: 'derived',
    })
    runtime.registerDistiller(chainDistiller({
      nodes: [{
        type: 'tool-affinity',
        label: 'bash',
        summary: 'Reaches for bash.',
        confidence: 0.5,
        evidence: [record.id],
      }],
      edges: [],
    }))
    const report = await runtime.consolidate(workspace)
    expect(report).toMatchObject({ examined: 1, nodesCreated: 1, nodesReinforced: 0 })
    expect(runtime.store.getRecord(record.id)?.promotedTo).toEqual(['consolidated'])
    // The second pass sees nothing new, which is what keeps repeated passes cheap.
    expect((await runtime.consolidate(workspace)).examined).toBe(0)
  })

  it('reinforces on a second sighting instead of duplicating the belief', async () => {
    const { runtime, store } = harness()
    const first = await runtime.remember({
      scope: workspace, kind: 'tool-invocation', text: 'bash ls', fidelity: 'derived',
    })
    const proposals = (evidence: string): MemoryDistillation => ({
      nodes: [{
        type: 'tool-affinity',
        label: 'bash',
        summary: 'Reaches for bash.',
        confidence: 0.5,
        evidence: [evidence as never],
      }],
      edges: [],
    })
    const dispose = runtime.registerDistiller(chainDistiller(proposals(first.id)))
    await runtime.consolidate(workspace)
    dispose()
    const second = await runtime.remember({
      scope: workspace, kind: 'tool-invocation', text: 'bash pwd', fidelity: 'derived',
    })
    runtime.registerDistiller(chainDistiller(proposals(second.id)))
    const report = await runtime.consolidate(workspace)
    expect(report.nodesCreated).toBe(0)
    expect(report.nodesReinforced).toBe(1)
    expect(store.nodeRows.size).toBe(1)
  })

  it('rejects a proposal that cites no evidence', async () => {
    const { runtime } = harness()
    await runtime.remember({ scope: workspace, kind: 'note', text: 'something', fidelity: 'verbatim' })
    runtime.registerDistiller(chainDistiller({
      nodes: [{ type: 'preference', label: 'baseless', summary: 'No evidence.', confidence: 0.9, evidence: [] }],
      edges: [],
    }))
    await expect(runtime.consolidate(workspace)).rejects.toThrow(/cites no evidence/)
  })

  it('skips an edge naming an endpoint nothing grounds, keeping the rest of the pass', async () => {
    const { runtime } = harness()
    const record = await runtime.remember({
      scope: workspace, kind: 'note', text: 'something', fidelity: 'verbatim',
    })
    runtime.registerDistiller(chainDistiller({
      nodes: [{ type: 'preference', label: 'known', summary: 'Known.', confidence: 0.5, evidence: [record.id] }],
      edges: [{
        from: 'known',
        to: 'never-proposed',
        relation: 'part-of',
        claim: 'Dangling.',
        confidence: 0.5,
        evidence: [record.id],
      }],
    }))
    const report = await runtime.consolidate(workspace)
    expect(report.nodesCreated).toBe(1)
    expect(report.edgesCreated).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import type { MemoryRecord, MemoryRecordId, MemoryScopeKey } from '../../src/memory/index.ts'
import { BehaviorCycleDistiller, actionOf, actionSequences, frequencyConfidence } from '../../src/memory-consolidation/distiller.ts'
import type { DistillerPolicy } from '../../src/memory-consolidation/distiller.ts'

const policy: DistillerPolicy = {
  minObservations: 3,
  observationSaturation: 5,
  maxConfidence: 0.85,
  minSequenceLength: 2,
  maxSequenceLength: 3,
  minSequenceRepeats: 2,
}

let counter = 0

/** Build one layer-0 record with the provenance the miner reads. */
function record(
  overrides: Partial<MemoryRecord> & Pick<MemoryRecord, 'kind'>,
): MemoryRecord {
  return {
    id: `mem-r-${++counter}` as MemoryRecordId,
    scope: 'workspace:/repo' as MemoryScopeKey,
    text: 'text',
    fidelity: 'derived',
    terms: [],
    attachments: [],
    provenance: {},
    createdAt: counter,
    promotedTo: [],
    status: 'active',
    ...overrides,
  }
}

/** A tool invocation in one session and turn. */
function toolCall(tool: string, session: string, turn: number): MemoryRecord {
  return record({ kind: 'tool-invocation', provenance: { tool, sessionId: session as never, turn } })
}

describe('frequencyConfidence', () => {
  it('rises fast at first and never reaches the ceiling', () => {
    const one = frequencyConfidence(1, policy)
    const five = frequencyConfidence(5, policy)
    const fifty = frequencyConfidence(50, policy)
    expect(five - one).toBeGreaterThan(fifty - five)
    expect(fifty).toBeLessThan(policy.maxConfidence)
  })
})

describe('actionOf', () => {
  it('reads the tool from provenance', () => {
    expect(actionOf(toolCall('bash', 's1', 1))).toBe('tool:bash')
  })

  it('falls back to the first line for a skill invocation with no named skill', () => {
    expect(actionOf(record({ kind: 'skill-invocation', text: 'code-review\nbody' }))).toBe('skill:code-review')
  })

  it('prefers the named skill over the text', () => {
    expect(actionOf(record({ kind: 'skill-invocation', text: 'body', provenance: { skill: 'deploy' } })))
      .toBe('skill:deploy')
  })

  it('ignores records that witness no action', () => {
    expect(actionOf(record({ kind: 'user-message', text: 'hello' }))).toBeUndefined()
    expect(actionOf(record({ kind: 'tool-invocation' }))).toBeUndefined()
  })
})

describe('actionSequences', () => {
  it('groups actions per turn and never spans turns', () => {
    const sequences = actionSequences([
      toolCall('bash', 's1', 1),
      toolCall('fs', 's1', 1),
      toolCall('bash', 's1', 2),
    ])
    expect(sequences.map(sequence => sequence.actions)).toEqual([['tool:bash', 'tool:fs'], ['tool:bash']])
  })

  it('keeps sessions apart even at the same turn number', () => {
    const sequences = actionSequences([toolCall('bash', 's1', 1), toolCall('fs', 's2', 1)])
    expect(sequences).toHaveLength(2)
  })
})

describe('BehaviorCycleDistiller', () => {
  const distiller = new BehaviorCycleDistiller(100, policy)
  const scope = 'workspace:/repo' as MemoryScopeKey

  it('proposes an affinity only once a behavior clears the repeat threshold', async () => {
    const twice = await distiller.distill({
      scope,
      records: [toolCall('bash', 's1', 1), toolCall('bash', 's1', 2)],
      existing: [],
    })
    expect(twice.nodes).toEqual([])

    const thrice = await distiller.distill({
      scope,
      records: [toolCall('bash', 's1', 1), toolCall('bash', 's1', 2), toolCall('bash', 's2', 1)],
      existing: [],
    })
    expect(thrice.nodes.map(node => node.label)).toEqual(['bash'])
    expect(thrice.nodes[0]?.type).toBe('tool-affinity')
    expect(thrice.nodes[0]?.attributes).toMatchObject({ uses: 3, sessions: 2 })
  })

  it('separates a tool and a skill that share a name', async () => {
    const distillation = await distiller.distill({
      scope,
      records: [
        ...Array.from({ length: 3 }, (_value, index) => toolCall('review', 's1', index)),
        ...Array.from({ length: 3 }, (_value, index) =>
          record({ kind: 'skill-invocation', provenance: { skill: 'review', sessionId: 's1' as never, turn: index } })),
      ],
      existing: [],
    })
    const affinities = distillation.nodes.filter(node => node.type.endsWith('-affinity'))
    expect(affinities.map(node => node.type).sort()).toEqual(['skill-affinity', 'tool-affinity'])
    expect(affinities.map(node => node.label)).toEqual(['review', 'review'])
  })

  it('mines a repeated within-turn sequence into a procedure', async () => {
    const distillation = await distiller.distill({
      scope,
      records: [
        toolCall('fs', 's1', 1), toolCall('bash', 's1', 1),
        toolCall('fs', 's1', 2), toolCall('bash', 's1', 2),
        toolCall('fs', 's1', 3), toolCall('bash', 's1', 3),
      ],
      existing: [],
    })
    const procedure = distillation.nodes.find(node => node.type === 'procedure')
    expect(procedure?.attributes).toMatchObject({ steps: ['fs', 'bash'], occurrences: 3 })
  })

  it('links each mined step to its procedure and to what habitually follows it', async () => {
    const distillation = await distiller.distill({
      scope,
      records: [
        toolCall('fs', 's1', 1), toolCall('bash', 's1', 1),
        toolCall('fs', 's1', 2), toolCall('bash', 's1', 2),
        toolCall('fs', 's1', 3), toolCall('bash', 's1', 3),
      ],
      existing: [],
    })
    expect(distillation.edges.filter(edge => edge.relation === 'part-of').map(edge => edge.from).sort())
      .toEqual(['bash', 'fs'])
    const cooccurs = distillation.edges.find(edge => edge.relation === 'co-occurs')
    expect(cooccurs).toMatchObject({ from: 'fs', to: 'bash' })
  })

  it('attaches a new routine to an affinity the graph already holds', async () => {
    const distillation = await distiller.distill({
      scope,
      records: [
        toolCall('fs', 's1', 1), toolCall('lsp', 's1', 1),
        toolCall('fs', 's1', 2), toolCall('lsp', 's1', 2),
      ],
      existing: [{
        id: 'mem-n-existing' as never,
        scope,
        type: 'tool-affinity',
        label: 'lsp',
        summary: 'Mined last week.',
        attributes: {},
        confidence: 0.6,
        decay: { halfLifeMs: null },
        support: { observations: 4, reinforcements: 0, contradictions: 0, sessions: 1, firstSeenAt: 0, lastSeenAt: 0 },
        evidence: [],
        origin: 'inferred',
        status: 'active',
        createdAt: 0,
        updatedAt: 0,
      }],
    })
    // `fs` was seen twice, below the affinity threshold, so it grounds no
    // endpoint this pass; `lsp` resolves because the graph already holds it.
    expect(distillation.edges.filter(edge => edge.relation === 'part-of').map(edge => edge.from))
      .toEqual(['lsp'])
  })

  it('proposes nothing from material that witnesses no action', async () => {
    const distillation = await distiller.distill({
      scope,
      records: [record({ kind: 'user-message', text: 'hello' })],
      existing: [],
    })
    expect(distillation).toEqual({ nodes: [], edges: [] })
  })
})

import { describe, expect, it } from 'vitest'
import type { MemoryRecord, MemoryRecordId, MemoryScopeKey } from '../../src/memory/index.ts'
import { StatedPreferenceDistiller, claimsIn, statable } from '../../src/memory-consolidation/stated.ts'
import type { StatedPolicy } from '../../src/memory-consolidation/stated.ts'

const policy: StatedPolicy = {
  minObservations: 3,
  observationSaturation: 5,
  maxConfidence: 0.85,
  minSequenceLength: 2,
  maxSequenceLength: 3,
  minSequenceRepeats: 2,
  minStatements: 1,
  minSubjectLength: 3,
  maxSubjectLength: 60,
}

let counter = 0
const scope = 'workspace:/repo' as MemoryScopeKey

/** One layer-0 record; a user message unless told otherwise. */
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
    provenance: { sessionId: 's1' as never, turn: 1 },
    createdAt: counter,
    promotedTo: [],
    status: 'active',
    ...overrides,
  }
}

describe('claimsIn', () => {
  it('reads a stated preference and keeps its subject', () => {
    expect(claimsIn('I prefer pnpm over npm.', policy)).toEqual([
      { type: 'preference', subject: 'pnpm over npm', sentence: 'I prefer pnpm over npm' },
    ])
  })

  it('reads a stated constraint', () => {
    const claims = claimsIn('Never force-push a shared branch.', policy)
    expect(claims[0]).toMatchObject({ type: 'constraint', subject: 'force-push a shared branch' })
  })

  it('reads Chinese statements in both moods', () => {
    expect(claimsIn('我喜欢用简短的提交信息', policy)[0]).toMatchObject({ type: 'preference' })
    expect(claimsIn('不要修改生产配置', policy)[0]).toMatchObject({ type: 'constraint' })
  })

  it('takes a complaint for what it is, not for a rule', () => {
    // A bare `never` reports the world; only an instruction carries a verb phrase
    // the pattern can bind, which is what keeps "I never got it" out of memory.
    expect(claimsIn('I never got the email.', policy)).toEqual([])
  })

  it('finds one claim per sentence and never two from the same one', () => {
    const claims = claimsIn('I prefer tabs. Never use spaces.', policy)
    expect(claims.map(claim => claim.type)).toEqual(['preference', 'constraint'])
  })

  it('rejects a subject too short to identify anything', () => {
    expect(claimsIn('I prefer it.', policy)).toEqual([])
  })

  it('truncates a run-on subject rather than making it the label', () => {
    const long = `I prefer ${'x'.repeat(200)}`
    expect(claimsIn(long, policy)[0]?.subject.length).toBe(policy.maxSubjectLength)
  })

  it('normalises case so the same preference stated twice merges', () => {
    const first = claimsIn('I prefer PNPM over npm.', policy)[0]?.subject
    const second = claimsIn('i prefer pnpm over NPM.', policy)[0]?.subject
    expect(first).toBe(second)
  })
})

describe('statable', () => {
  it('admits what the user wrote and refuses what the harness produced', () => {
    expect(statable(record('hello'))).toBe(true)
    expect(statable(record('a note', { kind: 'note' }))).toBe(true)
    expect(statable(record('I prefer bash', { kind: 'assistant-message', use: 'evidence' }))).toBe(false)
    expect(statable(record('bash — ls', { kind: 'tool-invocation', use: 'evidence' }))).toBe(false)
  })
})

describe('StatedPreferenceDistiller', () => {
  const distiller = new StatedPreferenceDistiller(110, policy)

  it('turns a stated preference into a belief in the user own words', async () => {
    const distillation = await distiller.distill({
      scope, records: [record('I prefer pnpm over npm.')], existing: [],
    })
    expect(distillation.nodes).toHaveLength(1)
    expect(distillation.nodes[0]).toMatchObject({
      type: 'preference',
      label: 'pnpm over npm',
      summary: 'I prefer pnpm over npm',
    })
    expect(distillation.edges).toEqual([])
  })

  it('cites the records the belief came from, so it can be audited', async () => {
    const source = record('Never force-push a shared branch.')
    const distillation = await distiller.distill({ scope, records: [source], existing: [] })
    expect(distillation.nodes[0]?.evidence).toEqual([source.id])
  })

  it('refuses to learn a preference the assistant stated about itself', async () => {
    const distillation = await distiller.distill({
      scope,
      records: [record('I prefer pnpm over npm.', { kind: 'assistant-message', use: 'evidence' })],
      existing: [],
    })
    expect(distillation.nodes).toEqual([])
  })

  it('ignores a tool call even when its arguments read like a sentence', async () => {
    const distillation = await distiller.distill({
      scope,
      records: [record('bash — I prefer pnpm over npm', { kind: 'tool-invocation', use: 'evidence' })],
      existing: [],
    })
    expect(distillation.nodes).toEqual([])
  })

  it('strengthens rather than duplicating when the same thing is said twice', async () => {
    const distillation = await distiller.distill({
      scope,
      records: [record('I prefer pnpm over npm.'), record('I prefer pnpm over npm!')],
      existing: [],
    })
    expect(distillation.nodes).toHaveLength(1)
    expect(distillation.nodes[0]?.attributes).toMatchObject({ statements: 2 })
  })

  it('holds a statement back until it clears the configured threshold', async () => {
    const strict = new StatedPreferenceDistiller(110, { ...policy, minStatements: 2 })
    const once = await strict.distill({ scope, records: [record('I prefer pnpm over npm.')], existing: [] })
    expect(once.nodes).toEqual([])
  })

  it('never claims certainty, however often something is repeated', async () => {
    const many = Array.from({ length: 50 }, () => record('I prefer pnpm over npm.'))
    const distillation = await distiller.distill({ scope, records: many, existing: [] })
    expect(distillation.nodes[0]?.confidence).toBeLessThan(policy.maxConfidence)
  })

  it('counts the sessions a belief spans, so a one-session habit stays weaker', async () => {
    const distillation = await distiller.distill({
      scope,
      records: [
        record('I prefer pnpm over npm.'),
        record('I prefer pnpm over npm.', { provenance: { sessionId: 's2' as never, turn: 1 } }),
      ],
      existing: [],
    })
    expect(distillation.nodes[0]?.attributes).toMatchObject({ sessions: 2 })
  })

  it('proposes nothing from ordinary conversation', async () => {
    const distillation = await distiller.distill({
      scope,
      records: [record('Can you look at the failing test in the parser?')],
      existing: [],
    })
    expect(distillation.nodes).toEqual([])
  })
})
